/**
 * 右键菜单项的类型定义。
 *
 * 为什么单独放在 `.ts` 里而不是 `ContextMenu.vue` 的 `<script setup>` 中：
 * `vue-tsc` 能解析 `.vue` 的导出，但**纯 `tsc --noEmit` 不能**（未声明 `*.vue` 模块），
 * 于是 `import type { ContextMenuItem } from '…/ContextMenu.vue'` 会报 TS2614。
 * 放到普通模块后两种类型检查器都能解析（该类型被 composable 等非 SFC 文件使用）。
 */
import type { Component } from 'vue'

export interface ContextMenuItem {
  label: string
  icon?: Component
  action?: () => void
  children?: ContextMenuItem[]
  danger?: boolean
  disabled?: boolean
  /** 高亮该项（如服务器菜单中的"默认"目标） */
  highlight?: boolean
  /** 快捷键提示文字（显示在项右侧，如 Ctrl+X） */
  shortcut?: string
  /** 该项前的勾选标记（如当前选中的服务器） */
  checked?: boolean
}
