/**
 * 全局快捷键的**唯一来源**（展示层）。
 *
 * 背景：同一批组合在 4 处各写一份——`ShortcutsDialog` 的 `keys` 数组、`AppMenuBar` 的
 * `shortcut: 'Ctrl+O'`、右键菜单的 `shortcut: 'Ctrl+X'`、`App.vue` 的 `e.code` 分发。
 * 改一个键位要同步 3~4 个文件，且菜单显示 `Ctrl+1`、弹窗显示 `Ctrl` `1`、按钮显示 `(Esc)`。
 *
 * 边界：这里只管**展示**（键位长什么样、属于哪一组）。真正的按键分发仍在 `App.vue` 的
 * `e.code` 判定里——显示与生效解耦，避免改文案时误动行为。
 */
export type ShortcutGroup = '定位' | '上传' | '视图'

export interface ShortcutDef {
  /** 键位分段，用于渲染键帽：['Ctrl', '1'] */
  keys: string[]
  /** 说明文案 */
  label: string
  group: ShortcutGroup
}

export const SHORTCUTS = {
  openProject: { keys: ['Ctrl', 'O'], label: '打开目录', group: '定位' },
  viewFiletree: { keys: ['Ctrl', '1'], label: '文件树', group: '定位' },
  viewChanges: { keys: ['Ctrl', '2'], label: 'Git 变更', group: '定位' },
  viewLog: { keys: ['Ctrl', '3'], label: 'Git 日志', group: '定位' },
  settings: { keys: ['Ctrl', ','], label: '设置', group: '定位' },
  closeProject: { keys: ['Ctrl', 'W'], label: '关闭项目窗口', group: '定位' },
  shortcutsHelp: { keys: ['F1'], label: '打开本页（快捷键说明）', group: '定位' },
  uploadSelection: { keys: ['Ctrl', 'X'], label: '上传选中的全部文件', group: '上传' },
  uploadTo: { keys: ['Ctrl', 'Shift', 'X'], label: '选择服务器后再上传', group: '上传' },
  expandAll: { keys: ['Ctrl', 'Shift', '='], label: '全部展开（= 键；小键盘 + 同效）', group: '视图' },
  collapseAll: { keys: ['Ctrl', 'Shift', '-'], label: '全部收起（小键盘 - 同效）', group: '视图' },
  refreshView: { keys: ['F5'], label: '刷新当前视图', group: '视图' }
} as const satisfies Record<string, ShortcutDef>

export type ShortcutId = keyof typeof SHORTCUTS

/** 键位分段 */
export function shortcutKeys(id: ShortcutId): string[] {
  return [...SHORTCUTS[id].keys]
}

/** 单行文本形式（菜单右侧、按钮提示用） */
export function shortcutLabel(id: ShortcutId): string {
  return SHORTCUTS[id].keys.join('+')
}
