/**
 * 上传后脚本：把本地脚本传到目标的临时目录并执行，用**退出码**判定是否真正成功。
 *
 * 语义（与产品约定一致）：
 * - 只对 `sftp` / `local` 生效；FTP 系列没有 exec 能力，返回 `skipped` 并说明原因；
 * - 远端路径是**内容寻址**的（`/tmp/shipit-scripts/<name>-<sha256 前12位><ext>`）：
 *   远端已存在同尺寸文件即跳过上传（同名 ⇒ 同内容），避免每次发布重复传输；
 * - 执行结果（退出码 / stdout / stderr）随任务结果返回，日志据此区分"脚本跑对没跑对"；
 * - 脚本失败**不改变已上传文件的成功状态**，只体现在 `postUpload.status` 上。
 */
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { promises as fsp, existsSync } from 'fs'
import { basename, extname } from 'path'
import type { DeployTarget, PostUploadScriptResult } from '../../shared/types'

/** 远端临时目录（固定，可预测，便于清理） */
export const REMOTE_SCRIPT_DIR = '/tmp/shipit-scripts'
export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000
const MAX_CAPTURE = 4096

/** 内容寻址的远端文件名：同名即同内容，尺寸一致就不必重传 */
export function scriptRemotePath(localPath: string, sha256: string): string {
  const ext = extname(localPath)
  const base = basename(localPath, ext).replace(/[^A-Za-z0-9._-]/g, '_')
  return `${REMOTE_SCRIPT_DIR}/${base}-${sha256.slice(0, 12)}${ext.replace(/[^A-Za-z0-9.]/g, '')}`
}

/** 远端已存在且尺寸一致 → 跳过上传 */
export function shouldUploadScript(remoteSize: number | null, localSize: number): boolean {
  return remoteSize === null || remoteSize !== localSize
}

function truncate(text: string): string {
  return text.length > MAX_CAPTURE ? `${text.slice(0, MAX_CAPTURE)}\n…（已截断）` : text
}

/** shell 单引号转义（路径里可能有空格/中文） */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface RunScriptOptions {
  target: DeployTarget
  /** sftp 会话（local 协议不需要） */
  sftpClient?: { put: (l: string, r: string) => Promise<unknown>; stat: (r: string) => Promise<{ size?: number } | undefined>; mkdir: (r: string, recursive?: boolean) => Promise<unknown>; chmod?: (r: string, mode: number) => Promise<unknown>; client?: unknown } | null
  isLocal: boolean
  timeoutMs?: number
}

/** 读取配置（兼容旧的 postUploadScript 字段） */
export function postUploadOf(target: DeployTarget): { kind: 'script' | 'command'; value: string } | null {
  const current = target.postUpload
  if (current && current.value.trim()) return { kind: current.kind, value: current.value.trim() }
  const legacy = target.postUploadScript?.trim()
  return legacy ? { kind: 'script', value: legacy } : null
}

export async function runPostUploadScript(options: RunScriptOptions): Promise<PostUploadScriptResult> {
  const startedAt = Date.now()
  const config = postUploadOf(options.target)
  const scriptPath = config?.value ?? ''
  const base: PostUploadScriptResult = {
    kind: config?.kind,
    status: 'failed',
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0
  }

  if (!scriptPath) return { ...base, status: 'skipped', message: '未配置上传后执行' }
  if (config!.kind === 'command') {
    if (options.target.protocol !== 'sftp' && options.target.protocol !== 'local') {
      return {
        ...base,
        status: 'skipped',
        message: `协议 ${options.target.protocol.toUpperCase()} 不支持执行命令（仅 SFTP / 本地目录）`,
        durationMs: Date.now() - startedAt
      }
    }
    const timeout = options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS
    const run =
      options.target.protocol === 'local'
        ? await execShell(scriptPath, options.target, timeout)
        : await execRemote((options.sftpClient as { client?: unknown } | null)?.client, scriptPath, timeout)
    return { ...run, status: run.exitCode === 0 ? 'success' : 'failed', durationMs: Date.now() - startedAt }
  }
  if (!existsSync(scriptPath)) {
    return { ...base, status: 'failed', message: `本地脚本不存在：${scriptPath}`, durationMs: Date.now() - startedAt }
  }

  const protocol = options.target.protocol
  if (protocol !== 'sftp' && protocol !== 'local') {
    return {
      ...base,
      status: 'skipped',
      message: `协议 ${protocol.toUpperCase()} 不支持执行脚本（仅 SFTP / 本地目录）`,
      durationMs: Date.now() - startedAt
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS

  if (protocol === 'local') {
    const run = await execLocal(scriptPath, options.target, timeoutMs)
    return { ...run, status: run.exitCode === 0 ? 'success' : 'failed', durationMs: Date.now() - startedAt }
  }

  // SFTP：先按内容寻址上传到临时目录，再执行
  const sftp = options.sftpClient
  if (!sftp) {
    return { ...base, status: 'failed', message: 'SFTP 会话不可用', durationMs: Date.now() - startedAt }
  }

  let remotePath = ''
  let uploaded = false
  try {
    const content = await fsp.readFile(scriptPath)
    const sha = createHash('sha256').update(content).digest('hex')
    remotePath = scriptRemotePath(scriptPath, sha)

    await sftp.mkdir(REMOTE_SCRIPT_DIR, true).catch(() => undefined)
    const existing = await sftp.stat(remotePath).catch(() => null)
    const needUpload = shouldUploadScript((existing?.size as number | undefined) ?? null, content.length)
    if (needUpload) {
      await sftp.put(scriptPath, remotePath)
      uploaded = true
    }
    await sftp.chmod?.(remotePath, 0o700).catch(() => undefined)

    const command = `sh ${shellQuote(remotePath)}`
    const result = await execRemote(sftp.client, command, timeoutMs)
    return {
      ...result,
      status: result.exitCode === 0 ? 'success' : 'failed',
      remotePath,
      uploaded,
      durationMs: Date.now() - startedAt
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, status: 'failed', message, remotePath, uploaded, durationMs: Date.now() - startedAt }
  }
}

/** 本地目录目标：脚本就在本机，直接执行（Windows 下 .bat/.cmd 走 shell） */
function execLocal(
  scriptPath: string,
  target: DeployTarget,
  timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(scriptPath, [], {
      cwd: target.host || undefined,
      shell: process.platform === 'win32' || /\.(bat|cmd|ps1)$/i.test(scriptPath),
      windowsHide: true,
      timeout: timeoutMs
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (error) => resolve({ exitCode: null, stdout: truncate(stdout), stderr: truncate(error.message) }))
    child.on('close', (code) => resolve({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) }))
  })
}

/** 本地目录目标：命令用系统 shell 执行 */
function execShell(
  command: string,
  target: DeployTarget,
  timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: target.host || undefined,
      shell: true,
      windowsHide: true,
      timeout: timeoutMs
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (error) => resolve({ exitCode: null, stdout: truncate(stdout), stderr: truncate(error.message) }))
    child.on('close', (code) => resolve({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) }))
  })
}

/** SFTP 目标：通过同一个 ssh2 连接开 exec 通道 */
function execRemote(
  client: unknown,
  command: string,
  timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const ssh = client as
    | { exec?: (cmd: string, cb: (err: Error | undefined, stream: any) => void) => void }
    | null
  if (!ssh?.exec) {
    return Promise.resolve({ exitCode: null, stdout: '', stderr: 'SSH 会话不可用' })
  }
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ exitCode: null, stdout: '', stderr: `脚本执行超过 ${Math.round(timeoutMs / 1000)} 秒，已放弃等待` })
    }, timeoutMs)

    ssh.exec!(command, (err: Error | undefined, stream: any) => {
      if (err) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ exitCode: null, stdout: '', stderr: err.message })
        }
        return
      }
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      stream.on('data', (d: Buffer) => (stdout += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      stream.on('exit', (exitCode: number) => (code = exitCode))
      stream.on('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) })
      })
    })
  })
}
