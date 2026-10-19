/**
 * 连接发现（CLI 与 MCP 共用同一顺序）。
 *
 * 优先级：`--connect` 直接给的连接串 → `--profile` 本地命名配置 → `SHIPIT_HOME` 用户目录 → 平台默认用户数据目录。
 * 前端不接收裸端口与裸令牌（CON-7）；发现失败返回后端不可用，不要求用户手填。
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ErrorCode } from '../shared/cli-contract'
import { matchesFingerprint } from '../shared/fingerprint'

/** 连接信息文件名（服务端写入，前端读取） */
export const CONNECTION_FILE = 'server.json'

/** 应用用户数据目录名（三平台一致） */
export const APP_DIR_NAME = 'shipit'

/** 指纹校验：与服务端证书指纹不一致即拒绝（AC-027 / INV-11） */
export const checkFingerprint = matchesFingerprint

export interface DiscoveredConnection {
  /** 目标主机；本机发现时为 undefined（默认回环） */
  host?: string
  port: number
  token: string
  protocolVersion: number
  fingerprint: string
  /** 发现来源，便于排障与日志 */
  source: 'profile' | 'connect' | 'shipit-home' | 'default-user-data'
  /** 实际读取的连接信息文件路径（`--connect` 直接用串时没有） */
  file?: string
}

export interface DiscoverError {
  code: ErrorCode
  message: string
  hint?: string
}

export type DiscoverResult =
  | { ok: true; connection: DiscoveredConnection }
  | { ok: false; error: DiscoverError }

export interface DiscoverOptions {
  env: Record<string, string | undefined>
  args: readonly string[]
  /** 便于测试注入；默认取当前平台 */
  platform?: NodeJS.Platform
  /** 便于测试注入；默认取 os.homedir() */
  home?: string
}

/** 平台默认用户数据目录（与 Electron userData 口径一致） */
export function defaultUserDataDir(opts: { platform?: NodeJS.Platform; env: Record<string, string | undefined>; home?: string }): string {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? homedir()
  if (platform === 'win32') {
    const appData = opts.env.APPDATA
    return join(appData && appData.length > 0 ? appData : join(home, 'AppData', 'Roaming'), APP_DIR_NAME)
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DIR_NAME)
  }
  const xdg = opts.env.XDG_CONFIG_HOME
  return join(xdg && xdg.length > 0 ? xdg : join(home, '.config'), APP_DIR_NAME)
}

/** 本机保存的远端连接配置目录名（profile：name/host/port/token/fingerprint） */
export const PROFILES_DIR = 'profiles'

/**
 * profile 名白名单：只允许 字母/数字/点/下划线/连字符，且不含 `..`。
 * 防止 `--profile ../../x` 读到用户目录之外的任意文件。
 */
export function isValidProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..')
}

/** 解析 `--profile <name>` / `--profile=<name>` */
function explicitProfile(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--profile') return args[i + 1]
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return undefined
}

/** 解析 `--connect <连接串>` / `--connect=<连接串>`（串内容即桌面版「导出连接串」的 JSON） */
function explicitConnect(args: readonly string[]): { given: boolean; value?: string } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--connect') return { given: true, value: args[i + 1] }
    if (arg.startsWith('--connect=')) return { given: true, value: arg.slice('--connect='.length) }
  }
  return { given: false }
}

/** 拒绝裸端口与裸令牌（CON-7：避免令牌进入命令行、进程列表与 CI 日志） */
function rejectBareCredentials(args: readonly string[]): DiscoverError | undefined {
  const forbidden = args.find((a) => /^--(port|token)(=|$)/.test(a))
  if (!forbidden) return undefined
  const name = forbidden.startsWith('--port') ? '--port' : '--token'
  return {
    code: 'USAGE',
    message: `不支持 ${name} 参数：前端只通过连接信息文件发现端口与令牌`,
    hint: '请在桌面版设置中开启本地服务，或用 --connect 传入「导出连接串」复制的 JSON 串'
  }
}

function readConnectionFile(file: string, source: DiscoveredConnection['source'] = 'shipit-home'): DiscoverResult {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown
  } catch {
    return {
      ok: false,
      error: {
        code: 'BACKEND_UNAVAILABLE',
        message: `读取连接信息失败：${file}`,
        hint: '请确认桌面版已开启本地服务（设置 → 本地服务端）'
      }
    }
  }
  return parseConnectionInfo(raw, file, source, file)
}

/** `--connect` 的连接串（JSON 文本）→ 连接参数 */
function parseConnectString(value: string): DiscoverResult {
  let raw: unknown
  try {
    raw = JSON.parse(value) as unknown
  } catch {
    return {
      ok: false,
      error: {
        code: 'BACKEND_UNAVAILABLE',
        message: '连接串不是合法 JSON',
        hint: '请粘贴桌面版「导出连接串」复制的内容（JSON：host/port/token/protocolVersion/fingerprint）'
      }
    }
  }
  return parseConnectionInfo(raw, '连接串', 'connect')
}

/** 连接信息（文件内容或连接串）→ 连接参数；两处共用同一套字段校验 */
function parseConnectionInfo(
  raw: unknown,
  where: string,
  source: DiscoveredConnection['source'],
  file?: string
): DiscoverResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: `连接信息内容无效：${where}` } }
  }
  const info = raw as Record<string, unknown>
  const port = info.port
  const token = info.token
  const protocolVersion = info.protocolVersion
  const fingerprint = info.fingerprint

  // HTTP 头只接受 latin-1 可见字符：令牌里混入换行/中文等会让 Node 在构造请求时**同步抛**
  // ERR_INVALID_CHAR，绕过所有错误处理变成裸栈退出（破坏"任何失败都是信封"的契约）。
  // 在这里提前挡下，给出可操作的提示。
  const BAD_HEADER_CHAR = /[^\x21-\x7e]/
  const tokenHasBadChar = typeof token === 'string' && BAD_HEADER_CHAR.test(token)

  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof token !== 'string' ||
    token.length === 0 ||
    tokenHasBadChar ||
    typeof protocolVersion !== 'number' ||
    typeof fingerprint !== 'string'
  ) {
    return {
      ok: false,
      error: {
        code: 'BACKEND_UNAVAILABLE',
        message: tokenHasBadChar
          ? `连接信息里的令牌含非法字符（只允许可打印 ASCII）：${where}`
          : `连接信息缺少必要字段：${where}`,
        hint: tokenHasBadChar
          ? '令牌应是桌面版生成的十六进制串；请重新复制连接串（注意不要带入换行/中文）'
          : '重新开启本地服务，或重新导出连接串'
      }
    }
  }

  return {
    ok: true,
    connection: {
      host: typeof info.host === 'string' && info.host.length > 0 ? info.host : undefined,
      port,
      token,
      protocolVersion,
      fingerprint,
      source,
      file
    }
  }
}
/** 按优先级定位并解析连接信息 */
export function discoverConnection(opts: DiscoverOptions): DiscoverResult {
  const invalid = rejectBareCredentials(opts.args)
  if (invalid) return { ok: false, error: invalid }

  const connect = explicitConnect(opts.args)
  if (connect.given) {
    if (!connect.value || connect.value.startsWith('--')) {
      return {
        ok: false,
        error: {
          code: 'USAGE',
          message: '--connect 缺少连接串',
          hint: `连接串是桌面版「导出连接串」复制的 JSON，例如： '{"host":"192.168.1.20","port":4517,"token":"<令牌>","protocolVersion":1,"fingerprint":"<64位十六进制>"}'`
        }
      }
    }
    return parseConnectString(connect.value)
  }

  // 显式 profile：客户端本机用户目录内的命名连接配置（含凭据）
  const profile = explicitProfile(opts.args)
  if (profile !== undefined) {
    if (!isValidProfileName(profile)) {
      return {
        ok: false,
        error: {
          code: 'USAGE',
          message: `非法的 profile 名称：${profile}`,
          hint: 'profile 名只允许字母、数字、点、下划线与连字符（不可包含路径）'
        }
      }
    }
    const baseDir =
      opts.env.SHIPIT_HOME && opts.env.SHIPIT_HOME.length > 0 ? opts.env.SHIPIT_HOME : defaultUserDataDir(opts)
    const result = readConnectionFile(join(baseDir, PROFILES_DIR, `${profile}.json`))
    if (result.ok) return { ok: true, connection: { ...result.connection, source: 'profile' } }
    return result
  }

  const shipitHome = opts.env.SHIPIT_HOME
  if (shipitHome && shipitHome.length > 0) {
    const result = readConnectionFile(join(shipitHome, CONNECTION_FILE))
    if (result.ok) return { ok: true, connection: { ...result.connection, source: 'shipit-home' } }
    return result
  }

  const fallbackDir = defaultUserDataDir(opts)
  const result = readConnectionFile(join(fallbackDir, CONNECTION_FILE))
  if (result.ok) return { ok: true, connection: { ...result.connection, source: 'default-user-data' } }
  return result
}
