/**
 * 任务结果判定（CLI 与 MCP 共用）。
 *
 * 默认异步提交后，前端按需轮询任务；这里把「任务记录 → 输出信封」的判定集中一处，
 * 保证 CLI 与 MCP 的退出码/错误类别语义完全一致（CON-9）。
 */
import { ERROR_CODES, errEnvelope, metaOf, okEnvelope, type Envelope, type ErrorCode } from './cli-contract'
import type { TaskResultView, UploadTaskRecord } from './types'

/** 任务记录 → 等待结果视图（逐文件明细 + 汇总） */
export function toTaskResultView(record: UploadTaskRecord): TaskResultView {
  const result = record.result
  return {
    taskId: record.taskId,
    state: record.state,
    target: record.target,
    projectRoot: record.projectRoot,
    origin: record.origin,
    summary: {
      totalFiles: result?.totalFiles ?? record.totalFiles,
      succeeded: result?.succeeded ?? 0,
      failed: result?.failed ?? 0,
      skipped: result?.skipped ?? 0,
      duration: result?.duration ?? 0,
      cancelled: record.cancelled ?? result?.cancelled ?? false
    },
    // 明细路径由队列在写入时就已归一为正斜杠（与 plan 口径一致）
    details: result?.details ?? []
  }
}

/** 白名单判定：记录里的 code 是字符串，只有已知类别才可直接用作信封错误类别 */
function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value)
}

/** 是否已到终态（succeeded / failed） */
export function isTerminal(record: UploadTaskRecord): boolean {
  return record.state === 'succeeded' || record.state === 'failed'
}

/**
 * 终态判定：
 * - 有失败文件 → PARTIAL（退出码 2），明细放在 data.details（失败外壳带明细，SPEC 部分失败）
 * - 全部成功 → 成功信封（含逐文件明细与汇总）
 */
export function verdictOf(record: UploadTaskRecord): Envelope {
  const view = toTaskResultView(record)
  if (record.state === 'failed' && view.summary.failed > 0) {
    return errEnvelope(
      'PARTIAL',
      `部分文件上传失败：成功 ${view.summary.succeeded} / 失败 ${view.summary.failed}`,
      '失败明细见 data.details；已上传文件保留，不做远端自动回滚',
      view
    )
  }
  if (record.state === 'failed') {
    // 队列在失败时写入了具体错误类别（如看门狗超时 TASK_TIMEOUT）；只有拿不到已知类别时才退化为连接类
    // （此前一律 CONNECT_FAILED + "请检查目标连通性与凭据"，会把排障引向网络/凭据的错误方向）
    const stored = record.error?.code
    if (stored && isErrorCode(stored)) {
      return errEnvelope(stored, record.error?.message ?? '上传任务失败', undefined, view)
    }
    return errEnvelope(
      'CONNECT_FAILED',
      record.error?.message ?? '上传任务失败',
      '请检查目标连通性与凭据',
      view
    )
  }
  // 被取消：已上传文件保留、剩余文件未处理；不能报告为整体成功，
  // 否则调用方会误以为全部文件都已上传（INV-9：不出现看似成功的假象）
  if (view.summary.cancelled) {
    const remaining = view.summary.totalFiles - view.summary.succeeded - view.summary.failed
    return errEnvelope(
      'PARTIAL',
      `上传被取消：已成功 ${view.summary.succeeded} / 共 ${view.summary.totalFiles}，剩余 ${remaining} 个未处理`,
      '已上传文件保留，不做远端自动回滚；可重新执行同一计划（覆盖式上传）',
      view
    )
  }
  return okEnvelope(view, metaOf({ count: view.summary.totalFiles, extra: { state: record.state } }))
}

/**
 * 任务查询（CLI `task` / MCP `task_status`）的信封修正：终态判定此前只在 `--wait` 路径生效。
 *
 * 被取消但没有失败文件的任务，记录里是 `state='succeeded'` + `cancelled=true`；
 * 直接返回裸记录会让调用方按 state 误判为「全部成功」（INV-9：不得出现看似成功的假象）。
 * 这里保持 data 形状不变（仍是任务记录），只在语义上降级为 PARTIAL。
 */
export function correctTaskEnvelope(envelope: Envelope): Envelope {
  if (!envelope.ok) return envelope
  const record = envelope.data as UploadTaskRecord | undefined
  if (!record || !isTerminal(record)) return envelope

  // 与 `--wait` 走**同一套终态判定**（此前只处理"被取消"，失败任务会被报成 ok/退出码 0：
  // 同一份记录在 `deploy --wait` 是 PARTIAL/exit 2、在 `shipit task` 却是成功 —— 违反 INV-9，
  // 也让"提交后用 task 轮询收尾"的标准用法失效）。
  // data 仍是任务记录本身（保持 `task` 的输出形状与既有消费方兼容）。
  const verdict = verdictOf(record)
  if (verdict.ok) return envelope
  return errEnvelope(verdict.error.code, verdict.error.message, verdict.error.hint, record)
}

/**
 * 等待超时判定：仍在排队 → QUEUE_TIMEOUT（忙碌类）；已在执行 → WAIT_TIMEOUT。
 * 两种情况都不取消任务（AC-019 / AC-036）。
 */
export function timeoutVerdict(taskId: string, lastState: UploadTaskRecord['state'] | null, timeoutSeconds: number): Envelope {
  const stillQueued = lastState === null || lastState === 'queued'
  return stillQueued
    ? errEnvelope(
        'QUEUE_TIMEOUT',
        `排队超时（等待上限 ${timeoutSeconds} 秒）：任务 ${taskId} 仍在排队`,
        '队列繁忙，可稍后用 shipit task 查询该任务'
      )
    : errEnvelope(
        'WAIT_TIMEOUT',
        `等待超时（等待上限 ${timeoutSeconds} 秒）：任务 ${taskId} 仍在执行`,
        `任务未取消，可用 shipit task ${taskId} 查询最终结果`
      )
}
