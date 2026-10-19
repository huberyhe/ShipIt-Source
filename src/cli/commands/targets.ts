/**
 * targets 命令族（FR-001 / FR-002）：list / show / ping。
 *
 * 仅做参数 → 请求 → 信封的映射；执行与配置读取全部在服务端（INV-2）。
 */
import type { Envelope } from '../../shared/cli-contract'
import { toEnvelope } from '../client'
import { registerCommand, type CommandContext } from '../registry'

/** `shipit targets list` 与 `shipit targets show <目标名>` 共用实现（服务端按 name 区分） */
async function targetsCommand(ctx: CommandContext): Promise<Envelope> {
  const { args, client } = ctx
  const query = args.action === 'show' ? { name: args.positionals[0] } : undefined
  return toEnvelope(await client.get('/targets', query))
}

/** `shipit targets ping <目标名>`：校验目标可连接 */
async function targetsPingCommand(ctx: CommandContext): Promise<Envelope> {
  const { args, client } = ctx
  return toEnvelope(await client.post('/test-connection', { target: args.positionals[0] }))
}

registerCommand('targets list', targetsCommand)
registerCommand('targets show', targetsCommand)
registerCommand('targets ping', targetsPingCommand)
