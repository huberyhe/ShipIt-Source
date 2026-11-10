/**
 * SSE 事件中心的行为约束。
 *
 * 关键点：服务端**不做断线续传**（`last-event-id` 不参与回放），因此每条新连接
 * 必须在 `: connected` 之后立刻收到一遍全量快照 —— 否则客户端会停在旧状态上，
 * 等一个可能很久不来的事件。
 */
import type { ServerResponse } from 'http'
import { describe, expect, it } from 'vitest'
import { createEventHub } from './events'

function fakeResponse (sink: string[]): ServerResponse {
  return {
    writeHead: () => undefined,
    write: (chunk: string) => {
      sink.push(chunk)
      return true
    }
  } as unknown as ServerResponse
}

const fakeRequest = { on: () => undefined } as unknown as Parameters<ReturnType<typeof createEventHub>['attach']>[0]

describe('server/events', () => {
  it('连接建立后立刻补发全量快照，不等后续事件', () => {
    const hub = createEventHub()
    hub.setInitial(() => [
      ['server.state', { published: true, public: { listening: true, port: 4517 } }],
      ['queue.snapshot', { state: 'idle', pendingCount: 0 }]
    ])

    const chunks: string[] = []
    hub.attach(fakeRequest, fakeResponse(chunks))
    const text = chunks.join('')

    expect(text).toContain(': connected')
    expect(text).toContain('event: server.state')
    expect(text).toContain('event: queue.snapshot')
    expect(text).toContain('"listening":true')
  })

  it('未注入 initial 时不补发，但仍能收到后续事件', () => {
    const hub = createEventHub()
    const chunks: string[] = []
    hub.attach(fakeRequest, fakeResponse(chunks))
    expect(chunks.join('')).not.toContain('event: ')

    hub.emit('queue.snapshot', { state: 'running' })
    expect(chunks.join('')).toContain('event: queue.snapshot')
    expect(chunks.join('')).toContain('"state":"running"')
  })

  it('连接关闭后不再收到事件（避免向已断开的连接写入）', () => {
    const hub = createEventHub()
    const chunks: string[] = []
    // 默认空函数：TS 的控制流分析看不到「回调里被赋值」，显式给初值避免收窄成 never
    let onClose: () => void = () => undefined
    const req = { on: (event: string, fn: () => void) => { if (event === 'close') onClose = fn } }
    hub.attach(req as unknown as Parameters<ReturnType<typeof createEventHub>['attach']>[0], fakeResponse(chunks))

    const before = chunks.length
    onClose()
    hub.emit('queue.snapshot', { state: 'running' })
    expect(chunks.length).toBe(before)
  })
})
