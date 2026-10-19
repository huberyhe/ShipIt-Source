/**
 * 终端文本对齐（CLI 专用）。
 *
 * 终端里中文/全角字符占 **2 列**，按 `String.length` 补空格会让含中文的列错位
 * （`--help` 的参数列、变更路径列都会歪）。这里只按「显示宽度」计算，
 * 不引入依赖：East Asian Wide / Fullwidth 的常用区间记 2，其余记 1。
 */

/** 宽字符（东亚洲宽 / 全角）区间 */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/

/** 字符串在终端中的显示宽度（宽字符/全角计 2 列） */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += WIDE.test(char) ? 2 : 1
  return width
}

/** 按显示宽度右侧补空格对齐（已超宽则原样返回，不截断） */
export function padEndDisplay(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}
