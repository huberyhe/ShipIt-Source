/**
 * Git 视图的 UI 类型（与视图/树组件共用）。
 *
 * 为什么放在这里而不是组件里：`vue-tsc` 能解析从 `.vue` 导出的类型，
 * 纯 `npx tsc --noEmit` 不能（TS2614）。UI 类型不该寄生在 SFC 里。
 * 与 `types/context-menu.ts` 同一口径。
 */
import type { ChangeStatus } from '../utils/change-status'

/** 变更树节点（目录由路径分段合成，文件来自 git status） */
export interface ChangeTreeNode {
  name: string
  path: string
  isDirectory: boolean
  children: ChangeTreeNode[]
  change: {
    status: string
    label: string
    cssClass: string
    /** 统一词汇表后的语义状态（可选：旧数据可能只有 status 字符串） */
    kind?: ChangeStatus
  } | null
}
