/**
 * 内容区上下文的 Tab 顺序修正。
 *
 * 为什么需要：行是 `tabindex=-1`（由方向键进入，不在 Tab 序列里），而表头按钮/筛选
 * 控件是正常可 Tab 的。它们在 DOM 里排在行**之前**，于是：
 * - 从行按 Shift+Tab → 浏览器回到「行之前最近的可 Tab 元素」= 表头最后一个控件（进入区内）；
 * - 从行按 Tab → 行之后再无区内元素 → 直接离开内容区。
 * 两条路径不一致（一条进表头、一条出区）。
 *
 * 统一成「两个方向都从表头/筛选控件开始，再离开」：
 * 从行按 Tab 时人为把焦点交给区内的第一个可 Tab 元素（与 Shift+Tab 的落点互为逆序），
 * 之后浏览器默认的 Tab 顺序把剩下的控件走完再离开。
 */

const TABBABLE = 'a[href], button, select, input, textarea, [tabindex]'

function tabbablesIn(zone: HTMLElement): HTMLElement[] {
  return Array.from(zone.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0
  )
}

/** 焦点当前是否在「行」上（行是 -1，不是原生控件） */
export function isOnRow(zone: HTMLElement): boolean {
  const active = document.activeElement as HTMLElement | null
  if (!active || !zone.contains(active)) return false
  return !active.matches('button, select, input, textarea, a[href], [contenteditable="true"]')
}

/**
 * 从行按 Tab：把焦点交给区内第一个可 Tab 元素，返回是否处理。
 * 区内没有可 Tab 元素时返回 false（交给浏览器默认行为，直接离开内容区）。
 */
export function tabIntoZoneControls(zone: HTMLElement): boolean {
  const first = tabbablesIn(zone)[0]
  if (!first) return false
  first.focus()
  return true
}

/**
 * 从区内**第一个**可 Tab 元素按 Shift+Tab：直接离开内容区。
 *
 * 不拦的话浏览器会把焦点交给容器（tabindex=0）——那是一个「看不见的停靠点」，
 * 用户要再按一次 Shift+Tab 才出得去，与正向「最后一个控件按 Tab 直接离开」不对称。
 */
export function leaveZoneBackward(zone: HTMLElement): boolean {
  const inside = tabbablesIn(zone)
  const active = document.activeElement as HTMLElement | null
  if (!active || !zone.contains(active)) return false
  // 区内没有可 Tab 控件时（表头图标按钮都是 -1），行就是「最前面」，
  // 此时 Shift+Tab 也应一步出区，否则会先落到不可见的容器上（要按两次）
  if (inside.length === 0) {
    if (!isOnRow(zone)) return false
  } else if (active !== inside[0]) {
    return false
  }
  const all = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0
  )
  // 锚点：区内第一个可 Tab 元素；区内没有控件时用容器自身（tabindex=0，必在序列里）
  const anchor = inside.length > 0 ? inside[0] : zone
  const startIdx = all.indexOf(anchor)
  if (startIdx < 0) return false
  // 向前找**第一个在区外**的元素：紧邻的可能是容器自身，直接取上一个会又落回区内
  for (let i = startIdx - 1; i >= 0; i--) {
    const candidate = all[i]
    if (zone.contains(candidate)) continue
    candidate.focus()
    return true
  }
  return false
}
