/** SSE 事件中心：管理端点订阅、Runtime 广播。 */
import type { IncomingMessage, ServerResponse } from 'http'

export interface EventHub {
  emit(event: string, data: unknown): void
  attach(req: IncomingMessage, res: ServerResponse): void
}

export function createEventHub (): EventHub {
  const clients = new Set<ServerResponse>()
  return {
    emit (event, data) {
      const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      for (const res of clients) {
        try {
          res.write(chunk)
        } catch {
          clients.delete(res)
        }
      }
    },
    attach (req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
    }
  }
}
