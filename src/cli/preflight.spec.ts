/**
 * 启动预检用例（CLI 与 MCP 共用）。
 *
 * 预检 = 一次带凭据的 `GET /status`，同时判定连通性、认证与协议版本；
 * 它是"启动即校验"的唯一实现，因此这里覆盖四类结果：就绪 / 连不上 / 认证失败 / 协议不一致。
 */
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type Envelope } from '../shared/cli-contract'
import type { ServerClient } from './client'
import { checkServerReady, preflightProvider } from './preflight'

/** 构造只关心 get 结果的假客户端 */
function clientReturning(result: { ok: true; envelope: Envelope } | { ok: false; error: any }): ServerClient {
  return {
    get: async () => result,
    post: async () => result,
    connection: {} as never
  } as unknown as ServerClient
}

describe('启动预检（checkServerReady）', () => {
  it('就绪：返回服务端版本与协议版本', async () => {
    const client = clientReturning({
      ok: true,
      envelope: { ok: true, data: { version: '1.2.3', protocolVersion: PROTOCOL_VERSION } }
    })
    const r = await checkServerReady(client)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.serverVersion).toBe('1.2.3')
    expect(r.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('连不上：透传连接类错误（BACKEND_UNAVAILABLE）', async () => {
    const client = clientReturning({
      ok: false,
      error: { code: 'BACKEND_UNAVAILABLE', message: '连接被拒绝', hint: '请确认桌面版在运行' }
    })
    const r = await checkServerReady(client)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('BACKEND_UNAVAILABLE')
    expect(r.envelope.ok).toBe(false)
  })

  it('认证失败：透出服务端信封与错误类别（INVALID_TOKEN）', async () => {
    const client = clientReturning({
      ok: true,
      envelope: { ok: false, error: { code: 'INVALID_TOKEN', message: '鉴权失败：令牌缺失或不正确', hint: '请在桌面版设置中查看或重新生成令牌' } }
    })
    const r = await checkServerReady(client)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INVALID_TOKEN')
    expect(r.error.hint).toContain('令牌')
  })

  it('协议不一致（服务端回显）：本地判为 PROTOCOL_MISMATCH，不进入业务请求', async () => {
    const client = clientReturning({
      ok: true,
      envelope: { ok: true, data: { version: '1.2.3', protocolVersion: PROTOCOL_VERSION + 1 } }
    })
    const r = await checkServerReady(client)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PROTOCOL_MISMATCH')
    expect(r.error.message).toContain(String(PROTOCOL_VERSION + 1))
  })

  it('服务端未回显协议版本时按当前版本处理（向后兼容）', async () => {
    const client = clientReturning({ ok: true, envelope: { ok: true, data: { version: '1.2.3' } } })
    const r = await checkServerReady(client)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('凭据指纹不过：透传 TLS_MISMATCH', async () => {
    const client = clientReturning({
      ok: false,
      error: { code: 'TLS_MISMATCH', message: '服务端证书指纹与已固定指纹不一致，已拒绝连接' }
    })
    const r = await checkServerReady(client)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('TLS_MISMATCH')
  })
})

describe('preflightProvider', () => {
  it('连接发现失败时直接返回该错误（不构造客户端）', async () => {
    const r = await preflightProvider({
      connect: async () => ({ ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: '读取连接信息失败' } })
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('BACKEND_UNAVAILABLE')
  })

  it('连接成功时继续做 /status 预检', async () => {
    const inner = clientReturning({
      ok: true,
      envelope: { ok: true, data: { version: '9.9.9', protocolVersion: PROTOCOL_VERSION } }
    })
    const r = await preflightProvider({ connect: async () => ({ ok: true, client: inner }) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.serverVersion).toBe('9.9.9')
  })
})
