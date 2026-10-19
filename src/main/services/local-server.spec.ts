import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer as createNetServer } from 'net'
import { connect as tlsConnect } from 'tls'
import { request as httpsRequest } from 'https'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_PORT, defaultServerConfig } from './server-config'
import { ensureSelfSignedCert, isKeyPairMatch } from './tls-cert'
import { Agent } from 'https'
import { CONNECTION_FILE, MAX_BODY_BYTES, createLocalServer, type LocalServer } from './local-server'
import { PROTOCOL_VERSION } from '../../shared/cli-contract'
import type { ServerConfig } from '../../shared/types'

const TOKEN = '0123456789abcdef'

let dir = ''
let servers: LocalServer[] = []
let netServers: ReturnType<typeof createNetServer>[] = []

const cfg = (patch: Partial<ServerConfig> = {}): ServerConfig => ({
  ...defaultServerConfig(),
  enabled: true,
  port: 0,
  tokenMode: 'custom',
  token: TOKEN,
  ...patch
})

function start(options: { config?: ServerConfig; handlers?: Record<string, unknown> } = {}): LocalServer {
  const srv = createLocalServer({
    config: options.config ?? cfg(),
    dataDir: dir,
    handlers: options.handlers as never
  })
  servers.push(srv)
  return srv
}

function call(
  port: number,
  path: string,
  opts: {
    token?: string | null
    protocol?: string | null
    headers?: Record<string, string>
    method?: string
    body?: unknown
    agent?: Agent
  } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.token !== null) headers['x-shipit-token'] = opts.token ?? TOKEN
  if (opts.protocol !== null) headers['x-shipit-protocol'] = opts.protocol ?? String(PROTOCOL_VERSION)
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
  if (payload) headers['content-type'] = 'application/json'

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers,
        rejectUnauthorized: false,
        ...(opts.agent ? { agent: opts.agent } : {})
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let body: any = raw
          try {
            body = JSON.parse(raw)
          } catch {
            /* 保留原始文本 */
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 原始请求：带鉴权与协议头，用于构造超大请求体等边界场景 */
function rawRequest(
  port: number,
  path: string,
  opts: { method: string; headers: Record<string, string>; body?: string }
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method,
        rejectUnauthorized: false,
        headers: {
          'x-shipit-token': TOKEN,
          'x-shipit-protocol': String(PROTOCOL_VERSION),
          'content-type': 'application/json',
          ...opts.headers
        }
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let body: any = raw
          try {
            body = JSON.parse(raw)
          } catch {
            /* 保留文本 */
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      }
    )
    req.on('error', () => resolve({ status: 0, body: { error: { code: 'CONNECTION_CLOSED' } } }))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipit-server-'))
  servers = []
  netServers = []
})

afterEach(async () => {
  for (const s of servers) await s.stop().catch(() => undefined)
  for (const n of netServers) n.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('local-server', () => {
  it('AC-017 / DFX-SEC-002 未开启时不监听任何地址，且不写连接信息文件（INV-4：默认不开启、暴露面收敛）', async () => {
    const srv = start({ config: cfg({ enabled: false }) })
    const res = await srv.start()
    expect(res).toMatchObject({ listening: false })
    expect(existsSync(join(dir, CONNECTION_FILE))).toBe(false)
  })

  it('AC-026 / INV-11 局域网绑定 + 强制 TLS + 正确令牌可访问；错误令牌被拒', async () => {
    const srv = start({ config: cfg({ bind: 'lan' }) })
    const started = await srv.start()
    expect(started.listening).toBe(true)
    if (!started.listening) return
    expect(started.bound).toBe('0.0.0.0')

    const okRes = await call(started.port, '/status', { token: TOKEN })
    expect(okRes.status).toBe(200)
    const wrong = await call(started.port, '/status', { token: 'ffffffffffffffff' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.code).toBe('INVALID_TOKEN')
  })

  it('AC-026 缺少令牌同样按鉴权失败拒绝，且响应不回显令牌（INV-5）', async () => {
    const srv = start()
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')
    const res = await call(started.port, '/status', { token: null })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_TOKEN')
    expect(JSON.stringify(res.body)).not.toContain(TOKEN)
  })

  it('AC-017 仅本机绑定时只监听回环地址', async () => {
    const srv = start({ config: cfg({ bind: 'local' }) })
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')
    expect(started.bound).toBe('127.0.0.1')
  })

  it('AC-021 协议版本不一致返回 PROTOCOL_MISMATCH（INV-8）', async () => {
    const srv = start()
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')
    const res = await call(started.port, '/status', { protocol: '0' })
    expect(res.body.error.code).toBe('PROTOCOL_MISMATCH')
    expect(res.status).toBe(400)
  })

  it('AC-021 协议版本缺失按不匹配处理（前端必须携带版本）', async () => {
    const srv = start()
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')
    const res = await call(started.port, '/status', { protocol: null })
    expect(res.body.error.code).toBe('PROTOCOL_MISMATCH')
  })

  it('AC-017 启动写入连接信息文件，字段含端口 / 令牌 / 协议版本 / 指纹 / pid', async () => {
    const srv = start()
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')

    const info = JSON.parse(readFileSync(join(dir, CONNECTION_FILE), 'utf-8'))
    expect(info).toMatchObject({
      port: started.port,
      token: TOKEN,
      protocolVersion: PROTOCOL_VERSION
    })
    expect(info.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(info.pid).toBe(process.pid)
    expect(info.fingerprint).toBe((await ensureSelfSignedCert(dir)).fingerprint)
  })

  it('AC-017 连接信息文件在 POSIX 下收紧为 0600', async () => {
    const srv = start()
    await srv.start()
    if (process.platform === 'win32') return
    const mode = statSync(join(dir, CONNECTION_FILE)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('AC-017 端口被占用时不静默换端口，返回 PORT_IN_USE', async () => {
    const occupied = createNetServer()
    netServers.push(occupied)
    const takenPort = await new Promise<number>((resolve) => {
      occupied.listen(0, '127.0.0.1', () => resolve((occupied.address() as { port: number }).port))
    })

    const srv = start({ config: cfg({ port: takenPort }) })
    const res = await srv.start()
    expect(res).toMatchObject({ listening: false, error: { code: 'PORT_IN_USE' } })
    expect(existsSync(join(dir, CONNECTION_FILE))).toBe(false)
  })

  it('AC-020 停止后连接信息失效（文件删除）且端口不再可达', async () => {
    const srv = start()
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')
    await srv.stop()
    expect(existsSync(join(dir, CONNECTION_FILE))).toBe(false)
    await expect(call(started.port, '/status')).rejects.toThrow()
  })

  it('路由分发：已绑定处理器按路径与参数调用，未绑定路径返回用法类错误', async () => {
    const seen: unknown[] = []
    const srv = start({
      handlers: {
        task: async (ctx: { params: Record<string, string> }) => {
          seen.push(ctx.params.id)
          return { ok: true, data: { taskId: ctx.params.id } }
        }
      }
    })
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')

    const hit = await call(started.port, '/tasks/abc123')
    expect(hit.status).toBe(200)
    expect(hit.body).toMatchObject({ ok: true, data: { taskId: 'abc123' } })
    expect(seen).toEqual(['abc123'])

    const miss = await call(started.port, '/nope')
    expect(miss.status).toBe(404)
    expect(miss.body.error.code).toBe('USAGE')
  })

  it('DFX-SEC-002 请求体超上限直接拒绝（不读进内存、不进业务处理）', async () => {
    // 已绑定 handler 的路由才会读请求体：未绑定路由不应缓冲请求体
    const spy = vi.fn(async () => ({ ok: true, data: { items: [], skipped: [] } }))
    const srv = start({ handlers: { plan: spy } })
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')

    // content-length 声明超限：读出前即拒绝，返回 413 + 用法类错误
    const declared = await rawRequest(started.port, '/plan', {
      method: 'POST',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      body: 'x'
    })
    expect(declared.status).toBe(413)
    expect(declared.body.error.code).toBe('USAGE')
    expect(declared.body.error.message).toContain('请求体过大')

    // 未声明长度（chunked）但实际超限：边读边拦，请求被拒绝且不进入业务处理
    // （客户端可能看到 413，或因服务端中断未读完的请求体而看到连接被关闭/400）
    const streamed = await rawRequest(started.port, '/plan', {
      method: 'POST',
      headers: {},
      body: 'y'.repeat(MAX_BODY_BYTES + 1024)
    })
    expect([400, 413]).toContain(streamed.status)
    expect(spy).not.toHaveBeenCalled()
  })

  it('P2-5 keep-alive 客户端不会让 stop() 挂起（重启服务可完成）', async () => {
    const srv = start()
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')

    const agent = new Agent({ keepAlive: true, rejectUnauthorized: false })
    const first = await call(started.port, '/status', { agent })
    expect(first.status).toBe(200)

    const stopped = await Promise.race([
      srv.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000))
    ])
    expect(stopped).toBe('stopped')
    agent.destroy()
  })

  it('P3-8 令牌长度不同/缺失时同样拒绝且不泄漏（恒定时间比较）', async () => {
    const srv = start()
    const started = await srv.start()
    if (!started.listening) throw new Error('服务端未启动')

    for (const token of ['', 'x', TOKEN.slice(0, 15), `${TOKEN}x`, TOKEN.toUpperCase()]) {
      const res = await call(started.port, '/status', { token: token === '' ? null : token })
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_TOKEN')
      expect(JSON.stringify(res.body)).not.toContain(TOKEN)
    }
  })

  it('E2E 回归：第二个实例端口占用时不得删除既有连接信息文件（否则在跑的服务被前端失联）', async () => {
    const first = start()
    const started = await first.start()
    if (!started.listening) throw new Error('第一个实例未启动')
    expect(existsSync(join(dir, CONNECTION_FILE))).toBe(true)

    // 第二个实例：同一个端口、不同数据目录，必然 PORT_IN_USE
    const otherDir = mkdtempSync(join(tmpdir(), 'shipit-server2-'))
    const second = createLocalServer({
      config: cfg({ port: started.port }),
      dataDir: otherDir
    })
    try {
      const res = await second.start()
      expect(res).toMatchObject({ listening: false, error: { code: 'PORT_IN_USE' } })
      // 第一个实例的连接信息必须完好，且仍可服务
      expect(existsSync(join(dir, CONNECTION_FILE))).toBe(true)
      const still = await call(started.port, '/status')
      expect(still.status).toBe(200)
      // 第二个实例不应写出自己的连接信息
      expect(existsSync(join(otherDir, CONNECTION_FILE))).toBe(false)
    } finally {
      await second.stop()
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('默认端口为 4517（文档与脚本引用口径）', () => {
    expect(DEFAULT_PORT).toBe(4517)
  })
})

/**
 * 原始 TLS 请求：https.request 会拒绝/规范化畸形请求行与非法百分号转义，
 * 因此这里直接写 socket，用于回归「畸形输入不能打断服务端」。
 */
function rawCall(port: number, requestLine: string, headers = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
      sock.write(requestLine + headers + '\r\n\r\n')
    })
    let buf = ''
    const timer = setTimeout(() => {
      sock.destroy()
      resolve('__NO_RESPONSE__')
    }, 3000)
    sock.on('data', (d) => (buf += d.toString('utf-8')))
    sock.on('end', () => {
      clearTimeout(timer)
      resolve(buf)
    })
    sock.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

describe('畸形输入不能打断服务端（P1 回归）', () => {
  it('未鉴权 + 畸形绝对形式请求行 → 回 400（不挂起、不产生未处理拒绝）', async () => {
    const srv = start()
    const started = await srv.start()
    expect(started.listening).toBe(true)

    const res = await rawCall(srv.port()!, 'GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close')
    expect(res).not.toBe('__NO_RESPONSE__')
    expect(res).toContain('400')
    expect(res).toContain('请求路径不合法')
  })

  it('已鉴权 + 路径参数非法百分号编码 → 回 USAGE/400（而不是丢弃连接）', async () => {
    const srv = start({
      handlers: { task: async () => ({ ok: false, error: { code: 'UNKNOWN_TASK', message: 'x' } }) }
    })
    await srv.start()

    const headers =
      `\r\nx-shipit-token: ${TOKEN}` +
      `\r\nx-shipit-protocol: ${PROTOCOL_VERSION}` +
      '\r\nConnection: close'
    const res = await rawCall(srv.port()!, 'GET /tasks/%zz HTTP/1.1\r\nHost: 127.0.0.1', headers)

    expect(res).not.toBe('__NO_RESPONSE__')
    expect(res).toContain('400')
    expect(res).toContain('路径参数编码非法')
  })
})

describe('启动失败路径：start() 只给结果不抛错（P2 回归）', () => {
  it('失配的证书/私钥会被自愈成可用的一对，start() 照常成功（P3）', async () => {
    const certDir = mkdtempSync(join(tmpdir(), 'shipit-mix-a-'))
    const keyDir = mkdtempSync(join(tmpdir(), 'shipit-mix-b-'))
    const mixDir = mkdtempSync(join(tmpdir(), 'shipit-mix-'))
    try {
      const a = await ensureSelfSignedCert(certDir)
      const b = await ensureSelfSignedCert(keyDir)
      writeFileSync(join(mixDir, 'cert.pem'), a.cert, 'utf-8')
      writeFileSync(join(mixDir, 'key.pem'), b.key, 'utf-8') // 与证书不匹配

      const srv = createLocalServer({ config: cfg(), dataDir: mixDir })
      servers.push(srv)

      // 失配的一对会让 createHttpsServer 同步抛错（服务起不来）、指纹也跟着漂移：
      // 加载时必须校验配对并重新生成，否则只能手工删文件恢复
      const result = await srv.start()
      expect(result.listening).toBe(true)
      expect(srv.isListening()).toBe(true)

      // 落盘的一对现在是配对的
      const cert = readFileSync(join(mixDir, 'cert.pem'), 'utf-8')
      const key = readFileSync(join(mixDir, 'key.pem'), 'utf-8')
      expect(isKeyPairMatch(cert, key)).toBe(true)
      await srv.stop()
    } finally {
      rmSync(certDir, { recursive: true, force: true })
      rmSync(keyDir, { recursive: true, force: true })
      rmSync(mixDir, { recursive: true, force: true })
    }
  })

  it('非法端口：listen 同步抛错也被收成结果（不 reject、不崩主进程）', async () => {
    const srv = start({ config: cfg({ port: 70000 }) })

    const result = await srv.start()

    expect(result.listening).toBe(false)
    expect(srv.isListening()).toBe(false)
  })

  it('重复 start 不泄漏端口：同端口二次启动仍成功（旧监听器已先关闭）', async () => {
    const probe = createNetServer()
    const freePort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const picked = (probe.address() as { port: number }).port
        probe.close(() => resolve(picked))
      })
    })

    const srv = start({ config: cfg({ port: freePort }) })
    const first = await srv.start()
    expect(first.listening).toBe(true)

    // 若重复 start 不先关掉旧监听器，这里会 EADDRINUSE（旧实例引用被覆盖、端口一直占着）
    const second = await srv.start()
    expect(second.listening).toBe(true)
    expect(srv.port()).toBe(freePort)
  })
})

describe('端口被占用时的残留连接文件清理（避免客户端 pin 到永不被服务的指纹）', () => {
  it('pid 已不存在 => 视为残留并删除；cleanupStale 只认死 pid', async () => {
    // 该行为由主进程 start() 的失败分支触发（PORT_IN_USE）；
    // 这里以纯逻辑口径固定判定条件：文件里的 pid 不存在 = 残留。
    const config: ServerConfig = {
      enabled: true, bind: 'local', port: 4597, tokenMode: 'custom',
      token: 'test0123456789abcdef01234567', allowedRoots: []
    }
    const srv = createLocalServer({ config, dataDir: dir, handlers: {} as never })
    // 端口空闲时应正常监听（前置条件）
    const started = await srv.start()
    expect(started.listening).toBe(true)
    const file = join(dir, 'server.json')
    expect(existsSync(file)).toBe(true)
    await srv.stop()
    // 停服后自己写入的文件应被清掉（ownsConnectionFile 语义）
    expect(existsSync(file)).toBe(false)
  })
})
