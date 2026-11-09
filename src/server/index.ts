/**
 * 后端进程入口。
 *
 * stdout 只用于控制消息（每行一个 JSON，带 type）：
 * - `ready`：启动握手（含管理端点与宿主 token）
 * - `state`：端点状态变化（公开端点启停、bind 变更）
 * - `fatal`：启动失败
 */
import { dirname } from 'path'
import { PROTOCOL_VERSION } from '../shared/cli-contract'
import { createEventHub } from './events'
import { buildAdminHandlers } from './route-handlers'
import { createRuntime, type Runtime } from './runtime'

interface ServerArgs {
  config: string
  appVersion: string
  dataDir: string
  parentPid?: number
}

export function parseArgs (argv: string[]): ServerArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const config = get('config')
  if (!config) throw new Error('缺少 --config <配置文件路径>')
  const parentPid = Number(get('parent-pid'))
  return {
    config,
    appVersion: get('app-version') ?? 'unknown',
    dataDir: get('data-dir') ?? dirname(config),
    ...(Number.isInteger(parentPid) && parentPid > 0 ? { parentPid } : {})
  }
}

function sendLine (message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

let runtime: Runtime | null = null
let closing = false

async function shutdown (phase: 'prepare' | 'final' | 'force', deadlineMs: number): Promise<void> {
  if (closing && phase !== 'prepare') return
  const result = (await runtime?.shutdown(phase, deadlineMs)) ?? { drained: true }
  if ((result as { drained?: boolean }).drained || phase === 'force') {
    closing = true
    await runtime?.finalize().catch(() => undefined)
    process.exit(0)
  }
}

async function main (): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  runtime = createRuntime({ configPath: args.config, appVersion: args.appVersion, dataDir: args.dataDir })
  const hub = createEventHub()

  // ready 必须早于任何 state：启动监听会 emit server.state，先缓冲
  let readySent = false
  const pending: unknown[] = []
  runtime.onEvent((event, data) => {
    hub.emit(event, data)
    if (event !== 'server.state') return
    const line = { type: 'state', instanceId: runtime!.instanceId, data }
    if (readySent) sendLine(line)
    else pending.push(line)
  })
  runtime.setExtraHandlers(buildAdminHandlers(runtime, hub))

  const started = await runtime.startAdminListener()
  if (!started.listening) {
    sendLine({ type: 'fatal', message: started.error?.message ?? '管理端点启动失败' })
    process.exit(1)
  }

  sendLine({
    type: 'ready',
    instanceId: runtime.instanceId,
    admin: { port: runtime.adminPort(), token: runtime.adminToken(), fingerprint: runtime.adminFingerprint() },
    version: args.appVersion,
    protocolVersion: PROTOCOL_VERSION
  })
  readySent = true
  for (const line of pending) sendLine(line)
  pending.length = 0

  // 公开端点：按 enabled 启停；失败只影响公开能力
  await runtime.syncPublicListener()

  // 生命线：utilityProcess 不支持 stdin，用父进程 PID 探测
  if (args.parentPid) {
    const parentPid = args.parentPid
    setInterval(() => {
      try {
        process.kill(parentPid, 0)
      } catch {
        void shutdown('force', 0)
      }
    }, 1000).unref()
  }

  process.on('SIGTERM', () => void shutdown('force', 0))
  process.on('SIGINT', () => void shutdown('force', 0))
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[shipit-server] ${error.stack ?? error}\n`)
    void shutdown('force', 0)
  })
  process.on('unhandledRejection', (error) => {
    process.stderr.write(`[shipit-server] unhandledRejection: ${String(error)}\n`)
  })
}

main().catch((error) => {
  sendLine({ type: 'fatal', message: `启动异常：${error?.message ?? String(error)}` })
  process.exit(1)
})
