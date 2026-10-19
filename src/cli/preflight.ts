/**
 * 启动预检（CLI 与 MCP 共用）。
 *
 * 目的：在**做任何真实工作之前**确认「桌面版在运行 + 认证通过 + 协议版本一致」，
 * 避免把失败推迟到第一次工具调用（MCP 常驻进程尤其需要：宿主会以为服务已就绪）。
 *
 * 预检就是一次带凭据的 `GET /status`：
 * - 连不上 → BACKEND_UNAVAILABLE（连接信息缺失/服务未开）
 * - 认证失败 → INVALID_TOKEN（令牌轮换/被改）
 * - 指纹不符 → TLS_MISMATCH
 * - 协议不一致 → PROTOCOL_MISMATCH（本地连接信息已能判一部分，服务端请求头再判一次）
 */
import type { ErrorCode, Envelope } from '../shared/cli-contract'
import { PROTOCOL_VERSION } from '../shared/cli-contract'
import type { ServerClient } from './client'

export interface ServerReady {
  ok: true
  /** 服务端包版本（桌面版版本号） */
  serverVersion: string
  /** 服务端协议版本（应与前端一致） */
  protocolVersion: number
}

export interface NotReady {
  ok: false
  error: { code: ErrorCode; message: string; hint?: string }
  /** 原始信封（供 `--json` / MCP stderr 原样输出） */
  envelope: Envelope
}

export type PreflightResult = ServerReady | NotReady

function failure(error: { code: ErrorCode; message: string; hint?: string }): NotReady {
  return { ok: false, error, envelope: { ok: false, error } }
}

/** 预检：一次 `GET /status` 同时校验连通性、认证与协议版本 */
export async function checkServerReady(client: ServerClient): Promise<PreflightResult> {
  const result = await client.get('/status')
  // 传输层/连接类失败（连不上、TLS 指纹、本地协议预判）
  if (!result.ok) return failure(result.error)
  // 服务端返回了失败信封（认证失败、协议头不一致……）——原样透出，保留服务端口径
  if (!result.envelope.ok) {
    const { code, message, hint } = result.envelope.error
    return { ok: false, error: hint ? { code, message, hint } : { code, message }, envelope: result.envelope }
  }

  const data = result.envelope.data as { version?: unknown; protocolVersion?: unknown } | undefined
  const protocolVersion = typeof data?.protocolVersion === 'number' ? data.protocolVersion : null

  // 服务端回显的协议版本必须与前端一致：连接信息可能是别的前端写的，而服务端才是权威
  if (protocolVersion !== null && protocolVersion !== PROTOCOL_VERSION) {
    return failure({
      code: 'PROTOCOL_MISMATCH',
      message: `协议版本不一致：服务端为 ${protocolVersion}，当前 CLI / MCP 为 ${PROTOCOL_VERSION}`,
      hint: '请使用与桌面版同版本的 CLI / MCP 包（随桌面版一同发布）'
    })
  }

  return {
    ok: true,
    serverVersion: typeof data?.version === 'string' ? data.version : 'unknown',
    protocolVersion: protocolVersion ?? PROTOCOL_VERSION
  }
}

/** 预检的连接提供者版本：先按连接发现建连，再预检 */
export async function preflightProvider(provider: {
  connect(): Promise<{ ok: true; client: ServerClient } | { ok: false; error: { code: string; message: string; hint?: string } }>
}): Promise<PreflightResult> {
  const connected = await provider.connect()
  if (!connected.ok) {
    return failure({ ...connected.error, code: connected.error.code as ErrorCode })
  }
  return checkServerReady(connected.client)
}
