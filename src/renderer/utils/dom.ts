/**
 * DOM 判定工具（全局快捷键/弹窗/失焦逻辑共用）。
 *
 * 这套「焦点是否在输入控件里」的判断此前在 5 处各写一遍，其中一版是
 * `active.matches('input, textarea, select, [contenteditable="true"]')` 的字符串写法，
 * 与 tagName 判断组合后语义容易漂移（例如 `contenteditable` 的继承、select 的 multiple）。
 * 收敛成一处，改口径只改这里。
 */
const TEXT_INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** 目标元素是否是可输入控件（含 contenteditable） */
export function isTextInputTarget(target: EventTarget | Element | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  if (TEXT_INPUT_TAGS.has(element.tagName)) return true
  return element.isContentEditable === true || element.closest?.('[contenteditable="true"]') !== null
}
