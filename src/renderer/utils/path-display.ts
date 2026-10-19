/**
 * 路径的紧凑显示（状态栏用）。
 *
 * 长路径整条塞进状态栏会挤掉其它信息，且**末尾**（离用户最近的项目/目录）才是关键，
 * 因此保留**开头（盘符/根）与末尾**，中间用 `…` 省略。完整路径由调用方放进 title 悬停查看。
 *
 * 收缩顺序（保证结果可预测、且不会丢掉开头）：
 * 1. 先按"头段 + … + 尾段"尝试，逐步减少头段（但不少于 keepHead）
 * 2. 仍超长 → 逐步减少尾段（但不少于 1 段）
 * 3. 仍超长（单段名极长等）→ 对最后一段按字符截断
 */

export interface ShortenPathOptions {
  /** 显示上限（字符） */
  maxChars?: number
  /** 至少保留末尾几段（用户最关心的部分） */
  keepTail?: number
  /** 至少保留开头几段（Windows 盘符 / POSIX 根 / UNC 主机等） */
  keepHead?: number
}

const DEFAULT_MAX_CHARS = 52
const DEFAULT_KEEP_TAIL = 2
const DEFAULT_KEEP_HEAD = 1

const ELLIPSIS = '…'

/** 拆成"根标识 + 段列表"：`D:\a\b` → head `D:\`；`/a/b` → head `/`；`\\srv\share\a` → head `\\srv\share` */
function splitPath(raw: string): { head: string; segments: string[] } {
  const unified = raw.trim()
  const drive = /^([A-Za-z]:)[\\/]?/.exec(unified)
  if (drive) {
    return { head: `${drive[1]}\\`, segments: unified.slice(drive[0].length).split(/[\\/]+/).filter(Boolean) }
  }
  const unc = /^(\\\\[^\\/]+\\[^\\/]+)[\\/]?/.exec(unified)
  if (unc) {
    return { head: unc[1], segments: unified.slice(unc[0].length).split(/[\\/]+/).filter(Boolean) }
  }
  if (unified.startsWith('/')) {
    return { head: '/', segments: unified.split('/').filter(Boolean) }
  }
  return { head: '', segments: unified.split(/[\\/]+/).filter(Boolean) }
}

export function shortenPath(raw: string, options: ShortenPathOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const keepTail = Math.max(1, options.keepTail ?? DEFAULT_KEEP_TAIL)
  const keepHead = Math.max(0, options.keepHead ?? DEFAULT_KEEP_HEAD)

  const { head, segments } = splitPath(raw)
  if (segments.length === 0) return head || raw.trim()

  const useBackslash = head.endsWith('\\')
  const sep = useBackslash ? '\\' : '/'
  const join = (parts: string[]): string => {
    if (!head) return parts.join(sep)
    return head.endsWith(sep) ? `${head}${parts.join(sep)}` : `${head}${sep}${parts.join(sep)}`
  }
  const render = (...parts: (string[] | string)[]): string => join(parts.flat() as string[])

  const full = join(segments)
  if (full.length <= maxChars) return full

  const tailSegments = segments.slice(-keepTail)
  const headSegments = segments.slice(0, Math.max(0, segments.length - keepTail))

  // 1) 逐步减少头段（不少于 keepHead），先保证开头可辨、末尾完整
  for (let keep = headSegments.length; keep >= Math.min(keepHead, headSegments.length); keep--) {
    const candidate = render(headSegments.slice(0, keep), ELLIPSIS, tailSegments)
    if (candidate.length <= maxChars) return candidate
  }

  // 2) 头段已压到下限：再减少尾段（不少于 1 段）
  for (let tailCount = tailSegments.length - 1; tailCount >= 1; tailCount--) {
    const candidate = render(headSegments.slice(0, keepHead), ELLIPSIS, segments.slice(-tailCount))
    if (candidate.length <= maxChars) return candidate
  }

  // 3) 兜底：单段名极长（如哈希目录）→ 对最后一段按字符截断
  const prefix = render(headSegments.slice(0, keepHead), ELLIPSIS)
  const last = segments[segments.length - 1]
  const budget = Math.max(1, maxChars - prefix.length - 1)
  return `${prefix}${sep}${last.slice(-budget)}`
}
