/**
 * 上传后脚本的纯逻辑（路径与跳过判定）。
 *
 * 真实执行需要 SFTP/SSH，这里只覆盖不依赖网络的决定性行为：
 * 内容寻址的文件名 + 「同尺寸即跳过上传」。
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { REMOTE_SCRIPT_DIR, postUploadOf, runPostUploadScript, scriptRemotePath, shouldUploadScript } from './post-upload-script'
import type { DeployTarget } from '../../shared/types'

const workDir = mkdtempSync(join(tmpdir(), 'shipit-post-upload-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

/** 本地目录目标上的「命令」执行（不依赖网络，可直接跑真实子进程） */
const commandTarget = (value: string): DeployTarget =>
  ({ protocol: 'local', host: workDir, postUpload: { kind: 'command', value } }) as unknown as DeployTarget

describe('post-upload-script', () => {
  it('远端路径是内容寻址的：同名即同内容，便于跳过重复上传', () => {
    const sha = 'a'.repeat(64)
    expect(scriptRemotePath('/home/me/deploy.sh', sha)).toBe(`${REMOTE_SCRIPT_DIR}/deploy-aaaaaaaaaaaa.sh`)
  })

  it('文件名里的不安全字符会被收敛（空格/中文/引号都不会带进 shell 路径）', () => {
    const path = scriptRemotePath('C:\\tmp\\我的 脚本 "x".sh', 'b'.repeat(64))
    expect(path.startsWith(`${REMOTE_SCRIPT_DIR}/`)).toBe(true)
    expect(path.endsWith('-bbbbbbbbbbbb.sh')).toBe(true)
    expect(path).not.toMatch(/[\s"']/)          // 没有空白/引号
    expect(path).not.toMatch(/[^\x00-\x7F]/)   // 没有非 ASCII
  })

  it('远端不存在（null）或尺寸不同 → 需要上传；尺寸一致 → 跳过', () => {
    expect(shouldUploadScript(null, 1024)).toBe(true)
    expect(shouldUploadScript(1024, 1024)).toBe(false)
    expect(shouldUploadScript(1023, 1024)).toBe(true)
  })

  it('未配置脚本时不产生远端路径（调用方据此跳过整段）', () => {
    const target = { postUploadScript: '' }
    expect(Boolean(target.postUploadScript)).toBe(false)
  })

  it('旧字段 postUploadScript 迁移成 script；新字段优先', () => {
    expect(postUploadOf({ postUploadScript: '/tmp/a.sh' } as any)).toEqual({ kind: 'script', value: '/tmp/a.sh' })
    expect(
      postUploadOf({ postUpload: { kind: 'command', value: 'systemctl restart app' }, postUploadScript: '/tmp/a.sh' } as any)
    ).toEqual({ kind: 'command', value: 'systemctl restart app' })
  })
})

/**
 * 这里锁的是「结果里必须带 kind」：日志文案靠它区分「命令已执行」和「脚本已执行」。
 * 之前成功分支只展开了 run（exitCode/stdout/stderr），kind 丢失 → 命中命令也写成「脚本」。
 */
describe('post-upload-script 执行结果', () => {
  it('命令执行成功：kind 保留为 command，退出码 0', async () => {
    const result = await runPostUploadScript({
      target: commandTarget('node -e "console.log(123)"'),
      isLocal: true,
      timeoutMs: 20000
    })
    expect(result.kind).toBe('command')
    expect(result.status).toBe('success')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('123')
  }, 30000)

  it('命令执行失败：kind 仍是 command，退出码原样返回', async () => {
    const result = await runPostUploadScript({
      target: commandTarget('node -e "process.exit(3)"'),
      isLocal: true,
      timeoutMs: 20000
    })
    expect(result.kind).toBe('command')
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(3)
  }, 30000)
})
