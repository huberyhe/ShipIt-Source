/**
 * `ps`：服务进程自检。
 *
 * Electron 的 GPU / 渲染 / utility 进程无法改名；这里输出后端的 pid 与桌面主进程 pid，
 * 用于在任务管理器里定位“哪个进程是 shipit-server”。
 */
import type { Envelope } from '../../shared/cli-contract'
import { toEnvelope } from '../client'
import { registerCommand, type CommandContext } from '../registry'

async function psCommand (ctx: CommandContext): Promise<Envelope> {
  return toEnvelope(await ctx.client.get('/status'))
}

registerCommand('ps', psCommand, (env) => {
  const data = (env.data ?? {}) as Record<string, any>
  const queue = (data.queue ?? {}) as Record<string, any>
  return [
    `后端进程   pid=${data.pid ?? '?'}   父进程(桌面)=${data.parentPid ?? '?'}`,
    `端点       ${data.bound || '127.0.0.1'}:${data.port ?? '-'}   published=${data.published ? 'yes' : 'no'}`,
    `实例       ${data.instanceId ?? '-'}`,
    `队列       ${queue.state ?? 'idle'}   排队=${queue.pendingCount ?? 0}`,
    `版本       ${data.version ?? '-'}`
  ].join('\n')
})
