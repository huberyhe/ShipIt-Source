/**
 * 本机（可选局域网）本地服务端。
 *
 * - 默认不监听（INV-4）：`config.enabled === false` 时 `start()` 直接返回未监听。
 * - 绑定范围决定可达面：`local` → 127.0.0.1；`lan` → 0.0.0.0。
 * - 通道统一 TLS 自签，证书指纹写入连接信息文件供前端固定（INV-11）。
 * - 鉴权靠令牌，协议版本必须一致（INV-8）；执行全部在桌面主进程（INV-2）。
 * - 令牌与凭据不进入输出与日志（INV-5）。
 */
import { timingSafeEqual } from 'crypto'
import { promises as fs } from 'fs'
import { createServer as createHttpsServer } from 'https'
import type { IncomingMessage, ServerResponse } from 'http'
import { join } from 'path'
import {
  HEADER,
  PROTOCOL_VERSION,
  type ClientKind,
  type Envelope,
  type ErrorCode
} from '../../shared/cli-contract'
import type { ServerConfig } from '../../shared/types'
import { ensureSelfSignedCert } from './tls-cert'

/** 连接信息文件名（前端零配置发现的唯一来源） */
export const CONNECTION_FILE = 'server.json'

/** 请求体上限（1 MB）：部署请求只带选择器与项目根，超出即视为异常输入，避免内存放大 */
export const MAX_BODY_BYTES = 1024 * 1024

/** 请求体超限标记（由 `readBody` 抛出，路由层映射为用法错误） */
class BodyTooLargeError extends Error {}

export type Origin = ClientKind | 'desktop'

export interface ConnectionInfo {
  port: number
  token: string
  protocolVersion: number
  fingerprint: string
  pid: number
}

export interface RequestContext {
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  /** 调用方标识：cli / mcp；桌面界面为内部调用，不带该头（D-25） */
  origin: Origin
  remoteAddress: string
}

export type RouteHandler = (ctx: RequestContext) => Promise<Envelope> | Envelope

export interface RouteDefinition {
  method: 'GET' | 'POST'
  /** 以 `:` 前缀的段落为路径参数 */
  path: string
  /** handlers 中的键名 */
  handler: keyof Handlers
}

export interface Handlers {
  status: RouteHandler
  projects: RouteHandler
  targets: RouteHandler
  testConnection: RouteHandler
  plan: RouteHandler
  deploy: RouteHandler
  gitStatus: RouteHandler
  gitLog: RouteHandler
  gitBranches: RouteHandler
  task: RouteHandler
}

export type StartResult =
  | { listening: true; port: number; bound: string; fingerprint: string }
  | { listening: false; error?: { code: ErrorCode; message: string } }

export interface LocalServer {
  start(): Promise<StartResult>
  stop(): Promise<void>
  isListening(): boolean
  /** 实际监听端口（未监听为 null） */
  port(): number | null
  /** 当前证书指纹（未监听为 null） */
  fingerprint(): string | null
  /** 连接信息文件路径 */
  connectionFilePath(): string
}

export interface LocalServerOptions {
  config: ServerConfig
  /** 用户数据目录：写证书与连接信息文件 */
  dataDir: string
  /** 可选处理器注入；未注入的路由视为未启用（后续任务逐个绑定） */
  handlers?: Partial<Handlers>
  /** 每次请求后回调（供界面日志与来源标注使用） */
  onRequest?: (info: { path: string; origin: Origin; remoteAddress: string; status: number; code?: ErrorCode }) => void
  /**
   * 监听建立之后的运行时错误回调（如连接层异常）。
   * 必须提供：未处理的 'error' 事件会直接终止主进程，而这时服务其实还在跑。
   */
  onError?: (error: Error) => void
}

/** 路由表。命令名与路径为兼容契约（CON-1），只允许追加。 */
export const ROUTES: readonly RouteDefinition[] = [
  { method: 'GET', path: '/status', handler: 'status' },
  { method: 'GET', path: '/projects', handler: 'projects' },
  { method: 'GET', path: '/targets', handler: 'targets' },
  { method: 'POST', path: '/test-connection', handler: 'testConnection' },
  { method: 'POST', path: '/plan', handler: 'plan' },
  { method: 'POST', path: '/deploy', handler: 'deploy' },
  { method: 'GET', path: '/git/status', handler: 'gitStatus' },
  { method: 'GET', path: '/git/log', handler: 'gitLog' },
  // 保留：CLI 子命令与 MCP 工具已下线（桌面走 IPC），但命令名/路径是兼容契约（CON-1 只允许追加）
  { method: 'GET', path: '/git/branches', handler: 'gitBranches' },
  { method: 'GET', path: '/tasks/:id', handler: 'task' }
]

/** 错误类别 → HTTP 状态码；未列出者按 200 + ok:false 信封返回，由前端按信封判定 */
const AUTH_ERRORS: readonly ErrorCode[] = ['INVALID_TOKEN']
const PROTOCOL_ERRORS: readonly ErrorCode[] = ['PROTOCOL_MISMATCH']

function httpStatusOf(code: ErrorCode): number {
  if (AUTH_ERRORS.includes(code)) return 401
  if (PROTOCOL_ERRORS.includes(code)) return 400
  if (code === 'USAGE') return 400
  return 200
}

/** 路由匹配结果：bad-param 表示路径参数百分号编码非法（客户端输入错误，回 400） */
type RouteMatch =
  | { ok: true; route: RouteDefinition; params: Record<string, string> }
  | { ok: false; reason: 'no-route' | 'bad-param' }

function matchRoute(method: string, pathname: string): RouteMatch {
  for (const route of ROUTES) {
    if (route.method !== method) continue
    const want = route.path.split('/')
    const got = pathname.split('/')
    if (want.length !== got.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 1; i < want.length; i++) {
      if (want[i].startsWith(':')) {
        // 非法百分号编码（如 /tasks/%zz）会抛 URIError：此处降级为客户端输入错误，
        // 绝不能让异常冒泡（否则请求永不响应 + 产生未处理拒绝，主进程可能被终止）
        try {
          params[want[i].slice(1)] = decodeURIComponent(got[i])
        } catch {
          return { ok: false, reason: 'bad-param' }
        }
      } else if (want[i] !== got[i]) {
        matched = false
        break
      }
    }
    if (matched) return { ok: true, route, params }
  }
  return { ok: false, reason: 'no-route' }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLargeError(`请求体超过上限 ${MAX_BODY_BYTES} 字节`)
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      // 主动断开：不把超大请求体读进内存
      throw new BodyTooLargeError(`请求体超过上限 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  if (!text) return undefined
  return JSON.parse(text) as unknown
}

/** 恒定时间比较令牌长度与内容，避免时序侧信道 */
function tokenMatches(expected: string, actual: string | null): boolean {
  if (!expected) return false
  if (actual === null) return false
  const a = Buffer.from(expected, 'utf-8')
  const b = Buffer.from(actual, 'utf-8')
  // 长度不同直接拒绝；长度相同再恒定时间比较
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 调用方来源判定：请求头 `x-shipit-client` 为 `cli` / `mcp` 时取该值，
 * 否则视为桌面界面内部调用（desktop）。不猜测、不合并为「前端」（D-25 / AC-037）。
 */
export function originOf(headers: { [key: string]: string | string[] | undefined }): Origin {
  const raw = headers[HEADER.client]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === 'cli' || value === 'mcp' ? value : 'desktop'
}

const headerValue = (req: IncomingMessage, name: string): string | null => {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0] ?? null
  return typeof v === 'string' ? v : null
}

export function createLocalServer(options: LocalServerOptions): LocalServer {
  const { config, dataDir } = options
  let server: ReturnType<typeof createHttpsServer> | null = null
  let activePort: number | null = null
  let activeFingerprint: string | null = null
  /**
   * 本实例是否写入了连接信息文件。
   * 只有写入者才有权在 stop() 时删除：否则第二个实例（端口被占用而启动失败）
   * 会删掉正在服务中的第一个实例的连接信息，令所有客户端立即失去连接。
   */
  let ownsConnectionFile = false
  const connectionFilePath = join(dataDir, CONNECTION_FILE)

  const fail = (
    res: ServerResponse,
    code: ErrorCode,
    message: string,
    hint?: string,
    statusOverride?: number
  ): void => {
    const env: Envelope = { ok: false, error: hint ? { code, message, hint } : { code, message } }
    send(res, statusOverride ?? httpStatusOf(code), env)
  }

  function send(res: ServerResponse, status: number, env: Envelope): void {
    const payload = JSON.stringify(env)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(payload)
  }

  /** 内置状态处理器：未注入时提供最小可用快照，注入则优先用注入实现（供后续任务扩展） */
  const builtinHandlers: Partial<Handlers> = {
    status: () => ({
      ok: true,
      data: {
        listening: activePort !== null,
        port: activePort,
        bound: config.bind === 'lan' ? '0.0.0.0' : '127.0.0.1',
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid
      }
    })
  }

  async function writeConnectionInfo(port: number, fingerprint: string): Promise<void> {
    const info: ConnectionInfo = {
      port,
      token: config.token,
      protocolVersion: PROTOCOL_VERSION,
      fingerprint,
      pid: process.pid
    }
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(connectionFilePath, JSON.stringify(info, null, 2), { encoding: 'utf-8', mode: 0o600 })
    // Windows 不保证 mode 生效，但 POSIX 下必须收紧（INV-5）
    await fs.chmod(connectionFilePath, 0o600).catch(() => undefined)
  }

  /**
   * 端口被占用导致启动失败时，清掉**残留**的连接信息文件。
   *
   * 残留判定：文件里的 `pid` 已不存在（写入它的进程早就没了）→ 它不属于任何存活实例。
   * 这类文件会让客户端 pin 一个永不被服务的指纹，报出误导性的 TLS_MISMATCH；
   * 清掉之后客户端会如实得到「服务未开启」，排查方向才对。
   * 反之 pid 存活（另一个桌面实例正在服务）时**不动它** —— 那是有效信息。
   */
  async function removeConnectionFileIfStale(): Promise<void> {
    try {
      const raw = await fs.readFile(connectionFilePath, 'utf-8')
      const info = JSON.parse(raw) as { pid?: unknown }
      const pid = typeof info.pid === 'number' ? info.pid : null
      if (pid === null) return
      let alive = false
      try {
        // signal 0 只做存在性探测，不真的发信号
        process.kill(pid, 0)
        alive = true
      } catch {
        alive = false
      }
      if (!alive) await fs.rm(connectionFilePath, { force: true })
    } catch {
      // 文件不存在 / 内容不是 JSON：都不是本函数的处理范围
    }
  }

  /**
   * 请求处理收口：任何未预期异常都必须变成响应，绝不允许 Promise 拒绝冒泡。
   *
   * 背景：主进程没有 unhandledRejection 兜底，一次未处理拒绝就可能终止整个桌面进程
   * （连带中断正在跑的上传）；而 `new URL`/百分号解码对畸形输入是会抛的。
   */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await handleRequest(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        if (!res.headersSent) {
          const env: Envelope = {
            ok: false,
            error: { code: 'BACKEND_UNAVAILABLE', message: `服务端处理失败：${message}` }
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(env))
        } else {
          res.end()
        }
      } catch {
        // 响应已不可写：忽略
      }
      options.onRequest?.({
        path: req.url ?? '',
        origin: originOf(req.headers),
        remoteAddress: req.socket.remoteAddress ?? '',
        status: 200,
        code: 'BACKEND_UNAVAILABLE'
      })
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remoteAddress = req.socket.remoteAddress ?? ''
    // 畸形请求行（如绝对形式 http://[::1）会让 new URL 抛 ERR_INVALID_URL：
    // 属客户端输入错误，回 400 而不是让异常冒泡
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'https://localhost')
    } catch {
      fail(res, 'USAGE', '请求路径不合法', undefined, 400)
      options.onRequest?.({ path: req.url ?? '', origin: originOf(req.headers), remoteAddress, status: 400, code: 'USAGE' })
      return
    }
    const origin = originOf(req.headers)
    const report = (status: number, code?: ErrorCode): void =>
      options.onRequest?.({ path: url.pathname, origin, remoteAddress, status, code })

    // 1) 鉴权（先于协议版本，避免未授权方探测协议）
    const token = headerValue(req, HEADER.token)
    if (!tokenMatches(config.token, token)) {
      fail(res, 'INVALID_TOKEN', '鉴权失败：令牌缺失或不正确', '请在桌面版设置中查看或重新生成令牌')
      report(401, 'INVALID_TOKEN')
      return
    }

    // 2) 协议版本（INV-8）：所有接口（含 /status）都必须带对版本 —— 这是既有契约，不豁免。
    // 但提示里同时给出**服务端版本与请求版本**：否则调用方只看到"期望 1"，
    // 在"版本不匹配正是最需要诊断"的场景下反而拿不到关键信息。
    const protocol = headerValue(req, HEADER.protocol)
    if (protocol !== String(PROTOCOL_VERSION)) {
      fail(
        res,
        'PROTOCOL_MISMATCH',
        `协议版本不一致：服务端 ${PROTOCOL_VERSION}，请求 ${protocol ?? '(缺失)'}`,
        `请使用与桌面版同版本的 CLI/MCP（期望 ${PROTOCOL_VERSION}）`
      )
      report(400, 'PROTOCOL_MISMATCH')
      return
    }

    // 3) 路由
    const hit = matchRoute(req.method ?? 'GET', url.pathname)
    if (!hit.ok) {
      const badParam = hit.reason === 'bad-param'
      fail(
        res,
        'USAGE',
        badParam ? '路径参数编码非法' : `未知接口：${req.method ?? 'GET'} ${url.pathname}`,
        undefined,
        badParam ? 400 : 404
      )
      report(badParam ? 400 : 404, 'USAGE')
      return
    }
    const handler = options.handlers?.[hit.route.handler] ?? builtinHandlers[hit.route.handler]
    if (!handler) {
      fail(res, 'USAGE', `接口未启用：${req.method ?? 'GET'} ${url.pathname}`, undefined, 404)
      report(404, 'USAGE')
      return
    }

    let body: unknown
    try {
      body = await readBody(req)
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError
      const message = error instanceof Error ? error.message : String(error)
      fail(res, 'USAGE', tooLarge ? `请求体过大：${message}` : '请求体不是合法 JSON', undefined, tooLarge ? 413 : 400)
      report(tooLarge ? 413 : 400, 'USAGE')
      return
    }

    const ctx: RequestContext = {
      method: req.method ?? 'GET',
      path: url.pathname,
      params: hit.params,
      query: url.searchParams,
      body,
      origin,
      remoteAddress
    }

    try {
      const env = await handler(ctx)
      const status = env.ok ? 200 : httpStatusOf(env.error.code)
      send(res, status, env)
      report(status, env.ok ? undefined : env.error.code)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fail(res, 'BACKEND_UNAVAILABLE', `服务端处理失败：${message}`)
      report(200, 'BACKEND_UNAVAILABLE')
    }
  }

  return {
    async start(): Promise<StartResult> {
      if (!config.enabled) return { listening: false }

      // 重入保护：同实例重复 start 前先停掉既有监听器；否则旧引用被覆盖、
      // 监听器无人回收，端口会一直被占用到进程退出。
      if (server) await this.stop()

      const host = config.bind === 'lan' ? '0.0.0.0' : '127.0.0.1'
      let tls: Awaited<ReturnType<typeof ensureSelfSignedCert>>
      try {
        tls = await ensureSelfSignedCert(dataDir)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { listening: false, error: { code: 'BACKEND_UNAVAILABLE', message: `证书生成失败：${message}` } }
      }

      const listening = await new Promise<StartResult>((resolve) => {
        try {
          const srv = createHttpsServer({ cert: tls.cert, key: tls.key }, (req, res) => {
            // handle 内部已整体收口；这里再兜一层，确保任何遗漏都不会变成未处理拒绝
            void handle(req, res).catch(() => {
              try {
                if (!res.headersSent) res.writeHead(500).end()
              } catch {
                // 忽略：连接已断开
              }
            })
          })
          const onStartError = (error: NodeJS.ErrnoException): void => {
            const code: ErrorCode = error.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'BACKEND_UNAVAILABLE'
            const message =
              code === 'PORT_IN_USE'
                ? `端口 ${config.port} 已被占用，请改用其他端口`
                : `本地服务启动失败：${error.message}`
            resolve({ listening: false, error: { code, message } })
          }
          srv.once('error', onStartError)
          srv.listen(config.port, host, () => {
            // 启动成功后必须摘掉启动期监听：否则它会首先「吃掉」一次运行时错误
            // （resolve 已 settle，等于把它吞掉），换成长驻错误监听才如实上报
            srv.removeListener('error', onStartError)
            srv.on('error', (error: Error) => options.onError?.(error))
            const address = srv.address()
            const port = typeof address === 'object' && address ? address.port : config.port
            resolve({ listening: true, port, bound: host, fingerprint: tls.fingerprint })
          })
          server = srv
        } catch (error) {
          // createHttpsServer（证书/私钥损坏或失配）与 listen（非法端口/主机名）都是**同步抛**。
          // 必须转成 StartResult 返回，绝不能让 start() reject：调用方依赖结果才能提示原因并刷新状态。
          const message = error instanceof Error ? error.message : String(error)
          resolve({ listening: false, error: { code: 'BACKEND_UNAVAILABLE', message: `本地服务启动失败：${message}` } })
        }
      })

      if (!listening.listening) {
        // 启动失败（端口占用等）：只清理自己的监听器，绝不删除**存活实例**的连接信息文件。
        // 但若那个文件是残留（写入它的进程已不存在），它只会误导客户端：
        // 客户端会 pin 一个永远不会被服务的指纹 → 报"证书指纹不一致"（真实原因是"服务没开/端口被别人占"）。
        if (listening.error?.code === 'PORT_IN_USE') await removeConnectionFileIfStale()
        await this.stop()
        return listening
      }

      activePort = listening.port
      activeFingerprint = listening.fingerprint

      try {
        await writeConnectionInfo(listening.port, listening.fingerprint)
        ownsConnectionFile = true
      } catch (error) {
        // 连接信息文件不可写 → 界面提示且服务端不启动（spec 连接信息契约）
        const message = error instanceof Error ? error.message : String(error)
        await this.stop()
        return {
          listening: false,
          error: { code: 'BACKEND_UNAVAILABLE', message: `连接信息文件不可写：${message}` }
        }
      }

      return listening
    },

    async stop(): Promise<void> {
      const srv = server
      server = null
      activePort = null
      activeFingerprint = null
      // 仅删除本实例写入的连接信息文件（启动失败或非本实例所有时不动它）
      if (ownsConnectionFile) {
        ownsConnectionFile = false
        await fs.rm(connectionFilePath, { force: true }).catch(() => undefined)
      }
      if (!srv) return
      await new Promise<void>((resolve) => {
        // close() 只停止接受新连接并等待既有连接结束；keep-alive 客户端会让它一直不回调。
        // 因此先主动关闭空闲连接，再强制关闭滞留连接，保证 stop() 一定能在有限时间内完成。
        srv.close(() => resolve())
        srv.closeIdleConnections()
        srv.closeAllConnections()
      })
    },

    isListening(): boolean {
      return server !== null && activePort !== null
    },

    port(): number | null {
      return activePort
    },

    fingerprint(): string | null {
      return activeFingerprint
    },

    connectionFilePath(): string {
      return connectionFilePath
    }
  }
}
