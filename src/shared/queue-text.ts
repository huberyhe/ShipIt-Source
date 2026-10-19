/**
 * 队列状态文案（**唯一实现**）。
 *
 * 状态栏、设置页、托盘都要显示同一个「队列状态」：写三份必然会漂移
 * （此前状态栏显示逐文件进度、托盘什么都不显示，同一队列三种口径）。
 *
 * 只吃 `runningTaskId` / `pendingCount` 两个字段，所以既适用于完整快照，
 * 也适用于只带了摘要的调用方。
 */
import type { QueueSnapshot } from './types'

export function queueTextOf(queue: Pick<QueueSnapshot, 'runningTaskId' | 'pendingCount'>): string {
  const pending = queue.pendingCount
  if (queue.runningTaskId !== null) return pending > 0 ? `队列 上传中 · 排队 ${pending}` : '队列 上传中'
  if (pending > 0) return `队列 排队 ${pending}`
  return '队列 空闲'
}
