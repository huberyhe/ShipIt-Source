/**
 * Electron 侧后端宿主：spawn 进程、读 ready、建管理客户端、订阅 SSE、两阶段退出。
 *
 * - 生产用 `utilityProcess.fork`，测试用 `child_process.fork`（同一入口产物）
 * - 生命周期控制消息按 `type` 解析，不依赖“首行”
 * - 对 renderer 输出的 revision 由本层做跨实例单调转换（后端重启后 revision 归零）
 */
import { fork, type ChildProcess } from 'child_process'
import * as https from 'https'
import { createHttpClient, type ClientResult, type HttpClient, type Query } from '../shared/http-client'

export interface ServerChild {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  kill(): void
  on(event: 'exit', listener: (code: number | null) => void): void
  readonly exitCode: number | null
}

export interface HostOptions {
  entry: string
  configPath: string
  appVersion: string
  dataDir: string
  /** 测试/开发：用 child_process.fork（无需 Electron） */
  useNodeFork?: boolean
}

export interface ServerHost {
  start(): Promise<{ instanceId: string; admin: { port: number; token: string; fingerprint: string }; version: string }>
  get(path: string, query?: Query): Promise<ClientResult>
  post(path: string, body?: unknown, timeoutMs?: number): Promise<ClientResult>
  on(event: string, fn: (data: unknown) => void): () => void
  prepareStop(deadlineMs?: number): Promise<ClientResult>
  finalizeStop(deadlineMs?: number): Promise<ClientResult>
  forceStop(): Promise<ClientResult>
  readonly child: ServerChild | null
  readonly instanceId: string | null
  readonly revision: number
}

/** 跨实例 revision 转换：旧实例迟到事件丢弃，新实例从当前计数继续递增 */
export function createRevisionBridge () {
  let instanceId: string | null = null
  let revision = 0
  return {
    setInstance (id: string) {
      instanceId = id
    },
    translate (incomingInstanceId: string, payloadRevision: number): { accepted: boolean; revision: number } {
      if (instanceId !== null && incomingInstanceId !== instanceId) return { accepted: false, revision }
      instanceId = incomingInstanceId
      revision = Math.max(revision + 1, payloadRevision)
      return { accepted: true, revision }
    },
    snapshot: () => ({ instanceId, revision })
  }
}

function forkChild (options: HostOptions, parentPid: number): ServerChild {
  const args = [
    '--config', options.configPath,
    '--app-version', options.appVersion,
    '--data-dir', options.dataDir,
    '--parent-pid', String(parentPid)
  ]
  if (options.useNodeFork) {
    return fork(options.entry, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }) as unknown as ServerChild & ChildProcess
  }
  // 延迟 require：测试环境（纯 Node）不加载 electron
  const { utilityProcess } = require('electron') as typeof import('electron')
  const child = utilityProcess.fork(options.entry, args, { stdio: 'pipe' }) as unknown as ServerChild
  // 后端 stderr 必须转发：否则启动失败时只能看到“等待 ready 超时”
  child.stderr?.on('data', (chunk: Buffer | string) => process.stderr.write(`[shipit-server] ${chunk}`))
  return child
}

function waitReady (child: ServerChild, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const seen: string[] = []
    const timer = setTimeout(
      () => reject(new Error(`等待 ready 超时；后端输出：${seen.slice(-5).join(' | ') || '(空)'}`)),
      timeoutMs
    )
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString()
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          seen.push(line.slice(0, 200))
          try {
            const message = JSON.parse(line)
            if (message.type === 'ready') {
              clearTimeout(timer)
              resolve(message)
            } else if (message.type === 'fatal') {
              clearTimeout(timer)
              reject(new Error(message.message))
            }
          } catch {
            // 忽略非 JSON 行
          }
        }
        index = buffer.indexOf('\n')
      }
    })
  })
}

export function createServerHost (options: HostOptions): ServerHost {
  let child: ServerChild | null = null
  let client: HttpClient | null = null
  let sseRequest: ReturnType<typeof https.get> | null = null
  let sseTimer: NodeJS.Timeout | null = null
  let stopped = false
  const handlers = new Map<string, Array<(data: unknown) => void>>()
  const bridge = createRevisionBridge()
  let admin: { port: number; token: string; fingerprint: string } | null = null

  function emit (event: string, data: unknown): void {
    for (const fn of handlers.get(event) ?? []) {
      try {
        fn(data)
      } catch {
        // 回调抛错不得击穿事件流
      }
    }
  }

  /** SSE 订阅：校验指纹（INV-11），断线 1s 重连 */
  function connectSse (): void {
    if (stopped || !admin) return
    const request = https.get({
      host: '127.0.0.1',
      port: admin.port,
      path: '/events',
      rejectUnauthorized: false,
      headers: {
        'x-shipit-token': admin.token,
        'x-shipit-protocol': '1',
        'x-shipit-client': 'desktop',
        'last-event-id': String(bridge.snapshot().revision)
      }
    }, (res) => {
      const socket = res.socket as import('tls').TLSSocket
      const actual = (socket.getPeerCertificate?.().fingerprint256 ?? '').replace(/:/g, '').toLowerCase()
      if (actual && actual !== admin!.fingerprint) {
        emit('tls-mismatch', { actual })
        res.destroy()
        return
      }

      let buffer = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const eventLine = /^event:\s*(.+)$/m.exec(frame)
          const dataLine = /^data:\s*(.+)$/m.exec(frame)
          if (eventLine && dataLine) {
            try {
              const payload = JSON.parse(dataLine[1])
              const instanceId = payload?.data?.instanceId ?? payload?.instanceId ?? bridge.snapshot().instanceId
              const revision = payload?.data?.revision ?? payload?.revision ?? bridge.snapshot().revision
              const translated = instanceId ? bridge.translate(instanceId, revision) : { accepted: true, revision: bridge.snapshot().revision }
              if (translated.accepted) emit(eventLine[1].trim(), payload.data ?? payload)
            } catch {
              // 忽略坏帧
            }
          }
          index = buffer.indexOf('\n\n')
        }
      })
      res.on('end', () => {
        if (!stopped) sseTimer = setTimeout(connectSse, 1000)
      })
    })
    request.on('error', () => {
      if (!stopped) sseTimer = setTimeout(connectSse, 1000)
    })
    sseRequest = request
  }

  return {
    get child () { return child },
    get instanceId () { return bridge.snapshot().instanceId },
    get revision () { return bridge.snapshot().revision },

    async start () {
      child = forkChild(options, process.pid)
      const ready = await waitReady(child, 8000)
      bridge.setInstance(ready.instanceId)
      admin = ready.admin
      client = createHttpClient({
        endpoint: {
          host: '127.0.0.1',
          port: ready.admin.port,
          token: ready.admin.token,
          fingerprint: ready.admin.fingerprint,
          protocolVersion: 1
        },
        client: 'desktop'
      })
      connectSse()
      return ready
    },

    get (path, query) {
      if (!client) return Promise.resolve({ ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: '后端未启动' } }) as Promise<ClientResult>
      return client.get(path, query)
    },

    post (path, body, timeoutMs) {
      if (!client) return Promise.resolve({ ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: '后端未启动' } }) as Promise<ClientResult>
      // 长请求（直连上传）显式覆盖超时；普通调用沿用默认 30s
      return timeoutMs ? client.postWithTimeout(path, body, timeoutMs) : client.post(path, body)
    },

    on (event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== fn))
      }
    },

    prepareStop (deadlineMs = 5000) {
      return this.post('/shutdown', { phase: 'prepare', deadlineMs })
    },

    finalizeStop (deadlineMs = 30000) {
      return this.post('/shutdown', { phase: 'final', deadlineMs })
    },

    forceStop () {
      return this.post('/shutdown', { phase: 'force' })
    }
  }
}
