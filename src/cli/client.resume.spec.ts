/**
 * 回归用例：**空闲后第一次调用不得被误判为 TLS_MISMATCH**。
 *
 * 缺陷现场（用户实测）：默认 `https.globalAgent` 会缓存 TLS session；服务端关掉空闲连接后，
 * 下一次连接走 session resumption → 服务端**不再下发证书** → `getPeerCertificate()` 为空
 * → 指纹算成 '' → 被误判成"指纹不一致"（空闲后第一次必失败、紧接着重试成功）。
 *
 * 本用例：真 TLS 服务端 → 请求一次（建立会话）→ **服务端主动关闭空闲连接** → 再请求一次。
 * 断言：两次都 ok；且第二次不得报 TLS_MISMATCH。
 * 反向验证：把 agent 换回"带会话缓存"的默认行为时，本用例应失败。
 */
import { createServer as createHttpsServer, type Server } from 'https'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerClient } from './client'
import { ensureSelfSignedCert } from '../main/services/tls-cert'
import { PROTOCOL_VERSION } from '../shared/cli-contract'

let server: Server | null = null
let dir = ''

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => {
      server!.close(() => r())
      server!.closeIdleConnections()
      server!.closeAllConnections()
    })
    server = null
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/** 极简 ShipIt 信封服务端（只回 /status） */
async function startStatusServer(): Promise<{ port: number; fingerprint: string; server: Server }> {
  dir = mkdtempSync(join(tmpdir(), 'shipit-resume-'))
  const tls = await ensureSelfSignedCert(dir)
  const srv = createHttpsServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, data: { listening: true, port: 0, protocolVersion: PROTOCOL_VERSION }, meta: {} }))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const address = srv.address()
  const port = typeof address === 'object' && address ? address.port : 0
  server = srv
  return { port, fingerprint: tls.fingerprint, server: srv }
}

describe('TLS 会话复用不得造成"指纹不一致"误判（P1 回归）', () => {
  it('服务端关闭空闲连接后，下一次调用仍然成功（不报 TLS_MISMATCH）', async () => {
    const { port, fingerprint, server: srv } = await startStatusServer()
    const client = createServerClient({
      connection: { port, token: 'test-token-0123456789abcdef', protocolVersion: PROTOCOL_VERSION, fingerprint, source: 'default-user-data' },
      client: 'cli'
    })

    const first = await client.get('/status')
    expect(first.ok).toBe(true)

    // 模拟"空闲后服务端关掉连接"：关掉空闲 socket，迫使下一次请求重建连接（此时会走会话复用）
    srv.closeIdleConnections()
    await new Promise((r) => setTimeout(r, 120))

    const second = await client.get('/status')
    // 关键断言：不能因为"没拿到证书"就报指纹不一致
    if (!second.ok) {
      expect(second.error.code).not.toBe('TLS_MISMATCH')
    }
    expect(second.ok).toBe(true)
  })

  it('连续多次调用（含空闲间隔）全部成功', async () => {
    const { port, fingerprint, server: srv } = await startStatusServer()
    const client = createServerClient({
      connection: { port, token: 'test-token-0123456789abcdef', protocolVersion: PROTOCOL_VERSION, fingerprint, source: 'default-user-data' },
      client: 'cli'
    })
    const codes: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = await client.get('/status')
      codes.push(r.ok ? 'ok' : r.error.code)
      srv.closeIdleConnections() // 每次都制造"空闲后重建"
      await new Promise((r2) => setTimeout(r2, 80))
    }
    expect(codes).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('指纹确实不同时仍报 TLS_MISMATCH（安全语义不能被削弱）', async () => {
    const { port, server: srv } = await startStatusServer()
    const client = createServerClient({
      // 故意给一个错误的指纹
      connection: { port, token: 'test-token-0123456789abcdef', protocolVersion: PROTOCOL_VERSION, fingerprint: 'f'.repeat(64), source: 'default-user-data' },
      client: 'cli'
    })
    const r = await client.get('/status')
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error.code).toBe('TLS_MISMATCH')
    void srv
  })
})
