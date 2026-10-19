/**
 * CLI / MCP 前端共用的 HTTPS 客户端。
 *
 * - 只通过连接发现得到的端口与令牌建连，不接受裸端口与裸令牌（CON-7）。
 * - 通道为 TLS 自签：客户端固定指纹，不匹配即拒绝（AC-027 / INV-11）。
 * - 发送前本地校验协议版本，服务端也会校验（INV-8，两端各自把关）。
 * - 不重试、不降级为本地执行；后端不可用直接返回环境类错误（INV-2 / DFX-REL-004）。
 */
import { Agent as HttpsAgent, request as httpsRequest } from 'https'
import type { TLSSocket } from 'tls'
import {
  errEnvelope,
  HEADER,
  PROTOCOL_VERSION,
  type ClientKind,
  type Envelope,
  type ErrorCode
} from '../shared/cli-contract'
import { matchesFingerprint } from '../shared/fingerprint'
import type { DiscoveredConnection } from './discover'

export interface ClientError {
  code: ErrorCode
  message: string
  hint?: string
}

export type ClientResult = { ok: true; envelope: Envelope } | { ok: false; error: ClientError }

/** 响应信封形状粗校验（只认 ok 字段的有无与布尔类型） */
function looksLikeEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false
  const ok = (value as { ok?: unknown }).ok
  return ok === true || ok === false
}

export interface ServerClientOptions {
  connection: DiscoveredConnection
  /** 调用方标识：cli / mcp（D-25） */
  client: ClientKind
  /** 请求超时（毫秒） */
  timeoutMs?: number
}

export interface ServerClient {
  get(path: string, query?: Query): Promise<ClientResult>
  post(path: string, body?: unknown, query?: Query): Promise<ClientResult>
  readonly connection: DiscoveredConnection
}

/** query 值域：布尔用于开关类参数（序列化时按 `String()` 落字面量） */
export type Query = Record<string, string | number | boolean | undefined>

const DEFAULT_TIMEOUT_MS = 30_000

function envFailure(message: string, hint?: string): ClientError {
  return hint ? { code: 'BACKEND_UNAVAILABLE', message, hint } : { code: 'BACKEND_UNAVAILABLE', message }
}

function normalizeFingerprint256(value?: string): string {
  return typeof value === 'string' ? value.replace(/:/g, '').toLowerCase() : ''
}

/** 由已发现的连接创建客户端 */
/**
 * 连接级 TLS 状态。
 *
 * **必须关闭会话复用**（`maxCachedSessions: 0`）：默认 `https.globalAgent` 会缓存 TLS session；
 * 服务端关掉空闲连接后，下一次连接会走 session resumption —— 此时服务端**不再下发证书**，
 * `getPeerCertificate()` 返回空对象 → 指纹算成 '' → 被误判为"指纹不一致"（实测：空闲后第一次调用必失败、
 * 紧接着重试成功）。
 *
 * `verifiedSockets`：记录**已验证过**的 socket。keep-alive 复用同一 socket 时无需再验（也拿不到新证书）。
 */
const fingerprintAgents = {
  keepAlive: new HttpsAgent({ keepAlive: true, maxCachedSessions: 0 }),
  // 兜底：连 keepAlive 也关，用于"没拿到证书"时强制一次**完整握手**
  fresh: new HttpsAgent({ keepAlive: false, maxCachedSessions: 0 })
}
const verifiedSockets = new WeakSet<object>()

export function createServerClient(options: ServerClientOptions): ServerClient {
  const { connection, client } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  function send(method: 'GET' | 'POST', path: string, body?: unknown, query?: Query): Promise<ClientResult> {
    // 处理前本地把关协议版本（INV-8）
    if (connection.protocolVersion !== PROTOCOL_VERSION) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'PROTOCOL_MISMATCH',
          message: `协议版本不一致：连接信息为 ${connection.protocolVersion}，当前前端为 ${PROTOCOL_VERSION}`,
          hint: '请使用与桌面版同版本的 CLI / MCP 包'
        }
      })
    }

    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') search.append(key, String(value))
    }
    const fullPath = search.size > 0 ? `${path}?${search.toString()}` : path
    const payload = body === undefined ? undefined : JSON.stringify(body)

    return new Promise<ClientResult>((resolve) => {
      let settled = false
      const finish = (result: ClientResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }

      // 头值只接受 latin-1 可见字符：非法字符（换行/中文等）会让 Node 在构造请求时**同步抛**
      // ERR_INVALID_CHAR —— 那是 Promise 之外抛出的裸异常，会绕过"任何失败都是信封"的约定。
      const badToken = /[^\x21-\x7e]/.test(connection.token)
      if (badToken) {
        finish({
          ok: false,
          error: envFailure(
            '令牌含非法字符（只允许可打印 ASCII）',
            '请重新复制桌面版「导出连接串」的内容（注意不要带入换行/中文）'
          )
        })
        return
      }

      const where = connection.host && connection.host.length > 0
        ? `${connection.host}:${connection.port}`
        : `127.0.0.1:${connection.port}`
      const sourceText =
        connection.source === 'connect'
          ? '连接串（--connect）'
          : connection.source === 'profile'
            ? `已保存的连接配置${connection.file ? `（${connection.file}）` : ''}`
            : `连接信息文件${connection.file ? `（${connection.file}）` : ''}`

      let attemptNo = 0
      const attempt = (agent: HttpsAgent): void => {
        attemptNo += 1
        let fingerprintMismatch = false
        let actualFingerprint = ''
        let noCertificate = false
        // 指纹校验通过前**不写出请求**：`rejectUnauthorized:false` 下 TLS 握手必然成功，
        // 若先写出，令牌头可能已经送进一个伪造端点（--connect 指向远端被劫持的场景）
        let flushed = false
        const flush = (): void => {
          if (flushed) return
          flushed = true
          if (payload) req.write(payload)
          req.end()
        }

        const req = httpsRequest(
          {
            host: connection.host && connection.host.length > 0 ? connection.host : '127.0.0.1',
            port: connection.port,
            path: fullPath,
            method,
            // 自签证书不被系统信任，信任锚点由固定指纹承担（下方 secureConnect 校验）
            rejectUnauthorized: false,
            timeout: timeoutMs,
            agent,
            headers: {
              [HEADER.token]: connection.token,
              [HEADER.protocol]: String(PROTOCOL_VERSION),
              [HEADER.client]: client,
              ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
            }
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => chunks.push(chunk as Buffer))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf-8')
              let parsed: unknown
              try {
                parsed = JSON.parse(text)
              } catch {
                finish({ ok: false, error: envFailure('服务端返回无法解析的响应', `HTTP ${res.statusCode ?? 0}`) })
                return
              }
              // 形状粗校验：同端口上若是别的 HTTPS 服务，缺 ok 字段会让下游解构时崩（被兜成 BACKEND_UNAVAILABLE 更难排查）
              if (!looksLikeEnvelope(parsed)) {
                finish({ ok: false, error: envFailure('服务端返回的不是 ShipIt 信封', '请确认端口上运行的是本桌面版服务端') })
                return
              }
              finish({ ok: true, envelope: parsed })
            })
          }
        )

        req.on('socket', (socket) => {
          const tls = socket as TLSSocket
          const verifyThenFlush = (): void => {
            // 同一个 socket 上之前已经验证过（keep-alive 复用）→ 无需再验，直接发
            if (verifiedSockets.has(tls)) {
              flush()
              return
            }
            const cert = tls.getPeerCertificate?.()
            const actual = normalizeFingerprint256(cert?.fingerprint256)
            if (actual === '') {
              // **没拿到证书** ≠ 指纹不一致：
              // 只有"看到了另一张证书"才算不一致；空证书通常是 TLS 会话复用（服务端未下发）。
              // 这里换新连接重试一次（agent 已关闭会话缓存，会走完整握手拿证书）。
              noCertificate = true
              tls.destroy(new Error('未取得服务端证书'))
              return
            }
            if (!matchesFingerprint(connection.fingerprint, actual)) {
              fingerprintMismatch = true
              actualFingerprint = actual
              tls.destroy(new Error('证书指纹不匹配'))
              return
            }
            verifiedSockets.add(tls)
            flush() // 指纹确认后才把请求（含令牌头）写出去
          }
          // keep-alive 复用既有连接时握手早就完成，不会再有 secureConnect 事件 —— 必须就地校验并发出，
          // 否则第二次之后的请求会一直卡到超时（默认 agent 是 keepAlive 的）
          // secureConnecting 是 Node 运行时属性（当前 @types/node 未声明），窄化读取
          const connecting = (tls as unknown as { secureConnecting?: boolean }).secureConnecting
          if (tls.encrypted === true && connecting === false) {
            verifyThenFlush()
            return
          }
          tls.once('secureConnect', verifyThenFlush)
        })

        req.on('timeout', () => {
          req.destroy(new Error('请求超时'))
        })

        req.on('error', (error: Error & { code?: string }) => {
          if (noCertificate) {
            // 第一次没拿到证书 → 用"完全不复用"的 agent 重试一次，强制完整握手
            if (attemptNo === 1) {
              attempt(fingerprintAgents.fresh)
              return
            }
            finish({
              ok: false,
              error: envFailure(
                `未能取得服务端证书（${where}）`,
                '该端口上的服务可能不是 ShipIt 桌面版，或连接在握手中被中断；请确认桌面版在运行且端口正确'
              )
            })
            return
          }
          if (fingerprintMismatch) {
            // 指纹不一致的**可操作化**：原来只说"指纹不一致、轮换后需重新取得"，
            // 用户既不知道这个指纹是从哪来的（连接文件 / profile / 连接串），
            // 也不知道该改哪里 —— 而"来源不同 → 修法完全不同"。
            const expected = normalizeFingerprint256(connection.fingerprint).slice(0, 8)
            const actualPrefix = actualFingerprint.slice(0, 8)
            const hint =
              connection.source === 'connect'
                ? '该连接串里的指纹已过期：请在桌面版「设置 → 本地服务」重新「导出连接串」，并更新宿主（opencode 等）的 MCP 配置'
                : connection.source === 'profile'
                  ? '该连接配置里的指纹已过期：请重新保存它（`shipit profile set <名称> …`），或改用本地自动发现（不传 --profile）'
                  : '可能有两种原因：① 连接信息文件已过期（桌面版被强杀过）→ 重启桌面版即可刷新；② 该端口被其他程序或其他桌面实例占用（指纹自然不同）→ 请确认端口上的服务就是当前桌面版'
            finish({
              ok: false,
              error: {
                code: 'TLS_MISMATCH',
                message: `服务端证书指纹与已固定指纹不一致，已拒绝连接（${where}）`,
                // 契约只允许 code/message/hint：把"来源与两侧指纹"并进 hint（用 ｜ 分隔，仍是一句话）
                hint: `${hint}｜指纹来源：${sourceText}；已固定 ${expected}…；服务端实际 ${actualPrefix}…`
              }
            })
            return
          }
          if (error.code === 'ETIMEDOUT' || /超时/.test(error.message)) {
            finish({ ok: false, error: envFailure('请求超时：桌面版可能未响应', '确认桌面版在运行且服务端已开启') })
            return
          }
          finish({
            ok: false,
            error: envFailure(
              `无法连接本地服务：${error.message}`,
              '请确认桌面版在运行且已开启本地服务（设置 → 本地服务端）'
            )
          })
        })
      }

      attempt(fingerprintAgents.keepAlive)
    })
  }

  return {
    connection,
    get: (path, query) => send('GET', path, undefined, query),
    post: (path, body, query) => send('POST', path, body, query)
  }
}

/** 客户端结果 → 统一信封：失败在本地映射为同一套错误类别与退出码语义 */
export function toEnvelope(result: ClientResult): Envelope {
  return result.ok ? result.envelope : errEnvelope(result.error.code, result.error.message, result.error.hint)
}
