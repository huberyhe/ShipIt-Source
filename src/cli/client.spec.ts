import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLocalServer, type LocalServer } from '../main/services/local-server'
import { ensureSelfSignedCert } from '../main/services/tls-cert'
import { defaultServerConfig } from '../main/services/server-config'
import { PROTOCOL_VERSION } from '../shared/cli-contract'
import type { DiscoveredConnection } from './discover'
import { createServerClient } from './client'
import { runCli } from './index'

let dir = ''
let server: LocalServer | null = null
const TOKEN = '0123456789abcdef'

function startServer(handlers: Record<string, unknown> = {}): Promise<number> {
  server = createLocalServer({
    config: { ...defaultServerConfig(), enabled: true, port: 0, tokenMode: 'custom', token: TOKEN },
    dataDir: dir,
    handlers: handlers as never
  })
  return server.start().then((r) => (r.listening ? r.port : 0))
}

const connection = (port: number, over: Partial<DiscoveredConnection> = {}): DiscoveredConnection => ({
  port,
  token: TOKEN,
  protocolVersion: PROTOCOL_VERSION,
  fingerprint: server?.fingerprint() ?? '',
  source: 'shipit-home',
  file: join(dir, 'server.json'),
  ...over
})

function captureIo(): { io: { stdout: (t: string) => void; stderr: (t: string) => void }; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return { io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) }, stdout, stderr }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipit-cli-'))
  server = null
})

afterEach(async () => {
  if (server) await server.stop().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('client', () => {
  it('P3 回归 指纹不匹配：拒绝连接，且服务端根本没收到请求（令牌不会先发出去）', async () => {
    const requests: string[] = []
    server = createLocalServer({
      config: { ...defaultServerConfig(), enabled: true, port: 0, tokenMode: 'custom', token: TOKEN },
      dataDir: dir,
      handlers: {} as never,
      onRequest: (info) => requests.push(info.path)
    })
    const started = await server.start()
    if (!started.listening) throw new Error('服务端未启动')

    // 固定成另一个指纹：握手会被拒绝，令牌不能已经写在路上
    const client = createServerClient({
      connection: connection(started.port, { fingerprint: 'a'.repeat(64) }),
      client: 'cli'
    })
    const result = await client.get('/status')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TLS_MISMATCH')
    expect(requests).toEqual([])
  })

  it('P3 回归 响应不是 ShipIt 信封时给出明确错误（不让下游解构时崩）', async () => {
    const { createServer } = await import('https')
    const { readFileSync } = await import('fs')
    const material = await ensureSelfSignedCert(dir)
    const raw = createServer(
      { cert: material.cert, key: material.key },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ hello: 'not-an-envelope' }))
      }
    )
    const port = await new Promise<number>((resolve) =>
      raw.listen(0, '127.0.0.1', () => resolve((raw.address() as { port: number }).port))
    )
    try {
      const client = createServerClient({
        connection: connection(port, { fingerprint: material.fingerprint }),
        client: 'cli'
      })
      const result = await client.get('/status')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('信封')
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()))
    }
  })

  it('AC-013 正常请求拿到成功信封（含内置 /status 数据）', async () => {
    const port = await startServer()
    const client = createServerClient({ connection: connection(port), client: 'cli' })
    const result = await client.get('/status')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.envelope.ok).toBe(true)
    expect(JSON.stringify(result.envelope)).not.toContain(TOKEN)
  })

  it('AC-027 指纹不匹配一律拒绝（TLS_MISMATCH）', async () => {
    const port = await startServer()
    const client = createServerClient({ connection: connection(port, { fingerprint: 'b'.repeat(64) }), client: 'cli' })
    const result = await client.get('/status')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TLS_MISMATCH')
  })

  it('AC-020 / DFX-REL-004 服务端未监听返回后端不可用（不重试、不降级）', async () => {
    const client = createServerClient({
      connection: connection(1, { fingerprint: 'a'.repeat(64) }),
      client: 'cli',
      timeoutMs: 2000
    })
    const result = await client.get('/status')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('BACKEND_UNAVAILABLE')
  })

  it('AC-021 / CON-4 协议版本不一致在本地即拒绝，不发请求', async () => {
    const port = await startServer()
    const client = createServerClient({ connection: connection(port, { protocolVersion: 0 }), client: 'cli' })
    const result = await client.get('/status')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PROTOCOL_MISMATCH')
  })

  it('AC-022 令牌错误透传服务端错误类别', async () => {
    const port = await startServer()
    const client = createServerClient({ connection: connection(port, { token: 'ffffffffffffffff' }), client: 'cli' })
    const result = await client.get('/status')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.envelope.ok).toBe(false)
    if (result.envelope.ok) return
    expect(result.envelope.error.code).toBe('INVALID_TOKEN')
  })
})

describe('runCli', () => {
  it('AC-014 缺参数返回退出码 1', async () => {
    const cap = captureIo()
    const code = await runCli(['deploy'], { env: { SHIPIT_HOME: dir }, io: cap.io })
    expect(code).toBe(1)
    expect(cap.stderr.join('')).toContain('USAGE')
  })

  it("未知命令：默认通道输出人类可读错误（不打印 JSON）", async () => {
    const cap = captureIo()
    const code = await runCli(["nope"], { env: { SHIPIT_HOME: dir }, io: cap.io })
    expect(code).toBe(1)
    expect(cap.stdout.join("")).toBe("")
    expect(cap.stderr.join("")).toContain("[USAGE]")
    expect(cap.stderr.join("")).not.toContain('{"')
  })

  it("未知命令 + --json：早期错误同样给出结构化信封（stderr）", async () => {
    const cap = captureIo()
    const code = await runCli(["nope", "--json"], { env: { SHIPIT_HOME: dir }, io: cap.io })
    expect(code).toBe(1)
    expect(cap.stdout.join("")).toBe("")
    expect(JSON.parse(cap.stderr.join("").trim())).toMatchObject({ ok: false, error: { code: "USAGE" } })
  })

  it('AC-020 后端不可用返回退出码 3', async () => {
    // 连接信息指向一个必然没有监听的端口；且用 SHIPIT_HOME 隔离，
    // 绝不读取开发机真实用户目录（否则本机若有桌面版在跑，用例会"真的连上"而误判）
    const deadPort = 1
    writeFileSync(
      join(dir, 'server.json'),
      JSON.stringify({ port: deadPort, token: 'x'.repeat(20), protocolVersion: PROTOCOL_VERSION, fingerprint: 'a'.repeat(64) }),
      'utf-8'
    )
    const cap = captureIo()
    const code = await runCli(['status', '--json'], { env: { SHIPIT_HOME: dir }, io: cap.io })
    expect(code).toBe(3)
    expect(cap.stderr.join('')).toContain('BACKEND_UNAVAILABLE')
  })

  it('AC-020 无连接信息文件同样返回退出码 3（不要求用户手填端口令牌）', async () => {
    const cap = captureIo()
    const code = await runCli(['status', '--json'], { env: { SHIPIT_HOME: dir }, io: cap.io })
    expect(code).toBe(3)
    expect(cap.stderr.join('')).toContain('BACKEND_UNAVAILABLE')
  })

  it('DFX-USE-001 --help 走文本通道并返回 0', async () => {
    const cap = captureIo()
    const code = await runCli(['--help'], { env: { SHIPIT_HOME: dir }, io: cap.io })
    expect(code).toBe(0)
    expect(cap.stdout.join('')).toContain('shipit <命令>')
  })

  it('CON-2 --help --json 只输出结构化信封', async () => {
    const cap = captureIo()
    const code = await runCli(['--help', '--json'], { env: { SHIPIT_HOME: dir }, io: cap.io })
    expect(code).toBe(0)
    const out = cap.stdout.join('')
    expect(out.trim().startsWith('{')).toBe(true)
    expect(JSON.parse(out).ok).toBe(true)
  })
})
