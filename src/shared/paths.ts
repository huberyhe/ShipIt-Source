/**
 * 路径口径工具（前端与主进程共用）。
 *
 * DFX-PORT-001：对外输出的相对路径统一为正斜杠，避免同一路径在 plan 与 deploy 结果里
 * 呈现为 `dist/a.js` 与 `dist\a.js` 两种写法。
 */

/** 反斜杠归一为正斜杠 */
export function toSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}
