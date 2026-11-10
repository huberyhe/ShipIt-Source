/**
 * 单后端装配：启动独立后端进程并返回管理端点客户端。
 *
 * 进程内模式（embedded）已移除；桌面所有服务调用都经这里。
 */
import { createRemoteAdapter, type IpcAdapter } from './ipc-adapter'
import { createServerHost, type HostOptions, type ServerHost } from './server-host'

export async function createAdapter (options: { host: HostOptions }): Promise<{ adapter: IpcAdapter; host: ServerHost }> {
  const host = createServerHost(options.host)
  await host.start()
  return {
    adapter: createRemoteAdapter({
      get: (path, query) => host.get(path, query),
      post: (path, body, timeoutMs) => host.post(path, body, timeoutMs),
      on: (event, fn) => host.on(event, fn)
    }),
    host
  }
}
