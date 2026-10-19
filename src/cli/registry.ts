/**
 * 命令登记表。
 *
 * 单独成模块，避免「命令实现 → index.ts → 命令实现」的循环依赖：
 * 命令模块只依赖这里与 `client.ts`，`index.ts` 只负责分发。
 */
import type { Envelope, OkEnvelope } from '../shared/cli-contract'
import type { ServerClient } from './client'
import type { ParsedArgs } from './args'

export interface CommandContext {
  args: ParsedArgs
  client: ServerClient
}

export type CommandHandler = (ctx: CommandContext) => Promise<Envelope>

/**
 * 命令的人类可读渲染器（默认输出通道）。
 *
 * 缺省由 `output.ts` 按通用规则渲染（字段行 / 表格）；需要更贴合语义的呈现
 * （如 `git status` 的变更文件列表）时随命令一起登记。`--json` 与错误信封不走这里。
 */
export type CommandTextRenderer = (env: OkEnvelope) => string

const handlers = new Map<string, CommandHandler>()
const textRenderers = new Map<string, CommandTextRenderer>()

/** 登记命令实现；键为 `命令` 或 `命令 动作`（如 `targets list`），可附带人类可读渲染器 */
export function registerCommand(
  name: string,
  handler: CommandHandler,
  renderText?: CommandTextRenderer
): void {
  handlers.set(name, handler)
  if (renderText) textRenderers.set(name, renderText)
  else textRenderers.delete(name)
}

/** 取命令实现；未登记返回 undefined */
export function resolveCommand(args: ParsedArgs): CommandHandler | undefined {
  return handlers.get(commandKey(args))
}

/** 取命令的人类可读渲染器；未登记返回 undefined（走通用渲染） */
export function resolveTextRenderer(args: ParsedArgs): CommandTextRenderer | undefined {
  return textRenderers.get(commandKey(args))
}

/** 命令分发的键：子命令组使用 `命令 动作` */
export function commandKey(args: ParsedArgs): string {
  return args.action ? `${args.command} ${args.action}` : String(args.command)
}

/** 已登记的命令键（供自检与测试核对命令面完整性） */
export function registeredCommandKeys(): string[] {
  return [...handlers.keys()].sort()
}