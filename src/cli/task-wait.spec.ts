/**
 * task-wait 用例（P3 补齐：该模块此前零覆盖，注入的 sleep/now 钩子也无人使用）。
 */
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../shared/cli-contract'
import type { UploadTaskRecord } from '../shared/types'
import type { ClientResult, ServerClient } from './client'
import { waitForTask } from './task-wait'

const record = (over: Partial<UploadTaskRecord> = {}): UploadTaskRecord => ({
  taskId: 'T1',
  state: 'running',
  progress: { current: 1, total: 3, file: 'dist/a.js' },
  createdAt: 1,
  origin: 'cli',
  target: 'my_dev',
  projectRoot: 'D:/work/app',
  totalFiles: 3,
  ...over
})

/** 依次返回给定记录的客户端桩；用尽后重复最后一条 */
function stubClient(records: UploadTaskRecord[]): { client: ServerClient; calls: () => number } {
  let index = 0
  let calls = 0
  const client = {
    connection: { port: 1, token: 'x', protocolVersion: PROTOCOL_VERSION, fingerprint: 'f', source: 'shipit-home' },
    async get(): Promise<ClientResult> {
      calls += 1
      const item = records[Math.min(index, records.length - 1)]
      index += 1
      return { ok: true, envelope: { ok: true, data: item } }
    }
  } as unknown as ServerClient
  return { client, calls: () => calls }
}

describe('task-wait（P3 回归）', () => {
  it('轮询到终态返回终态判定（不取消任务、不再多轮一次）', async () => {
    const { client, calls } = stubClient([
      record(),
      record({ state: 'succeeded', result: { taskId: 'T1', targetName: 'my_dev', timestamp: 1, totalFiles: 3, succeeded: 3, failed: 0, skipped: 0, duration: 1, details: [] } })
    ])
    // sleep 用真实计时器（0ms）：即使断言失败也不会把事件循环饿死
    const envelope = await waitForTask(client, 'T1', {
      timeoutSeconds: 5,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
      now: () => 0
    })

    expect(envelope.ok).toBe(true)
    expect(calls()).toBe(2)
  })

  it('等待上限到点且仍在执行 → WAIT_TIMEOUT（任务不取消）', async () => {
    const { client } = stubClient([record()])
    // 时钟随 sleep 推进：上限到点即返回（用立即返回的 sleep + 固定时钟会永不超时）
    let clock = 0
    const envelope = await waitForTask(client, 'T1', {
      timeoutSeconds: 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      }
    })

    expect(envelope.ok).toBe(false)
    if (!envelope.ok) expect(envelope.error.code).toBe('WAIT_TIMEOUT')
  })

  it('等待上限到点且仍在排队 → QUEUE_TIMEOUT', async () => {
    const { client } = stubClient([record({ state: 'queued' })])
    let clock = 0
    const envelope = await waitForTask(client, 'T1', {
      timeoutSeconds: 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      }
    })

    expect(envelope.ok).toBe(false)
    if (!envelope.ok) expect(envelope.error.code).toBe('QUEUE_TIMEOUT')
  })

  it('查询本身失败时原样返回（不误报成等待超时）', async () => {
    const client = {
      connection: { port: 1, token: 'x', protocolVersion: PROTOCOL_VERSION, fingerprint: 'f', source: 'shipit-home' },
      async get(): Promise<ClientResult> {
        return { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: '断线' } }
      }
    } as unknown as ServerClient

    const envelope = await waitForTask(client, 'T1', { timeoutSeconds: 5 })

    expect(envelope.ok).toBe(false)
    if (!envelope.ok) expect(envelope.error.code).toBe('BACKEND_UNAVAILABLE')
  })
})
