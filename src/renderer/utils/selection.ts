/**
 * 多选语义的**唯一实现**（文件树与 Git 变更树共用）。
 *
 * 背景：两棵树此前各写一份，已经漂移——`Ctrl+Shift` 在文件树走「区间」、在 Git 树走「切换」；
 * 区间右端一处是「点击行」、另一处是「最后一行」；锚点更新规则也不同。
 * 这里把「按键 → 模式」和「模式 + 当前状态 → 新状态」收敛成纯函数，两处只保留「从哪里拿可见顺序」的差异。
 *
 * 规则（与资源管理器一致）：
 * - Shift 优先于 Ctrl：`Ctrl+Shift+点击` 走区间；
 * - `replace` / `toggle` 会把锚点更新为本次点击项；`range` **不改**锚点（否则第二次 Shift 就退化成单点）；
 * - 区间任一端不在可见顺序里（折叠、刷新）→ 退化为单选，不静默产生错误区间。
 */
export type SelectionMode = 'replace' | 'toggle' | 'range'

export interface SelectionState {
  /** 选中项（顺序即加入顺序；区间选择时是可见顺序的一段） */
  paths: string[]
  /** 区间锚点：最近一次 replace / toggle 的项 */
  anchor: string | null
}

export interface SelectionAction {
  /** 本次点击项 */
  path: string
  mode: SelectionMode
  /** 当前可见行顺序（仅 range 需要）；缺失时退化为单选 */
  order?: string[]
}

/** 按键 → 选择模式（Shift 优先，其次 Ctrl/Cmd，否则替换） */
export function resolveSelectionMode(event: {
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}): SelectionMode {
  if (event.shiftKey) return 'range'
  if (event.ctrlKey || event.metaKey) return 'toggle'
  return 'replace'
}

export function reduceSelection(state: SelectionState, action: SelectionAction): SelectionState {
  const { path, mode, order } = action

  if (mode === 'range') {
    const anchor = state.anchor
    if (!anchor || !order || order.length === 0) return { paths: [path], anchor: path }
    const from = order.indexOf(anchor)
    const to = order.indexOf(path)
    if (from < 0 || to < 0) return { paths: [path], anchor: path }
    // 锚点保持不变：连续 Shift 才是「伸缩」而不是「重新开始」
    return { paths: order.slice(Math.min(from, to), Math.max(from, to) + 1), anchor }
  }

  if (mode === 'toggle') {
    const exists = state.paths.includes(path)
    return {
      paths: exists ? state.paths.filter((p) => p !== path) : [...state.paths, path],
      anchor: path
    }
  }

  return { paths: [path], anchor: path }
}

/** 跨视图/跨分隔符统一的去重键：POSIX 分隔符 + Windows 小写 */
export function selectionKey(path: string, platform: string = typeof process !== 'undefined' ? process.platform : 'win32'): string {
  const slashed = path.replace(/\\/g, '/')
  return platform === 'win32' ? slashed.toLowerCase() : slashed
}
