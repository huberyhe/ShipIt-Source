/**
 * 按 `server.backend` 创建适配器：
 * - embedded：进程内服务
 * - process：启动独立后端并走管理端点
 *
 * 这是 index.ts 接线的唯一入口，保证两种形态使用同一份接口。
 */
import { createEmbeddedAdapter, createRemoteAdapter, type EmbeddedDeps, type IpcAdapter } from './ipc-adapter'
import { createServerHost, type HostOptions, type ServerHost } from './server-host'

export async function createAdapter (options: {
  backend: 'embedded' | 'process'
  embedded?: EmbeddedDeps
  host?: HostOptions
}): Promise<{ adapter: IpcAdapter; host: ServerHost | null }> {
  if (options.backend === 'process') {
    if (!options.host) throw new Error('process 模式需要 host 配置')
    const host = createServerHost(options.host)
    await host.start()
    return {
      adapter: createRemoteAdapter({
        get: (path, query) => host.get(path, query),
        post: (path, body) => host.post(path, body)
      }),
      host
    }
  }

  if (!options.embedded) throw new Error('embedded 模式需要进程内依赖')
  return { adapter: createEmbeddedAdapter(options.embedded), host: null }
}
