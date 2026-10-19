/**
 * projects 命令族（策略 D′）：`shipit projects list`。
 *
 * 项目根必填之后，调用方（CLI / MCP / agent）需要能发现「桌面现在开着哪些项目」，
 * 否则只能靠人告诉它路径。这里只做参数 → 请求 → 信封的映射，读取全部在服务端。
 */
import type { Envelope } from '../../shared/cli-contract'
import { toEnvelope } from '../client'
import { registerCommand, type CommandContext } from '../registry'

/** `shipit projects list`：列出桌面当前已打开的项目（路径 / 名称 / 窗口 / 是否聚焦） */
async function projectsListCommand(ctx: CommandContext): Promise<Envelope> {
  return toEnvelope(await ctx.client.get('/projects'))
}

registerCommand('projects list', projectsListCommand)
