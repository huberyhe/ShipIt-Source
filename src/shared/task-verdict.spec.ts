import { describe, expect, it } from 'vitest'
import { errEnvelope, exitCodeOf, okEnvelope } from './cli-contract'
import { correctTaskEnvelope, isTerminal, timeoutVerdict, verdictOf } from './task-verdict'
import type { UploadTaskRecord } from './types'

const record = (over: Partial<UploadTaskRecord> = {}): UploadTaskRecord => ({
  taskId: 'T1',
  state: 'succeeded',
  progress: { current: 1, total: 1, file: 'dist/a.js' },
  createdAt: 1,
  origin: 'cli',
  client: 'cli',
  target: 'my_dev',
  projectRoot: 'D:/work/app',
  totalFiles: 1,
  result: {
    taskId: 'x',
    targetName: 'my_dev',
    timestamp: 2,
    totalFiles: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    duration: 3,
    details: [{ relativePath: 'dist/a.js', remotePath: 'out/dist/a.js', status: 'success' }]
  },
  ...over
})

describe('终态判定', () => {
  it('P3 回归 任务查询也应用终态判定：被取消但 state=succeeded 报 PARTIAL（INV-9）', () => {
    const record = {
      taskId: 'T1',
      state: 'succeeded' as const,
      progress: { current: 1, total: 3, file: 'dist/a.js' },
      createdAt: 1,
      origin: 'cli' as const,
      target: 'my_dev',
      projectRoot: 'D:/work/app',
      totalFiles: 3,
      cancelled: true,
      result: {
        taskId: 'T1',
        targetName: 'my_dev',
        timestamp: 1,
        totalFiles: 3,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        duration: 1,
        cancelled: true,
        details: []
      }
    }

    const envelope = correctTaskEnvelope({ ok: true, data: record })

    expect(envelope.ok).toBe(false)
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('PARTIAL')
      expect(envelope.data).toBe(record) // data 形状不变（仍是任务记录）
    }
  })

  it('P3 回归 未到终态 / 未被取消的任务查询保持原样', () => {
    const running = { state: 'running', taskId: 'T2', totalFiles: 1 } as UploadTaskRecord
    const envelope = { ok: true as const, data: running }
    expect(correctTaskEnvelope(envelope)).toBe(envelope)
  })

  it('全部成功 → 成功信封', () => {
    const env = verdictOf(record())
    expect(env.ok).toBe(true)
    if (!env.ok) return
    expect(env.data).toMatchObject({ taskId: 'T1', state: 'succeeded' })
    expect(env.meta).toMatchObject({ count: 1, state: 'succeeded' })
  })

  it('有失败文件 → PARTIAL（携带明细）', () => {
    const env = verdictOf(
      record({
        state: 'failed',
        result: { ...record().result!, succeeded: 1, failed: 1, totalFiles: 2, details: [] }
      })
    )
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('PARTIAL')
    expect(env.data).toBeDefined()
  })

  it('执行体异常（无失败明细）→ CONNECT_FAILED', () => {
    const env = verdictOf(record({ state: 'failed', error: { code: 'CONNECT_FAILED', message: '认证失败' }, result: undefined }))
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('CONNECT_FAILED')
    expect(env.error.message).toContain('认证失败')
  })

  it('被取消 → PARTIAL 并指出剩余未处理数量（INV-9）', () => {
    const env = verdictOf(
      record({
        cancelled: true,
        totalFiles: 3,
        result: {
          taskId: 'x',
          targetName: 'my_dev',
          timestamp: 2,
          totalFiles: 3,
          succeeded: 1,
          failed: 0,
          skipped: 0,
          duration: 3,
          cancelled: true,
          details: []
        }
      })
    )
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('PARTIAL')
    expect(env.error.message).toContain('剩余 2 个未处理')
  })

  it('isTerminal 只认终态', () => {
    expect(isTerminal(record({ state: 'queued' }))).toBe(false)
    expect(isTerminal(record({ state: 'running' }))).toBe(false)
    expect(isTerminal(record({ state: 'succeeded' }))).toBe(true)
    expect(isTerminal(record({ state: 'failed' }))).toBe(true)
  })

  it('等待超时判定：排队中 → QUEUE_TIMEOUT，执行中 → WAIT_TIMEOUT（均不取消任务）', () => {
    const queued = timeoutVerdict('T1', 'queued', 300)
    const running = timeoutVerdict('T1', 'running', 300)
    const unknown = timeoutVerdict('T1', null, 300)
    expect(queued.ok).toBe(false)
    expect(running.ok).toBe(false)
    expect(unknown.ok).toBe(false)
    if (queued.ok || running.ok || unknown.ok) return
    expect(queued.error.code).toBe('QUEUE_TIMEOUT')
    expect(running.error.code).toBe('WAIT_TIMEOUT')
    expect(unknown.error.code).toBe('QUEUE_TIMEOUT')
    expect(running.error.hint).toContain('shipit task')
  })

  it('信封不含凭据（INV-5）', () => {
    const env = verdictOf(record())
    expect(JSON.stringify(env)).not.toMatch(/password|privateKey|passphrase|token/i)
    expect(errEnvelope('USAGE', 'x').ok).toBe(false)
  })
})

describe('P1-4 终态判定两路径一致（task 不得把失败报成成功）', () => {
  // 与队列真实写入一致：计数与明细在 record.result 里（toTaskResultView 只从 result 取计数）
  const base = {
    taskId: 't1',
    target: 'dev1',
    projectRoot: 'D:/work/app',
    origin: 'cli' as const,
    state: 'succeeded' as const,
    createdAt: 1,
    totalFiles: 2,
    result: {
      target: 'dev1',
      totalFiles: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
      duration: 1,
      details: [{ relativePath: 'a.js', remotePath: 'out/a.js', status: 'failed', error: 'x' }]
    }
  }

  it('failed + 有失败文件：--wait 与 task 都是 PARTIAL/退出码 2', () => {
    const record = { ...base, state: 'failed' as const, error: { code: 'CONNECT_FAILED', message: '连接中断' } }
    const wait = verdictOf(record as never)
    const task = correctTaskEnvelope(okEnvelope(record))
    expect(wait.ok).toBe(false)
    expect(task.ok).toBe(false)
    if (wait.ok || task.ok) return
    expect(wait.error.code).toBe('PARTIAL')
    expect(task.error.code).toBe('PARTIAL')
    expect(exitCodeOf(wait.error.code)).toBe(2)
    expect(exitCodeOf(task.error.code)).toBe(2)
    // task 的 data 仍是任务记录（不改变既有输出形状）
    expect((task as { data?: unknown }).data).toMatchObject({ taskId: 't1', state: 'failed' })
  })

  it('failed 且无失败文件（看门狗/连接类）：采用记录里的错误类别，不再一律 CONNECT_FAILED', () => {
    const record = {
      ...base,
      state: 'failed' as const,
      result: { ...base.result, succeeded: 0, failed: 0, details: [] },
      error: { code: 'TASK_TIMEOUT', message: '任务执行超时' }
    }
    const task = correctTaskEnvelope(okEnvelope(record))
    expect(task.ok).toBe(false)
    if (task.ok) return
    expect(task.error.code).toBe('TASK_TIMEOUT')
    expect(task.error.message).toContain('超时')
  })

  it('记录里的错误类别不是已知类别时退化为 CONNECT_FAILED（不伪造类别）', () => {
    const record = {
      ...base,
      state: 'failed' as const,
      result: { ...base.result, succeeded: 0, failed: 0, details: [] },
      error: { code: 'WEIRD', message: '未知' }
    }
    const task = correctTaskEnvelope(okEnvelope(record))
    expect(task.ok).toBe(false)
    if (task.ok) return
    expect(task.error.code).toBe('CONNECT_FAILED')
  })

  it('succeeded：两条路径都返回成功（不误降级）', () => {
    const record = { ...base, result: { ...base.result, succeeded: 2, failed: 0, details: [] } }
    expect(verdictOf(record as never).ok).toBe(true)
    expect(correctTaskEnvelope(okEnvelope(record)).ok).toBe(true)
  })

  it('非终态（running）不判定', () => {
    const record = { ...base, state: 'running' as const }
    expect(correctTaskEnvelope(okEnvelope(record)).ok).toBe(true)
  })
})
