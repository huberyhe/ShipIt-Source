/**
 * 顶部提示（toast）的停留时长策略。
 *
 * 错误信息（连接失败原因、端口占用等）常需要阅读甚至复制，4 秒不够，容易被错过；
 * 成功提示短暂即可，避免遮挡。悬停时暂停计时（见 AppLayout）——这是纯函数部分，便于单测。
 */
export type ToastType = 'success' | 'error'

/** 停留时长（毫秒） */
export function toastDurationMs(type: ToastType): number {
  return type === 'error' ? 12_000 : 4_000
}

/** 悬停离开后剩余时长（已过时间超过总时长则为 0） */
export function remainingMs(elapsedMs: number, totalMs: number): number {
  return Math.max(0, totalMs - Math.max(0, elapsedMs))
}
