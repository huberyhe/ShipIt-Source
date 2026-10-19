/**
 * 渲染层 store 的首批自动化覆盖（P3 回归）。
 *
 * 渲染层此前零自动化：这里在 node 环境（无需 jsdom）直接测 store 逻辑，
 * 覆盖「状态栏实时进度」这条本轮修过的链路。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { QueueSnapshot, UploadTaskRecord } from '../../shared/types'
import { useServerStore } from './server'

const task = (over: Partial<UploadTaskRecord> = {}): UploadTaskRecord => ({
  taskId: 'T1',
  state: 'queued',
  progress: { current: 0, total: 3, file: '' },
  createdAt: 1,
  origin: 'cli',
  target: 'my_dev',
  projectRoot: 'D:/work/app',
  totalFiles: 3,
  ...over
})

const snapshot = (tasks: UploadTaskRecord[], runningTaskId: string | null, pendingCount: number): QueueSnapshot => ({
  state: runningTaskId ? 'running' : 'idle',
  runningTaskId,
  pendingCount,
  tasks
})

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('server store（P3 回归）', () => {
  it('状态栏文案是队列口径：空闲 / 上传中 / 排队', () => {
    const store = useServerStore()

    store.queue = snapshot([], null, 0)
    expect(store.queueText).toBe('队列 空闲')
    expect(store.queueTone).toBe('off')

    store.queue = snapshot([task({ taskId: 'T1', state: 'running' })], 'T1', 0)
    expect(store.queueText).toBe('队列 上传中')
    expect(store.queueTone).toBe('on')

    store.queue = snapshot([task({ taskId: 'T1', state: 'running' }), task({ taskId: 'T2' })], 'T1', 1)
    expect(store.queueText).toBe('队列 上传中 · 排队 1')

    // 上一个任务刚结束、下一个还没起来：不能谎报空闲
    store.queue = snapshot([task({ taskId: 'T2' })], null, 1)
    expect(store.queueText).toBe('队列 排队 1')
    expect(store.queueTone).toBe('on')
  })

  it('迟到的旧快照不得覆盖新状态（P1-1，否则会重现「永久上传中」）', () => {
    const store = useServerStore()
    const base = {
      listening: true,
      port: 4571,
      bound: '127.0.0.1',
      enabled: true,
      bind: 'local' as const
    }

    // 新推送：队列已空闲
    store.apply({ ...base, queue: snapshot([], null, 0), revision: 7 })
    expect(store.queueText).toBe('队列 空闲')

    // 旧响应后到（revision 6）：必须被丢弃
    store.apply({
      ...base,
      queue: snapshot([task({ taskId: 'T1', state: 'running' })], 'T1', 0),
      revision: 6
    })
    expect(store.queueText).toBe('队列 空闲')

    // 更新的一拍仍然接受
    store.apply({
      ...base,
      queue: snapshot([task({ taskId: 'T2', state: 'running' })], 'T2', 0),
      revision: 8
    })
    expect(store.queueText).toBe('队列 上传中')
  })
})
