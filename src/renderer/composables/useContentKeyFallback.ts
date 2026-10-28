import { onMounted, onUnmounted, type Ref } from 'vue'

/** 只有这些键才兜底：会改选区的导航键，其余（字母、F5 等）一概不碰 */
const FALLBACK_KEYS = new Set([' ', 'Spacebar', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
const EDITABLE = 'input, textarea, select, [contenteditable="true"]'
/** 空格/方向键在这些控件上有原生语义（激活/切换），不能被内容区接管 */
const CONTROL = 'button, a[href], summary, [role="tab"], [role="tablist"], [role="button"], [role="menuitem"]'

/**
 * 内容区按键兜底：焦点不在内容区里时（刚打开项目、点过标题栏/状态栏、弹窗关闭后焦点回到 body），
 * 第一次按空格或方向键也应落到内容区当前行，而不是被丢弃。
 *
 * 做法：把焦点交给内容区（触发 focusin → 恢复上次行），再把同一个按键派发到该行，
 * 让视图原有的容器级 `@keydown` 处理逻辑照常生效（不复制第二套键盘逻辑）。
 *
 * 边界：输入框/下拉框内、按钮等控件上、菜单或弹窗打开时不介入。
 */
export function useContentKeyFallback(zone: Ref<HTMLElement | null>, rowSelector: string): void {
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return
    const isMultiSelectKey = event.key === 'Enter' && (event.ctrlKey || event.metaKey)
    if (!FALLBACK_KEYS.has(event.key) && !isMultiSelectKey) return
    const el = zone.value
    if (!el) return
    const active = document.activeElement as HTMLElement | null
    if (active && el.contains(active)) return
    const target = event.target as HTMLElement | null
    if (target?.closest?.(EDITABLE) || active?.closest?.(EDITABLE)) return
    if (active?.closest?.(CONTROL)) return
    // 菜单/弹窗有自己的方向键语义，不能抢
    if (active?.closest?.('[role="menu"], [role="dialog"]')) return
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return

    el.focus()
    const focused = document.activeElement as HTMLElement | null
    const row = focused === el ? el : (focused?.closest?.(rowSelector) ?? null)
    if (!row || !el.contains(row)) return
    event.preventDefault()
    row.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        bubbles: true,
        cancelable: true
      })
    )
  }

  onMounted(() => window.addEventListener('keydown', onWindowKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))
}
