/**
 * 上传互斥队列。
 *
 * - 单会话串行：任一时刻只有一个上传在跑，其余排队（INV-6 / AC-019）。
 * - taskId 由服务端生成且全程不变；状态只能 queued → running → succeeded|failed（INV-12 / AC-032）。
 * - 任务状态仅存内存，最多保留最近 50 条，进程退出即清空（CON-10 / AC-035）。
 * - 等待上限默认 300 秒；超时不取消任务（AC-036），仍可用任务查询获取结果。
 */
import { randomUUID } from 'crypto'
import type { ErrorCode } from '../../shared/cli-contract'
import { toSlashes } from '../../shared/paths'
import type { DeployResult, QueueSnapshot, QueueTaskSummary, UploadTaskRecord } from '../../shared/types'
import type { Origin } from './local-server'

/** 默认等待上限：300 秒（D-18） */
export const DEFAULT_WAIT_TIMEOUT_MS = 300_000

/** 任务状态保留上限（D-19） */
export const MAX_TASK_RECORDS = 50

/**
 * 排队积压上限（DFX-REL-004）：超过则拒绝新提交。
 * 不设上限时，持有令牌的一方可以循环 POST /deploy 持续推高主进程内存
 * （pending 永不淘汰，且每个 job 闭包都持有整份 tasks 数组）。
 */
export const MAX_PENDING = 20

/**
 * 单任务执行上限（看门狗），默认 10 分钟。
 *
 * TCP 半开等场景下传输可能永不返回；不设上限则 `runningTaskId` 永不清空、
 * 队列永久阻塞，只能重启桌面版。超时后任务如实记为失败，队列继续处理后续任务
 * （已挂起的远端传输本身无法取消 —— 队列不持有连接句柄，不做假成功/假取消）。
 */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000

export class QueueError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'QueueError'
    this.code = code
  }
}

export interface QueueJobContext {
  onProgress: (current: number, total: number, file: string) => void
  /**
   * 外部取消信号：看门狗超时会 abort 它。
   *
   * 不传给执行体的话，超时只是「队列不等了」，底层传输仍在跑、且仍占着串行链，
   * 后续任务会接着一个个超时（注释里的「队列立即腾出」在集成层并不成立）。
   */
  signal: AbortSignal
  /** 真正开始执行（拿到串行链/建连前）：看门狗重新计时，排除“排队等锁”的时间 */
  markStarted: () => void
}

export interface SubmitOptions {
  origin: Origin
  /** 调用方标识（cli / mcp；桌面界面不声明） */
  client?: 'cli' | 'mcp'
  /** 来源地址；跨机器调用时用于界面日志标注（不持久化） */
  remoteAddress?: string
  target: string
  projectRoot: string
  totalFiles: number
  /** 实际执行体：由服务端注入既有 buildUploadTasks + deploy（DFX-REUSE-001） */
  job: (ctx: QueueJobContext) => Promise<DeployResult>
}

export interface SubmitResult {
  taskId: string
  /** 队列位置：**含正在执行的那个**，1 表示立即执行 */
  position: number
}

export interface DeployQueue {
  submit(options: SubmitOptions): SubmitResult
  get(taskId: string): UploadTaskRecord | undefined
  snapshot(): QueueSnapshot
  /** 等待任务结束；超时按状态抛 QUEUE_TIMEOUT（仍在排队）或 WAIT_TIMEOUT（执行中未完成），不取消任务 */
  wait(taskId: string, timeoutMs?: number): Promise<UploadTaskRecord>
  /** 等待队列清空（测试与关闭流程使用）；传 timeoutMs 时超时返回 false（不再无限等待） */
  drain(timeoutMs?: number): Promise<boolean>
  /** 与 drain 等价 */
  idle(timeoutMs?: number): Promise<boolean>
}

export interface QueueOptions {
  waitTimeoutMs?: number
  /** 任务结束回调（用于界面日志同步标注来源与结果；不持久化，CON-6） */
  /**
   * 回调（onTaskSettled / onTaskChanged / pump）抛错时的上报口。
   *
   * 回调由外部注入（主进程里会 `webContents.send`），窗口销毁瞬间可能抛错；
   * 队列必须吞掉它并留诊断，否则会击穿 pump（未捕获拒绝 + 剩余任务静默滞留 + 快照谎报 idle）。
   */
  onCallbackError?: (where: string, error: unknown) => void
  onTaskSettled?: (record: UploadTaskRecord) => void
  /** 任务状态变化回调（提交 / 开始 / 结束各一次；用于状态栏即时反映队列，避免轮询） */
  onTaskChanged?: (record: UploadTaskRecord) => void
  /** 便于测试注入确定性 taskId 与时钟 */
  newTaskId?: () => string
  now?: () => number
  /** 排队积压上限，默认 MAX_PENDING；超出时 submit 抛 QUEUE_FULL */
  maxPending?: number
  /** 单任务执行上限（看门狗），默认 DEFAULT_TASK_TIMEOUT_MS */
  taskTimeoutMs?: number
}

interface InternalRecord extends UploadTaskRecord {
  resolve: Array<(record: UploadTaskRecord) => void>
}

/** 上传任务对象对外快照（去掉内部字段） */
function toRecord(record: InternalRecord): UploadTaskRecord {
  const { resolve: _resolve, ...rest } = record
  return { ...rest }
}

/**
 * 状态快照里的轻量任务视图：保留状态/进度/来源，丢掉逐文件明细。
 * 明细只在 `get(taskId)`（相应地 `GET /tasks/:id`）返回。
 */
function toSummary(record: UploadTaskRecord): QueueTaskSummary {
  const { result, ...rest } = record
  if (!result) return rest
  return {
    ...rest,
    result: {
      totalFiles: result.totalFiles,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
      ...(result.cancelled === undefined ? {} : { cancelled: result.cancelled })
    }
  }
}

export function createQueue(options: QueueOptions = {}): DeployQueue {
  const defaultWaitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const onCallbackError = options.onCallbackError
  const onTaskSettled = options.onTaskSettled
  const onTaskChanged = options.onTaskChanged
  const newTaskId = options.newTaskId ?? (() => randomUUID())
  const now = options.now ?? (() => Date.now())
  const maxPending = options.maxPending ?? MAX_PENDING
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS

  const records = new Map<string, InternalRecord>()
  const pending: Array<{ taskId: string; options: SubmitOptions }> = []
  let runningTaskId: string | null = null
  /** 串行推进循环（同时只存在一个） */
  let loop: Promise<void> | null = null

  /** 空闲等待者：队列真正空下来时统一唤醒 */
  const idleWaiters: Array<(drained: boolean) => void> = []

  function notifyIdle(): void {
    if (loop !== null || pending.length > 0 || runningTaskId !== null) return
    for (const waiter of idleWaiters.splice(0)) waiter(true)
  }

  function evictIfNeeded(): void {
    if (records.size <= MAX_TASK_RECORDS) return
    // 只淘汰已结束的记录，且从最旧的开始；运行中与排队中的任务永不淘汰
    const removable = [...records.values()]
      .filter((r) => r.state === 'succeeded' || r.state === 'failed')
      .sort((a, b) => a.createdAt - b.createdAt)
    while (records.size > MAX_TASK_RECORDS && removable.length > 0) {
      const victim = removable.shift() as InternalRecord
      records.delete(victim.taskId)
    }
  }

  /**
   * 任务状态变化上报。
   *
   * 回调由外部注入（主进程里会 webContents.send）：窗口销毁的瞬间 send 可能抛错。
   * 让它冒泡会击穿 pump（未捕获拒绝 + 剩余任务静默滞留、快照谎报 idle），所以逐个吞掉并留诊断。
   */
  function notifyTaskChanged(record: UploadTaskRecord, where: string): void {
    try {
      onTaskChanged?.(record)
    } catch (error) {
      onCallbackError?.(where, error)
    }
  }

  function finish(record: InternalRecord, patch: Partial<UploadTaskRecord>): void {
    Object.assign(record, patch)
    const snapshot = toRecord(record)
    const waiters = record.resolve.splice(0, record.resolve.length)
    for (const waiter of waiters) waiter(snapshot)
    onTaskSettledSafely(snapshot)
    // 注意：这里**不**上报 onTaskChanged。此时 runningTaskId 还没清空，
    // 外部据此取 snapshot() 会读到 running（状态栏永远停在「上传中」）。
    // 状态上报统一放在 run() 的 finally（清空 runningTaskId 之后）。
    // 任务结束后再收敛一次任务表：队列积压时可能临时超过上限（排队中的任务必须保留）
    evictIfNeeded()
  }

  function onTaskSettledSafely(snapshot: UploadTaskRecord): void {
    try {
      onTaskSettled?.(snapshot)
    } catch (error) {
      onCallbackError?.('onTaskSettled', error)
    }
  }

  async function run(entry: { taskId: string; options: SubmitOptions }): Promise<void> {
    const record = records.get(entry.taskId)
    if (!record) return
    runningTaskId = entry.taskId
    record.state = 'running'
    record.startedAt = now()
    // 开始执行也推一次：否则「排队 → 执行中」要等第一个文件传完才反映出来
    notifyTaskChanged(toRecord(record), 'onTaskChanged(start)')

    let timer: NodeJS.Timeout | undefined
    let settled = false
    const controller = new AbortController()
    /** 重新计时（启动时与真正开始传输时各一次） */
    let armWatchdog: () => void = () => undefined
    try {
      // 看门狗：job 与超时竞速。超时时**同时**中止底层传输，否则串行链仍被占着，
      // 后续任务会接着超时（队列看似腾出，实际没恢复正常）。
      const watchdog = new Promise<never>((_resolve, reject) => {
        armWatchdog = (): void => {
          if (settled) return
          if (timer) clearTimeout(timer)
          timer = setTimeout(
            () => {
              controller.abort()
              reject(
                new QueueError(
                  'TASK_TIMEOUT',
                  `任务执行超过 ${Math.round(taskTimeoutMs / 1000)} 秒未结束：已中止传输并标记失败（远端连接可能已假死）`
                )
              )
            },
            taskTimeoutMs
          )
          timer.unref?.()
        }
        armWatchdog()
      })
      const jobPromise = entry.options.job({
        onProgress: (current, total, file) => {
          // 超时后迟到的进度不得再写回记录（否则失败任务又被标成有进度）
          if (settled) return
          // 只写任务记录（GET /tasks/:id 与日志明细要用），**不**跨进程广播：
          // 状态栏已改成队列口径，逐文件推送没有消费方，却会按「文件数 × 窗口数」放大 IPC。
          record.progress = { current, total, file: toSlashes(file) }
        },
        signal: controller.signal,
        markStarted: () => armWatchdog()
      })
      const result = await Promise.race([jobPromise, watchdog])
      settled = true
      record.result = {
        ...result,
        // taskId 以队列生成的为准：DeployResult 里那个是执行层自己生成的时间 ID，
        // 直接透传会让 GET /tasks/<队列 id> 返回一个查不到的 result.taskId（违反 INV-12）。
        taskId: record.taskId,
        // 明细路径与 plan 口径一致（正斜杠）；在此归一，状态快照与任务详情同样受益
        details: (result.details ?? []).map((detail) => ({ ...detail, relativePath: toSlashes(detail.relativePath) }))
      }
      const failed = result.failed > 0
      finish(record, {
        state: failed ? 'failed' : 'succeeded',
        finishedAt: now(),
        cancelled: result.cancelled === true
      })
    } catch (error) {
      settled = true
      const message = error instanceof Error ? error.message : String(error)
      finish(record, {
        state: 'failed',
        finishedAt: now(),
        error: { code: error instanceof QueueError ? error.code : 'CONNECT_FAILED', message }
      })
    } finally {
      if (timer) clearTimeout(timer)
      runningTaskId = null
      // runningTaskId 清空**之后**再上报：外部据此取 snapshot() 才是 idle/waiting，
      // 状态栏不会停在「上传中 N/N」这种假进行中状态。
      notifyTaskChanged(toRecord(record), 'onTaskChanged(settle)')
    }
  }

  /** 串行推进：同一时刻只跑一个任务，完成后取下一个（INV-6） */
  function pump(): void {
    if (loop) return
    loop = (async () => {
      try {
        while (pending.length > 0) {
          const next = pending.shift() as { taskId: string; options: SubmitOptions }
          await run(next)
        }
      } catch (error) {
        // 兜底：run() 内部已 try/catch，走到这里说明是意料之外的位置（如回调二次抛错）。
        // 不兜会变成未捕获拒绝；兜住后仍未处理的任务保持排队，下一次 submit 会继续推进。
        onCallbackError?.('pump', error)
      } finally {
        loop = null
        // 队列真正空下来才唤醒等待者（此前是 1ms 轮询：CPU 白烧且响应不及时）
        notifyIdle()
      }
    })()
  }

  async function waitForIdle(timeoutMs?: number): Promise<boolean> {
    if (loop === null && pending.length === 0 && runningTaskId === null) return true
    return new Promise<boolean>((resolve) => {
      let settled = false
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (settled) return
              settled = true
              resolve(false)
            }, timeoutMs)
      timer?.unref?.()
      idleWaiters.push(() => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(true)
      })
    })
  }

  return {
    submit(options: SubmitOptions): SubmitResult {
      if (pending.length >= maxPending) {
        throw new QueueError(
          'QUEUE_FULL',
          `队列积压已达上限（${maxPending} 个等待中）：请等待既有任务完成后再提交`
        )
      }
      const taskId = newTaskId()
      const record: InternalRecord = {
        taskId,
        state: 'queued',
        progress: { current: 0, total: options.totalFiles, file: '' },
        createdAt: now(),
        origin: options.origin,
        ...(options.client ? { client: options.client } : {}),
        ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
        target: options.target,
        projectRoot: options.projectRoot,
        totalFiles: options.totalFiles,
        resolve: []
      }
      records.set(taskId, record)
      evictIfNeeded()

      pending.push({ taskId, options })
      // 位置包含正在执行的任务：第一个任务提交时报 1（立即执行），执行中再提交的报 2…
      const position = (runningTaskId === null ? 0 : 1) + pending.length
      try {
      onTaskChanged?.(toRecord(record)) // 提交即上报（状态栏可立刻显示「排队 / 执行中」）
    } catch (error) {
      onCallbackError?.('onTaskChanged(submit)', error)
    }
      pump()
      return { taskId, position }
    },

    get(taskId: string): UploadTaskRecord | undefined {
      const record = records.get(taskId)
      return record ? toRecord(record) : undefined
    },

    snapshot(): QueueSnapshot {
      const tasks = [...records.values()].sort((a, b) => a.createdAt - b.createdAt).map((record) => toSummary(toRecord(record)))
      // 有排队就不算空闲：两个任务之间 runningTaskId 会短暂为 null，
      // 只看它会把「还有任务等着跑」谎报成 idle（状态栏闪一下「空闲」）。
      const state: QueueSnapshot['state'] =
        runningTaskId === null ? (pending.length > 0 ? 'waiting' : 'idle') : pending.length > 0 ? 'waiting' : 'running'
      return {
        state,
        runningTaskId,
        pendingCount: pending.length,
        tasks
      }
    },

    async wait(taskId: string, timeoutMs?: number): Promise<UploadTaskRecord> {
      const record = records.get(taskId)
      if (!record) {
        throw new QueueError('UNKNOWN_TASK', `未知任务：${taskId}`)
      }
      if (record.state === 'succeeded' || record.state === 'failed') return toRecord(record)

      const limit = timeoutMs ?? defaultWaitTimeoutMs
      return new Promise<UploadTaskRecord>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          const current = records.get(taskId)
          const stillQueued = !current || current.state === 'queued'
          reject(
            stillQueued
              ? new QueueError('QUEUE_TIMEOUT', `排队超时（等待上限 ${Math.round(limit / 1000)} 秒）：任务 ${taskId} 仍在排队`)
              : new QueueError(
                  'WAIT_TIMEOUT',
                  `等待超时（等待上限 ${Math.round(limit / 1000)} 秒）：任务 ${taskId} 仍在执行，可用 shipit task ${taskId} 查询`
                )
          )
        }, limit)

        record.resolve.push((snapshot) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(snapshot)
        })
      })
    },

    async drain(timeoutMs?: number): Promise<boolean> {
      return waitForIdle(timeoutMs)
    },

    /** 与 drain 等价（计划用例中的命名） */
    async idle(timeoutMs?: number): Promise<boolean> {
      return waitForIdle(timeoutMs)
    },

  }
}
