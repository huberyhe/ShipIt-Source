/**
 * 任务等待（CLI `--wait` 与 MCP `wait` 共用）。
 *
 * 服务端始终异步（提交即返回 taskId），等待由前端轮询实现：
 * 到终态即返回判定结果；到达等待上限按当前状态返回 QUEUE_TIMEOUT / WAIT_TIMEOUT，
 * 且**不取消任务**（AC-019 / AC-036）。
 */
import type { Envelope } from '../shared/cli-contract'
import type { UploadTaskRecord } from '../shared/types'
import { isTerminal, timeoutVerdict, verdictOf } from '../shared/task-verdict'
import { toEnvelope, type ServerClient } from './client'

export const DEFAULT_POLL_INTERVAL_MS = 500

export interface WaitOptions {
  /** 等待上限（秒） */
  timeoutSeconds: number
  pollIntervalMs?: number
  /** 便于测试注入 */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitForTask(client: ServerClient, taskId: string, options: WaitOptions): Promise<Envelope> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? ((): number => Date.now())
  const deadline = now() + options.timeoutSeconds * 1000

  let lastState: UploadTaskRecord['state'] | null = null

  for (;;) {
    const result = await client.get(`/tasks/${encodeURIComponent(taskId)}`)
    if (!result.ok) return toEnvelope(result)

    const envelope = result.envelope
    if (!envelope.ok) return envelope

    const record = envelope.data as UploadTaskRecord
    lastState = record.state
    if (isTerminal(record)) return verdictOf(record)
    if (now() >= deadline) return timeoutVerdict(taskId, lastState, options.timeoutSeconds)

    await sleep(pollIntervalMs)
  }
}
