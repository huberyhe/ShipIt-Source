/**
 * 全局提示的统一入口。
 *
 * `ToastHost` 仍是唯一的宿主（计时、悬停暂停、去重、渲染都由它负责）；
 * 这里只负责发事件，避免 20+ 处各自拼 `new CustomEvent(...)` 字符串。
 *
 * 两个事件名不能混：`toast` 默认按**错误**样式渲染，成功必须走 `toast-success`。
 */
export function toastError(message: string): void {
  window.dispatchEvent(new CustomEvent('toast', { detail: message }))
}

export function toastSuccess(message: string): void {
  window.dispatchEvent(new CustomEvent('toast-success', { detail: message }))
}
