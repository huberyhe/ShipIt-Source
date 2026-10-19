/**
 * CLI 入口。
 *
 * 负责：解析参数 → 连接发现 → 建客户端 → 分发命令 → 输出信封与退出码。
 * 命令实现按任务分批落地（目标/连接校验、plan、deploy、status/task、git 查询、mcp）。
 */
import { type Envelope, type ErrorCode } from '../shared/cli-contract'
import { helpText, parse, PROJECT_REQUIRED_COMMANDS, type ParsedArgs } from './args'
import { discoverConnection, type DiscoverOptions, type DiscoveredConnection } from './discover'
import { createServerClient, type ServerClient } from './client'
import { commandKey, resolveCommand, resolveTextRenderer } from './registry'
import { emit, fail, ok } from './output'
import { checkServerReady } from './preflight'
import { packageVersion } from './version'
// 引入命令实现（各自在模块内登记）；新增命令只需扩展 commands/index.ts
import './commands'

export interface CliIo {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export interface CliDeps {
  /** 便于测试注入；缺省读取 process.env */
  env?: Record<string, string | undefined>
  io?: CliIo
  /** 便于测试注入客户端工厂 */
  createClient?: (connection: DiscoveredConnection) => ServerClient
}

export type { CommandContext, CommandHandler } from './registry'

/** 需要先建连（需要服务端）的命令；help 不建连 */
/**
 * 本地用法拦截：需要项目根的命令若没给 `--project`，就地报用法错误。
 *
 * 与命令处理器内的 `requireProject` 同源语义（那里是权威）；这里提前拦是为了
 * 不因"桌面没开"把"参数写错"盖过去，也省掉一次无意义的预检往返。
 */
function localUsageGuard(args: ParsedArgs): Envelope | null {
  const key = args.action ? `${args.command} ${args.action}` : String(args.command)
  if (!PROJECT_REQUIRED_COMMANDS.includes(key)) return null
  if (args.project && args.project.trim().length > 0) return null
  return fail('USAGE', `命令 ${key} 需要 --project <项目根>`, '可用 `shipit projects list` 查看桌面当前已打开的项目')
}

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.io?.stdout ?? ((text: string): void => {
    process.stdout.write(`${text}\n`)
  })
  const err = deps.io?.stderr ?? ((text: string): void => {
    process.stderr.write(`${text}\n`)
  })

  const parsed = parse(argv)
  if (parsed.error) {
    return emit(fail(parsed.error.code, parsed.error.message, parsed.error.hint), {
      json: parsed.json,
      stdout: out,
      stderr: err
    })
  }
  if (parsed.command === 'help') {
    // --help 与 -h 会在解析阶段提前返回，这里直接从原始 argv 判断输出模式
    const jsonMode = argv.includes('--json') || parsed.json
    return emitHelp(jsonMode, parsed.helpGroup, out, err)
  }

  if (parsed.command === 'mcp') {
    // MCP 走 stdio：stdout 必须只承载协议消息，因此不经信封输出通道
    const { runMcpServer } = await import('./mcp')
    // 预检失败时以非零码退出（宿主据此判定服务未就绪）；
    // 诊断走 CLI 的 stderr 通道（不绕过可注入 IO，便于测试与嵌入式调用）
    return await runMcpServer(deps.env ?? process.env, argv, { stderr: err })
  }

  // 本地用法错误**先于连接发现**：桌面没开时不该把"参数写错"盖成 BACKEND_UNAVAILABLE
  // （此前顺序相反：漏 --project 在无连接信息时报环境错误、有连接信息时报用法错误，退出码在 3/1 之间漂移）
  const localUsage = localUsageGuard(parsed)
  if (localUsage) return emit(localUsage, { json: parsed.json, stdout: out, stderr: err })

  // 连接发现：失败即环境类错误（不猜测、不降级执行）
  const discoverOptions: DiscoverOptions = {
    env: deps.env ?? process.env,
    args: argv
  }
  const discovered = discoverConnection(discoverOptions)
  if (!discovered.ok) {
    return emit(fail(discovered.error.code, discovered.error.message, discovered.error.hint), {
      json: parsed.json,
      stdout: out,
      stderr: err
    })
  }

  // 建客户端与预检都可能在极端输入下抛错（注入式 createClient、连接串字符集等）：
  // 统一兜成 BACKEND_UNAVAILABLE 信封，不让异常越过 runCli 变成裸栈 + 未处理拒绝。
  let client
  try {
    client = deps.createClient
      ? deps.createClient(discovered.connection)
      : createServerClient({ connection: discovered.connection, client: 'cli' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return emit(fail('BACKEND_UNAVAILABLE', `建立客户端失败：${message}`), {
      json: parsed.json,
      stdout: out,
      stderr: err
    })
  }

  const handler = resolveCommand(parsed)
  if (!handler) {
    return emit(fail('USAGE', `命令未实现：${commandKey(parsed)}`), { json: parsed.json, stdout: out, stderr: err })
  }

  // 启动预检：连通性 + 认证 + 协议版本；任一不过即报错退出（不把失败推迟到业务请求）
  let ready
  try {
    ready = await checkServerReady(client)
  } catch (error) {
    // 预检自身抛错（而非返回失败结果）也要有信封：否则调用方拿到裸栈，退出码也不对
    const message = error instanceof Error ? error.message : String(error)
    return emit(fail('BACKEND_UNAVAILABLE', `启动预检失败：${message}`, '请确认桌面版在运行且已开启本地服务'), {
      json: parsed.json,
      stdout: out,
      stderr: err
    })
  }
  if (!ready.ok) return emit(ready.envelope, { json: parsed.json, stdout: out, stderr: err })
  // 包版本漂移只提示不拦：协议版本才是契约（CON-3），补丁级差异不应阻断使用。
  // 且**只在人类可读模式**提示：`--json` 时 stderr 承载失败信封，掺入文本会破坏机器可解析性。
  const cliVersion = packageVersion()
  if (
    !parsed.json &&
    cliVersion !== 'unknown' &&
    ready.serverVersion !== 'unknown' &&
    ready.serverVersion !== cliVersion
  ) {
    err(`[warn] 桌面版为 ${ready.serverVersion}，当前 CLI 为 ${cliVersion}（协议一致，仍可继续）`)
  }

  try {
    const envelope = await handler({ args: parsed, client })
    // 命令可自带人类可读渲染（如 `git status` 的变更文件列表）；`--json` 不受影响
    return emit(envelope, { json: parsed.json, stdout: out, stderr: err, renderText: resolveTextRenderer(parsed) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code: ErrorCode = 'BACKEND_UNAVAILABLE'
    return emit(fail(code, `命令执行失败：${message}`), { json: parsed.json, stdout: out, stderr: err })
  }
}

function emitHelp(json: boolean, group: string | null, out: (text: string) => void, err: (text: string) => void): number {
  // 帮助始终走文本通道；--json 时给出结构化信封（CON-2：结构化通道不混入非结构化文本）
  if (json) {
    return emit(ok({ usage: helpForJson(group) }, { summary: 'ShipIt CLI' }), { json: true, stdout: out, stderr: err })
  }
  out(helpText(group ?? undefined))
  return 0
}

function helpForJson(group: string | null): string[] {
  return helpText(group ?? undefined).split('\n')
}

/** 进程入口（bin 指向构建产物时使用） */
export async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2))
  process.exitCode = code
}

// bin 入口自执行（构建产物 dist-cli/index.js 直接运行）；被测试 import 时不触发
const isDirectRun =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module
if (isDirectRun) {
  void main()
}