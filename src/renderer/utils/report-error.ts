/**
 * 渲染层的"失败必须可见"工具。
 *
 * 背景：多处 catch 是空的（`// ignore`），于是"磁盘只读导致主题没保存""目标列表加载失败"
 * 这类问题表现为"界面看起来正常"（主题改完重启又变回去、目标显示为空），
 * 用户与排查者都无从下手。这里统一为：`console.warn` 留痕 + 应用内提示（复用 ToastHost 的 toast 事件）。
 *
 * `silent` 用于启动期/高频路径（例如首帧主题读取），只留痕不弹提示，避免打扰。
 */
import { toastError } from './toast'

export function reportError(action: string, error?: unknown, options: { silent?: boolean } = {}): void {
  const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error)
  const message = detail ? `${action}：${detail}` : action
  console.warn('[shipit]', message)
  if (!options.silent) {
    toastError(message)
  }
}

/** 只留痕不打扰（启动期、轮询等高频路径用） */
export function warnOnly(action: string, error?: unknown): void {
  reportError(action, error, { silent: true })
}
