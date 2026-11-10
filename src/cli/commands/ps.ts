/**
 * `ps`：服务进程自检。
 *
 * Electron 的 GPU / 渲染 / utility 进程无法改名；这里输出后端的 pid 与桌面主进程 pid，
 * 用于在任务管理器里定位“哪个进程是 shipit-server”。
 */
import { errEnvelope, type Envelope } from '../../shared/cli-contract'
import { toEnvelope } from '../client'
import { registerCommand, type CommandContext } from '../registry'

async function psCommand (ctx: CommandContext): Promise<Envelope> {
  const result = await ctx.client.get('/status')
  if (!result.ok && result.error.code === 'BACKEND_UNAVAILABLE') {
    // ps 只能走公开端点（CLI 没有宿主 token），所以服务开关关闭时必然不可达。
    // 不能让它看起来像“后端挂了”：明确区分“没开服务”与“进程不在”，并给出替代手段。
    return errEnvelope(
      'BACKEND_UNAVAILABLE',
      '后端不可达：桌面版未运行，或「设置 → 本地服务管理」未开启',
      'ps 走公开端点，服务关闭时无法自检；可在任务管理器查找 shipit-server 进程，或查看 <userData>/error.log'
    )
  }
  return toEnvelope(result)
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
