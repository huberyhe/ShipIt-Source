/** SSE 事件中心：管理端点订阅、Runtime 广播。 */
import type { IncomingMessage, ServerResponse } from 'http'

export interface EventHub {
  emit(event: string, data: unknown): void
  attach(req: IncomingMessage, res: ServerResponse): void
  /**
   * 注入「连接建立时先补发一遍的全量快照」。
   *
   * SSE 不做断线续传（`last-event-id` 不参与回放），所以新连接（含断线重连）必须先拿到
   * 当前状态，否则客户端会停在旧快照上等下一个事件 —— 而后端可能长时间没有新事件。
   */
  setInitial(fn: () => Array<[string, unknown]>): void
}

export function createEventHub (): EventHub {
  const clients = new Set<ServerResponse>()
  let initial: () => Array<[string, unknown]> = () => []

  const write = (res: ServerResponse, event: string, data: unknown): void => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      clients.delete(res)
    }
  }

  return {
    emit (event, data) {
      for (const res of clients) write(res, event, data)
    },
    setInitial (fn) {
      initial = fn
    },
    attach (req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write(': connected\n\n')
      clients.add(res)
      // 先补发当前快照：客户端拿到的是「连接那一刻的真相」，不依赖后续事件
      for (const [event, data] of initial()) write(res, event, data)
      req.on('close', () => clients.delete(res))
    }
  }
}
