import { readJsonObject, withConfigWriteLock, writeJsonAtomic } from './config-file'
import { normalizeAllowedRoots } from '../../shared/allowed-roots'
/**
 * 本地服务端配置读取 / 写入与令牌校验。
 *
 * 不依赖 Electron：配置路径由调用方注入（便于测试与 CLI 之外的复用）。
 * 配置与桌面配置同文件，存在 `server` 键下，写入时保留其余键。
 */
import { randomBytes } from 'crypto'
import type { ServerConfig, ServerBind, TokenMode } from '../../shared/types'

export type { ServerConfig }

/** 默认端口：4517（固定值，便于文档与脚本引用） */
export const DEFAULT_PORT = 4517

/** 令牌最短长度 */
export const MIN_TOKEN_LENGTH = 16

export function defaultServerConfig(): ServerConfig {
  return {
    enabled: false,
    bind: 'local',
    port: DEFAULT_PORT,
    tokenMode: 'random',
    token: '',
    // 默认空：局域网下只允许「桌面已打开的项目」；需要更多范围时由用户显式添加
    allowedRoots: []
  }
}

/** 归一化「允许的项目根」列表：去空、去重、去尾部分隔符，保持用户顺序 */

/** 校验用户自定义令牌强度（AC-028） */
export function validateToken(token: string): { ok: boolean; reason: string } {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, reason: `令牌长度需不少于 ${MIN_TOKEN_LENGTH} 个字符` }
  }
  return { ok: true, reason: '' }
}

/** 生成随机令牌（64 个十六进制字符，远超最小长度） */
export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function isPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535
}

/** 把任意输入归一化成合法配置，非法值一律回落默认值 */
export function normalizeServerConfig(input: unknown): ServerConfig {
  const base = defaultServerConfig()
  if (!input || typeof input !== 'object') return base
  const raw = input as Record<string, unknown>

  const bind: ServerBind = raw.bind === 'lan' ? 'lan' : base.bind
  const tokenMode: TokenMode = raw.tokenMode === 'custom' ? 'custom' : base.tokenMode
  const port = isPort(raw.port) ? raw.port : base.port
  const token = typeof raw.token === 'string' ? raw.token : base.token

  return {
    enabled: raw.enabled === true,
    bind,
    port,
    tokenMode,
    token,
    allowedRoots: normalizeAllowedRoots(raw.allowedRoots)
  }
}

const readFileObject = readJsonObject

/**
 * 读取服务端配置。
 * 随机令牌模式下若尚无令牌，会生成一次并持久化，保证重启后令牌不变（客户端无需重新配对）。
 */
export async function loadServerConfig(configPath: string): Promise<ServerConfig> {
  const raw = await readFileObject(configPath)
  const cfg = normalizeServerConfig(raw.server)

  // 令牌缺失或不可用（曾被写入空值/过短值）→ 立即生成并落盘，两种模式一视同仁：
  // 服务端拿着一份不可用的 expected 令牌只会让所有请求恒 401 且不自愈（只能手工删配置恢复）。
  if (!validateToken(cfg.token).ok) {
    cfg.token = generateToken()
    await persist(configPath, cfg)
  }
  return cfg
}

async function persist(configPath: string, server: ServerConfig): Promise<void> {
  // 与 ConfigStore 共用同一把写锁：两者写同一个文件，read-modify-write 必须整段串行，
  // 否则后写者会以自己读到的旧快照覆盖对方刚写的键（互丢更新）。
  await withConfigWriteLock(async () => {
    const raw = await readFileObject(configPath)
    raw.server = server
    // 原子写（tmp + rename）：避免崩溃/断电留下半截 JSON（目标含凭据，不可自愈）
    await writeJsonAtomic(configPath, raw)
  })
}

/**
 * 轮换令牌：切到随机模式并生成一个新令牌（显式语义，避免依赖「先存空值再读一次」的副作用顺序）。
 */
export async function rotateToken(configPath: string): Promise<ServerConfig> {
  const current = await loadServerConfig(configPath)
  const next: ServerConfig = { ...current, tokenMode: 'random', token: generateToken() }
  await persist(configPath, next)
  return next
}

/**
 * 连接串字段（`server:export-connection` 导出、CLI/MCP 的 `--connect` 直接消费；字段为兼容契约）。
 */
export interface ExportedConnection {
  /** 对端可访问的主机（回环或局域网 IPv4） */
  host: string
  port: number
  token: string
  protocolVersion: number
  /** 服务端证书指纹（64 位十六进制） */
  fingerprint: string
}

/**
 * 连接串：**单行压缩 JSON**。
 *
 * 主要用途是 CLI `--connect`（复制到剪贴板后直接粘贴进命令行）：格式化 JSON 会带换行，
 * 粘进 shell 容易断行/转义出错，因此这里固定压缩输出。
 */
export function connectionString(connection: ExportedConnection): string {
  return JSON.stringify(connection)
}
/**
 * 保存结果。
 *
 * 令牌门槛由本模块把关：渲染层（preload/IPC 调用方）不是可信边界，
 * 曾出现 `{ token: '' }` 绕过校验落盘、随机模式被写入 1 字符令牌的路径，
 * 结果是服务端 expected 令牌不可用 → 所有请求恒 401。
 */
export type SaveServerConfigOutcome =
  | { ok: true; config: ServerConfig }
  | { ok: false; reason: string }

/** 合并写入服务端配置（其它键保持不变）；令牌不可用时拒绝写入并给出原因 */
export async function saveServerConfig(
  configPath: string,
  patch: Partial<ServerConfig>
): Promise<SaveServerConfigOutcome> {
  const current = await loadServerConfig(configPath)
  const next = normalizeServerConfig({ ...current, ...patch })

  // ① 显式传入的令牌（非空）必须过强度校验 —— 两种模式一视同仁
  if (patch.token !== undefined && patch.token !== '' && !validateToken(patch.token).ok) {
    return { ok: false, reason: `令牌长度需不少于 ${MIN_TOKEN_LENGTH} 个字符` }
  }
  // ② custom 模式下令牌必须可用 —— 但只在调用方真的动了令牌/模式时才拦：
  // 配置里已存在不可用令牌时，改端口或开关不该被令牌长度阻断（读取路径会自愈）
  const touchesToken = patch.token !== undefined || patch.tokenMode !== undefined
  if (touchesToken && next.tokenMode === 'custom' && !validateToken(next.token).ok) {
    return { ok: false, reason: `自定义令牌长度需不少于 ${MIN_TOKEN_LENGTH} 个字符` }
  }
  // ③ random 模式下令牌由本模块维护：空值/不可用一律重新生成（自愈）
  if (next.tokenMode === 'random' && !validateToken(next.token).ok) {
    next.token = generateToken()
  }

  await persist(configPath, next)
  return { ok: true, config: next }
}
