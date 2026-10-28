/**
 * 树/列表的键盘导航（文件树与 Git 变更树共用）。
 *
 * 约定（与 VS Code 资源管理器一致）：
 * - ↑/↓ 在**可见行**之间移动焦点；
 * - → 展开目录（已展开时进入第一个子节点）；← 收起目录（已收起时回到父节点）；
 * - Space 切换选中；Enter 激活（目录展开/收起，文件选中）；
 * - Ctrl+A 选中当前可见行；Esc 清空选区；
 * - 行自身是 `tabindex=0/-1`（roving tabindex），Tab 不会逐个扫过几百行。
 *
 * 这里只处理「行集合与焦点」的纯 DOM 逻辑，不碰业务状态。
 */
export function visibleRows(container: Element | null, selector: string): HTMLElement[] {
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>(selector))
}

export function rowIndexOf(current: HTMLElement, rows: HTMLElement[]): number {
  return rows.indexOf(current)
}

/** 把焦点移到指定位置；越界返回 false（交给调用方决定是否冒泡） */
export function focusRowAt(rows: HTMLElement[], index: number): boolean {
  const target = rows[index]
  if (!target) return false
  target.focus()
  return true
}

/** 父行：向上找第一个 depth 更小的行（用于 ← 从子节点回到父目录） */
export function parentRowOf(rows: HTMLElement[], index: number, depthAttr = 'data-depth'): HTMLElement | null {
  const current = rows[index]
  if (!current) return null
  const depth = Number(current.dataset.depth ?? '0')
  for (let i = index - 1; i >= 0; i--) {
    if (Number(rows[i].dataset.depth ?? '0') < depth) return rows[i]
  }
  return null
}

/** 当前可见行的路径（顺序），供 Ctrl+A / Shift 区间使用 */
export function rowPaths(rows: HTMLElement[]): string[] {
  return rows.map((row) => row.dataset.path ?? '').filter(Boolean)
}

/** Ctrl/Cmd+A */
export function isSelectAllKey(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a'
}

/** Esc（清空选区） */
export function isEscapeKey(event: KeyboardEvent): boolean {
  return event.key === 'Escape'
}
