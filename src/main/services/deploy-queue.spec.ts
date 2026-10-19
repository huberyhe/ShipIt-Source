import { describe, expect, it, vi } from 'vitest'
import type { DeployResult, QueueSnapshot } from '../../shared/types'
import { createQueue, MAX_TASK_RECORDS, QueueError } from './deploy-queue'
import type { QueueJobContext } from './deploy-queue'

const result = (over: Partial<DeployResult> = {}): DeployResult => ({
  taskId: 'x',
  targetName: 'my_dev',
  timestamp: 1,
  totalFiles: 1,
  succeeded: 1,
  failed: 0,
  skipped: 0,
  duration: 5,
  details: [],
  ...over
})

type Job = (ctx: QueueJobContext) => Promise<DeployResult>

/**
 * 确定性门控：任务在 open() 之前绝不结束。
 * 用「等门」而不是 setTimeout 来制造「运行中 / 排队中」这类瞬时状态断言，
 * 避免并行测试机上因负载导致任务提前完成而抖动。
 */
function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** 受门控的任务：gate.open() 前一直处于 running */
const gatedJob = (gate: { promise: Promise<void> }, over: Partial<DeployResult> = {}): Job => async () => {
  await gate.promise
  return result(over)
}

const submit = (q: ReturnType<typeof createQueue>, over: { totalFiles?: number; job?: Job; origin?: 'desktop' | 'cli' | 'mcp' } = {}) =>
  q.submit({
    origin: over.origin ?? 'cli',
    client: 'cli',
    target: 'my_dev',
    projectRoot: 'D:/work/app',
    totalFiles: over.totalFiles ?? 1,
    job: over.job ?? (async () => result())
  })

describe('deploy-queue', () => {
  it('P3 回归 position 含执行中的任务：空闲时提交为 1', async () => {
    const q = createQueue()
    expect(submit(q).position).toBe(1)
    await q.idle()
  })

  it('P3 回归 逐文件进度写进任务记录（路径归一为正斜杠）', async () => {
    const q = createQueue()

    const { taskId } = submit(q, {
      job: async (ctx) => {
        ctx.onProgress(1, 2, 'dist\\a.js')
        ctx.onProgress(2, 2, 'dist/b.css')
        return result({ totalFiles: 2, succeeded: 2 })
      }
    })
    await q.idle()

    // 进度不再跨进程广播，而是留在记录里供 GET /tasks/:id 与日志明细使用
    expect(q.get(taskId)?.progress).toEqual({ current: 2, total: 2, file: 'dist/b.css' })
  })

  it('AC-032 提交即返回 taskId 且任务继续执行', async () => {
    const q = createQueue()
    const { taskId } = submit(q)
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/)
    await q.idle()
    expect(q.get(taskId)!.state).toBe('succeeded')
  })

  it('AC-019 上传进行中再次提交进入排队且不取消前一个（INV-6）', async () => {
    const q = createQueue()
    const gate = deferred()
    const a = submit(q, { job: gatedJob(gate) })
    const b = submit(q)
    expect(q.get(b.taskId)!.state).toBe('queued')
    expect(q.get(a.taskId)!.state).toBe('running')
    // 位置含正在执行的那个：b 是第 2 个（a 在执行）
    expect(b.position).toBe(2)

    gate.open()
    await q.idle()
    expect(q.get(a.taskId)!.state).toBe('succeeded')
    expect(q.get(b.taskId)!.state).toBe('succeeded')
  })

  it('AC-019 串行执行：同一时刻只有一个任务在跑', async () => {
    const q = createQueue()
    let concurrent = 0
    let peak = 0
    const job = async (): Promise<DeployResult> => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise((r) => setTimeout(r, 10))
      concurrent -= 1
      return result()
    }
    submit(q, { job })
    submit(q, { job })
    submit(q, { job })
    await q.idle()
    expect(peak).toBe(1)
  })

  it('AC-035 重启后旧 taskId 返回未知任务', () => {
    const q = createQueue()
    expect(q.get('00000000-0000-0000-0000-000000000000')).toBeUndefined()
  })

  it('AC-035 等待未知任务抛 UNKNOWN_TASK', async () => {
    const q = createQueue()
    await expect(q.wait('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(QueueError)
    await expect(q.wait('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'UNKNOWN_TASK' })
  })

  it('AC-036 等待超时返回 WAIT_TIMEOUT 且任务不取消', async () => {
    const q = createQueue({ waitTimeoutMs: 10 })
    const gate = deferred()
    const { taskId } = submit(q, { job: gatedJob(gate) })
    await expect(q.wait(taskId)).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' })
    expect(q.get(taskId)!.state).toBe('running')
    gate.open()
    await q.idle()
    expect(q.get(taskId)!.state).toBe('succeeded')
  })

  it('AC-019 仍在排队即超时返回 QUEUE_TIMEOUT（忙碌类错误）', async () => {
    const q = createQueue({ waitTimeoutMs: 10 })
    const gate = deferred()
    submit(q, { job: gatedJob(gate) })
    const second = submit(q)
    await expect(q.wait(second.taskId)).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' })
    gate.open()
    await q.idle()
  })

  it('AC-036 等待上限默认 300 秒', async () => {
    const q = createQueue()
    const { taskId } = submit(q)
    const record = await q.wait(taskId)
    expect(record.state).toBe('succeeded')
  })

  it('DFX-PORT-001 明细与进度路径统一正斜杠（与 plan 口径一致）', async () => {
    const q = createQueue()
    const { taskId } = submit(q, {
      job: async (ctx) => {
        ctx.onProgress(1, 2, 'dist\\a.js')
        return result({
          totalFiles: 2,
          succeeded: 2,
          details: [
            { relativePath: 'dist\\a.js', remotePath: 'out/dist/a.js', status: 'success' },
            { relativePath: 'server\\b\\c.js', remotePath: 'out/server/b/c.js', status: 'success' }
          ]
        })
      }
    })
    await q.idle()
    const record = q.get(taskId)!
    expect(record.progress.file).toBe('dist/a.js')
    expect(record.result?.details.map((d) => d.relativePath)).toEqual(['dist/a.js', 'server/b/c.js'])
    expect(JSON.stringify(record)).not.toContain('\\\\')
  })

  it('AC-008 任务记录保留逐文件明细与汇总', async () => {
    const q = createQueue()
    const { taskId } = submit(q, {
      job: async () =>
        result({
          totalFiles: 2,
          succeeded: 1,
          failed: 1,
          details: [
            { relativePath: 'a.js', remotePath: '/opt/a.js', status: 'success' },
            { relativePath: 'b.js', remotePath: '/opt/b.js', status: 'failed', error: '权限不足' }
          ]
        })
    })
    const record = await q.wait(taskId)
    expect(record.result?.details).toHaveLength(2)
    expect(record.state).toBe('failed')
  })

  it('AC-008 执行体抛错时任务标记失败并带错误信息（不阻塞后续任务）', async () => {
    const q = createQueue()
    const bad = submit(q, {
      job: async () => {
        throw new Error('连接中断')
      }
    })
    const good = submit(q)
    await q.idle()
    expect(q.get(bad.taskId)!.state).toBe('failed')
    expect(q.get(bad.taskId)!.error?.message).toContain('连接中断')
    expect(q.get(good.taskId)!.state).toBe('succeeded')
  })

  it('AC-034 进度回调写入任务记录', async () => {
    const q = createQueue()
    const seen: unknown[] = []
    const { taskId } = submit(q, {
      totalFiles: 2,
      job: async (ctx) => {
        // 先让出一次事件循环，避免在 submit 返回前读取 taskId
        await new Promise((r) => setTimeout(r, 1))
        ctx.onProgress(1, 2, 'a.js')
        seen.push(q.get(taskId)!.progress)
        ctx.onProgress(2, 2, 'b.js')
        return result({ totalFiles: 2, succeeded: 2 })
      }
    })
    await q.idle()
    expect(seen[0]).toEqual({ current: 1, total: 2, file: 'a.js' })
    expect(q.get(taskId)!.progress).toEqual({ current: 2, total: 2, file: 'b.js' })
  })

  it('CON-10 队列清空后任务表收敛到 50 条，保留最新记录', async () => {
    // 本用例专测任务表淘汰：不设积压上限，免得被 QUEUE_FULL 拦住
    const q = createQueue({ maxPending: Number.POSITIVE_INFINITY })
    const ids: string[] = []
    for (let i = 0; i < MAX_TASK_RECORDS + 10; i++) ids.push(submit(q).taskId)
    await q.idle()

    expect(q.snapshot().tasks.length).toBeLessThanOrEqual(MAX_TASK_RECORDS)
    expect(q.get(ids[ids.length - 1])).toBeDefined()
    expect(q.get(ids[0])).toBeUndefined()
  })

  it('CON-10 运行中与排队中的任务永不淘汰（积压时允许临时超上限）', async () => {
    // 同上：积压上限由专门用例覆盖
    const q = createQueue({ maxPending: Number.POSITIVE_INFINITY })
    const gate = deferred()
    const slow = submit(q, { job: gatedJob(gate) })
    const queued = submit(q)
    for (let i = 0; i < MAX_TASK_RECORDS; i++) submit(q)

    expect(q.get(slow.taskId)!.state).toBe('running')
    expect(q.get(slow.taskId)).toBeDefined()
    expect(q.get(queued.taskId)!.state).toBe('queued')
    gate.open()
    await q.idle()
    expect(q.snapshot().tasks.length).toBeLessThanOrEqual(MAX_TASK_RECORDS)
  })

  it('AC-034 快照队列状态：idle / running / waiting', async () => {
    const q = createQueue()
    expect(q.snapshot().state).toBe('idle')

    const gate = deferred()
    const running = submit(q, { job: gatedJob(gate) })
    expect(q.snapshot().state).toBe('running')

    submit(q)
    expect(q.snapshot().state).toBe('waiting')
    expect(q.snapshot().pendingCount).toBe(1)

    gate.open()
    await q.idle()
    expect(q.snapshot().state).toBe('idle')
    expect(q.get(running.taskId)!.state).toBe('succeeded')
  })

  it('AC-034 快照含队列状态与来源标注（desktop / cli）', async () => {
    const q = createQueue()
    submit(q, { origin: 'desktop' })
    submit(q, { origin: 'cli' })
    await q.idle()
    const snapshot = q.snapshot()
    expect(snapshot.runningTaskId).toBeNull()
    expect(snapshot.pendingCount).toBe(0)
    expect(snapshot.tasks.map((t) => t.origin)).toEqual(['desktop', 'cli'])
    expect(snapshot.tasks[1].client).toBe('cli')
  })

  /**
   * 回归：状态栏停在「上传中 11/11」不消失。
   *
   * 主进程在 onTaskChanged 里立刻取 snapshot 推给窗口。此前上报发生在 finish() 里，
   * 彼时 runningTaskId 还没清空 → 最后一次推送的快照是 running，此后再无推送，
   * 界面就永久停在「上传中」。现在上报改到 run() 的 finally（清空之后）。
   */
  it('P0 上报时序：开始运行时快照为 running，最后一次推送必为 idle', async () => {
    const seen: QueueSnapshot[] = []
    const q = createQueue({ onTaskChanged: () => seen.push(q.snapshot()) })

    const gate = deferred()
    const a = submit(q, { job: gatedJob(gate) })
    expect(seen.at(-1)).toMatchObject({ state: 'running', runningTaskId: a.taskId })

    gate.open()
    await q.idle()

    const last = seen.at(-1) as QueueSnapshot
    expect(last.runningTaskId).toBeNull()
    expect(last.state).toBe('idle')
    expect(last.pendingCount).toBe(0)
    expect(last.tasks.find((t) => t.taskId === a.taskId)?.state).toBe('succeeded')
  })

  it('P0 上报时序：仅排队、没有在执行时快照不得谎报 idle', async () => {
    const seen: QueueSnapshot[] = []
    const q = createQueue({ onTaskChanged: () => seen.push(q.snapshot()) })

    const gate = deferred()
    submit(q, { job: gatedJob(gate) })
    submit(q)
    expect(seen.at(-1)).toMatchObject({ state: 'waiting', pendingCount: 1 })

    gate.open()
    await q.idle()
    expect(q.snapshot().state).toBe('idle')
  })

  it('INV-12 状态单向推进：无排队时提交即进入 running，终态不回退', async () => {
    const q = createQueue()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = submit(q, {
      job: async () => {
        await gate
        return result()
      }
    })
    // 无排队：提交后立即进入 running（queued 仅在队列前面有任务时可见）
    expect(q.get(first.taskId)!.state).toBe('running')
    const second = submit(q)
    expect(q.get(second.taskId)!.state).toBe('queued')

    release()
    await q.idle()
    expect(q.get(first.taskId)!.state).toBe('succeeded')
    expect(q.get(second.taskId)!.state).toBe('succeeded')
  })

  it('P2 回归 积压达上限时拒绝新提交（QUEUE_FULL），且既有任务跑完后可继续提交', async () => {
    const q = createQueue({ maxPending: 2 })
    const gate = deferred()
    const running = submit(q, { job: gatedJob(gate) })
    const first = submit(q)
    const second = submit(q)

    let thrown: unknown
    try {
      submit(q)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(QueueError)
    expect((thrown as QueueError).code).toBe('QUEUE_FULL')
    expect(q.get(running.taskId)!.state).toBe('running')
    expect(q.get(first.taskId)!.state).toBe('queued')
    expect(q.get(second.taskId)!.state).toBe('queued')

    gate.open()
    await q.idle()
    // 队列清空后上限不再阻塞
    expect(() => submit(q)).not.toThrow()
    await q.idle()
  })

  it('P2 回归 单任务看门狗：超时记为 TASK_TIMEOUT，队列不被永久阻塞，迟到结果不覆盖终态', async () => {
    const q = createQueue({ taskTimeoutMs: 40 })
    const gate = deferred()
    let lateProgress = 0
    const hung = submit(q, {
      job: async (ctx) => {
        await gate.promise // 模拟 TCP 半开：永不返回
        ctx.onProgress(1, 1, 'dist/late.js')
        lateProgress++
        return result()
      }
    })
    const after = submit(q)

    const finished = await q.wait(hung.taskId)
    expect(finished.state).toBe('failed')
    expect(finished.error?.code).toBe('TASK_TIMEOUT')

    // 关键：队列没有卡死，后面的任务照常跑完
    await q.idle()
    expect(q.get(after.taskId)!.state).toBe('succeeded')

    // 挂起任务迟到收尾：不得把已判定的终态改回成功，也不得写回进度
    gate.open()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const still = q.get(hung.taskId)!
    expect(still.state).toBe('failed')
    expect(still.error?.code).toBe('TASK_TIMEOUT')
    expect(still.progress.current).toBe(0)
    expect(lateProgress).toBe(1)
  })

  it('P1-4 看门狗超时真正中止任务：ctx.signal 被 abort（否则串行链一直被占着）', async () => {
    const q = createQueue({ taskTimeoutMs: 30 })
    let aborted = false
    const hung = submit(q, {
      job: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true
        }, { once: true })
        await new Promise(() => undefined) // 永不返回：模拟 TCP 半开
        return result()
      }
    })

    const finished = await q.wait(hung.taskId)
    expect(finished.state).toBe('failed')
    expect(finished.error?.code).toBe('TASK_TIMEOUT')
    expect(aborted).toBe(true)
    // 队列本身没有被挂起的任务拖住
    await expect(q.drain(1000)).resolves.toBe(true)
  })

  it('P1-4 markStarted 重置看门狗：排队等锁的时间不计入执行超时', async () => {
    vi.useFakeTimers()
    try {
      const q = createQueue({ taskTimeoutMs: 1000 })
      const { taskId } = submit(q, {
        job: async (ctx) => {
          // 模拟“拿到串行链之前”的等待
          await new Promise((resolve) => setTimeout(resolve, 900))
          ctx.markStarted() // 真正开始传输：重新计时
          await new Promise((resolve) => setTimeout(resolve, 500))
          return result({ succeeded: 1 })
        }
      })

      // 总时长 1300ms > 1000ms，但重置后只过了 400ms：不能判超时
      await vi.advanceTimersByTimeAsync(1300)
      expect(q.get(taskId)!.state).toBe('running')

      await vi.advanceTimersByTimeAsync(200)
      expect(q.get(taskId)!.state).toBe('succeeded')
    } finally {
      vi.useRealTimers()
    }
  })

  it('P2 回归 drain 带上限：忙碌时超时返回 false，空闲时返回 true（不再 1ms 忙等）', async () => {
    const q = createQueue({ taskTimeoutMs: 60_000 })
    const gate = deferred()
    submit(q, { job: gatedJob(gate) })

    expect(await q.drain(30)).toBe(false)
    expect(q.snapshot().state).not.toBe('idle')

    gate.open()
    expect(await q.drain(2_000)).toBe(true)
    expect(q.snapshot().state).toBe('idle')

    // 空闲时立即返回
    expect(await q.drain(30)).toBe(true)
  })

  it('INV-9 执行体报告 cancelled 时任务记录如实保留标记（由 verdict 决定对外语义）', async () => {
    const q = createQueue()
    const { taskId } = submit(q, {
      job: async () => result({ totalFiles: 3, succeeded: 1, cancelled: true })
    })
    await q.idle()
    const record = q.get(taskId)!
    expect(record.cancelled).toBe(true)
    expect(record.result?.succeeded).toBe(1)
    expect(record.result?.totalFiles).toBe(3)
  })

})

describe('P1-6 回调抛错不得击穿队列（未捕获拒绝 / 剩余任务静默滞留）', () => {
  it('onTaskChanged 抛错：任务仍正常结束、错误被上报而非冒泡，后续任务继续执行', async () => {
    const errors: string[] = []
    const q = createQueue({
      onTaskChanged: () => {
        throw new Error('窗口已销毁：send 失败')
      },
      onCallbackError: (where) => errors.push(where)
    })

    const a = submit(q)
    const b = submit(q)
    // 回调抛错若没被兜住，第二个任务会永久滞留 → drain 超时返回 false
    await expect(q.drain(1000)).resolves.toBe(true)
    expect(q.get(a.taskId)?.state).toBe('succeeded')
    expect(q.get(b.taskId)?.state).toBe('succeeded')
    // 错误被上报（而不是冒泡成未捕获拒绝）
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('P1-7 任务 ID 单一事实源（INV-12）', () => {
  it('result.taskId 必须收敛为队列生成的 taskId，而不是执行层自己生成的时间 ID', async () => {
    const q = createQueue()
    // 执行层（DeployService）总是新建一个 result.taskId；队列层必须覆盖它
    const job: Job = async () => result({ taskId: 'exec-layer-id' })
    const { taskId } = submit(q, { job })
    await expect(q.drain(1000)).resolves.toBe(true)

    const record = q.get(taskId)!
    expect(record.result?.taskId).toBe(taskId)
    expect(record.result?.taskId).not.toBe('exec-layer-id')
  })

  it('P1-6 状态快照只带结果摘要（不带逐文件明细），详情仍走 get()', async () => {
    const q = createQueue()
    const job: Job = async () =>
      result({
        totalFiles: 2,
        succeeded: 1,
        failed: 1,
        details: [
          { relativePath: 'a.js', remotePath: '/a.js', status: 'success' },
          { relativePath: 'b.js', remotePath: '/b.js', status: 'failed', error: 'boom' }
        ]
      })
    const { taskId } = submit(q, { job })
    await q.idle()

    const summary = q.snapshot().tasks.find((t) => t.taskId === taskId)!
    expect(summary.result).toMatchObject({ totalFiles: 2, succeeded: 1, failed: 1 })
    expect((summary.result as { details?: unknown }).details).toBeUndefined()

    // 详情接口（单任务查询）仍然带明细
    expect(q.get(taskId)!.result?.details).toHaveLength(2)
  })

  it('逐文件进度只写任务记录（GET /tasks/:id 可见），不需要外部回调', async () => {
    const q = createQueue()
    const job: Job = async (ctx) => {
      ctx.onProgress(2, 3, 'dist\\b.js')
      return result({ succeeded: 3 })
    }
    const { taskId } = submit(q, { job, totalFiles: 3 })
    await expect(q.drain(1000)).resolves.toBe(true)

    const record = q.get(taskId)!
    expect(record.progress).toEqual({ current: 2, total: 3, file: 'dist/b.js' })
    expect(record.state).toBe('succeeded')
  })
})
