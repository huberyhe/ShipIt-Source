<script setup lang="ts">
import { toastError } from '../../utils/toast'
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useFilesStore } from '../../stores/files'
import type { FileEntry } from '../../stores/files'
import { ChevronsUpDown, ChevronsDownUp } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import { useSelectionDeploy } from '../../composables/useSelectionDeploy'
import { useProjectStore } from '../../stores/project'
import FileTreeNode from '../filetree/FileTreeNode.vue'
import EmptyState from '../common/EmptyState.vue'
import ViewHeader from '../common/ViewHeader.vue'
import ContextMenu from '../common/ContextMenu.vue'
import ServerTargetMenu from '../common/ServerTargetMenu.vue'
import { useDeployHotkeys } from '../../composables/useDeployHotkeys'
import { isEscapeKey, isSelectAllKey, parentRowOf, rowPaths, visibleRows } from '../../utils/tree-keyboard'
import { isOnRow, leaveZoneBackward, tabIntoZoneControls } from '../../utils/focus-zone'
import { useServerMenu } from '../../composables/useServerMenu'
import { useContentKeyFallback } from '../../composables/useContentKeyFallback'

const filesStore = useFilesStore()
const deployStore = useDeployStore()
const projectStore = useProjectStore()
const expandAllFlag = ref(false)
const collapseAllCounter = ref(0)

/**
 * 内容区键盘：**全部在容器上处理**（事件冒泡上来）。
 *
 * 之前把按键绑在每一行上，行是 tabindex=-1、焦点靠代码转移，
 * 一旦焦点没落在行上（Shift+Tab 回容器、鼠标点空白等）按键就"失效"。
 * 现在统一按 event.target 找当前行，行/容器两种起点都能工作。
 */

/** 区内外切换：从行回到容器时停在容器上，否则 Shift+Tab 会被推回首行、出不去 */
/** 上次聚焦的行（Tab 离开后回来时恢复，而不是每次都回到第一行） */
let lastRowPath = ''
const zoneEl = ref<HTMLElement | null>(null)
// 焦点不在内容区时（刚打开项目/点过工具条）按空格也能选中
useContentKeyFallback(zoneEl, '.ftn-row')

function onContentFocus(event: FocusEvent): void {
  const zone = event.currentTarget as HTMLElement
  const targetRow = (event.target as HTMLElement).closest?.<HTMLElement>('.ftn-row')
  if (event.target !== zone) {
    // 焦点落在某一行：记住它
    if (targetRow?.dataset.path) lastRowPath = targetRow.dataset.path
    return
  }
  const from = event.relatedTarget as Node | null
  if (from && zone.contains(from)) return   // 从区内 Shift+Tab 回来：停在容器，允许继续退出
  const rows = Array.from(zone.querySelectorAll<HTMLElement>('.ftn-row'))
  const remembered = lastRowPath ? rows.find((row) => row.dataset.path === lastRowPath) : null
  const target = remembered ?? rows[0]
  if (!target) return
  // 只移焦点，不改选区（选中由空格/回车/点击完成，与「蓝底=选中、边框=焦点」对应）
  target.focus()
}

function onContentKeydown(event: KeyboardEvent): void {
  // 原生控件上的按键交给控件自己（下拉改值、按钮激活），内容区不接管
  if (event.key === 'Tab' && event.shiftKey) {
    // 区内第一个控件 Shift+Tab：跳过「不可见的容器停靠点」直接出区（与正向对称）
    if (leaveZoneBackward(event.currentTarget as HTMLElement)) {
      event.preventDefault()
      return
    }
  }
  if ((event.target as HTMLElement).closest?.('button, select, input, textarea, a[href], [contenteditable="true"]')) return

  // 行不在 Tab 序列里：Tab 与 Shift+Tab 都要从「表头/筛选控件」这一侧进出，
  // 否则一个方向进表头、另一个方向直接出区（路径不一致）
  const zoneElNow = event.currentTarget as HTMLElement
  if (event.key === 'Tab' && !event.shiftKey && isOnRow(zoneElNow) && tabIntoZoneControls(zoneElNow)) {
    event.preventDefault()
    return
  }

  const zone = event.currentTarget as HTMLElement
  const rows = visibleRows(zone, '.ftn-row')
  if (rows.length === 0) return
  const row = (event.target as HTMLElement).closest<HTMLElement>('.ftn-row')
  const index = row ? rows.indexOf(row) : -1
  const path = row?.dataset.path ?? ''

  /** 方向键只移动焦点；选区必须由空格/回车/鼠标点击显式改变 */
  const focusAt = (next: number): void => {
    rows[next]?.focus()
  }
  const expandButton = (el: HTMLElement | null): HTMLElement | null =>
    el?.querySelector<HTMLElement>('.ftn-expand') ?? null

  if (isSelectAllKey(event)) {
    event.preventDefault()
    filesStore.selectDeployPaths(rowPaths(rows))
    return
  }
  if (isEscapeKey(event)) {
    event.preventDefault()
    filesStore.clearSelection()
    return
  }

  switch (event.key) {
    case ' ':
    case 'Spacebar':
      event.preventDefault()
      if (index < 0) { focusAt(0); return }
      // 空格=选中；Ctrl/Cmd+空格=多选切换（Windows 输入法可能占用，另提供 Ctrl+Enter）
      filesStore.selectDeployPath(path, event.ctrlKey || event.metaKey ? 'toggle' : 'replace')
      return
    case 'Enter':
      event.preventDefault()
      if (index < 0) { focusAt(0); return }
      if (event.ctrlKey || event.metaKey) {
        filesStore.selectDeployPath(path, 'toggle')
        return
      }
      if (expandButton(row)) {
        event.stopPropagation()
        ;(expandButton(row) as HTMLElement).click()
      } else {
        filesStore.selectDeployPath(path)
      }
      return
    case 'ArrowDown':
      event.preventDefault()
      focusAt(index < 0 ? 0 : index + 1)
      return
    case 'ArrowUp':
      event.preventDefault()
      focusAt(index < 0 ? rows.length - 1 : index - 1)
      return
    case 'ArrowRight': {
      event.preventDefault()
      const btn = expandButton(row)
      const expanded = row?.getAttribute('aria-expanded') === 'true'
      if (btn && !expanded) btn.click()
      else focusAt(index + 1)
      return
    }
    case 'ArrowLeft': {
      event.preventDefault()
      const btn = expandButton(row)
      const expanded = row?.getAttribute('aria-expanded') === 'true'
      if (btn && expanded) {
        btn.click()
        return
      }
      // 回父目录：只移焦点
      parentRowOf(rows, index)?.focus()
      return
    }
    default:
      return
  }
}

// 选中项上传（Ctrl+X / 右键「快速上传」/ 服务器菜单共用）
const { deploySelection } = useSelectionDeploy()

// 服务器选择菜单（Ctrl+Shift+X 唤起 / 右键「上传到」，数字键或鼠标选择）
const { serverMenu, openServerMenu, closeServerMenu } = useServerMenu((targetId) => {
  void deploySelection(targetId)
})

useDeployHotkeys(
  () => filesStore.deploySelection.length > 0,
  () => !!serverMenu.value,
  () => { void deploySelection() },
  () => {
    const pos = filesStore.selectedDeployPos || { x: 240, y: 160 }
    openServerMenu(pos.x, pos.y)
  }
)

function handleExpandAll() { expandAllFlag.value = true }
function handleCollapseAll() { expandAllFlag.value = false; collapseAllCounter.value++ }

// Ctrl+Shift++ / Ctrl+Shift+- （由 App 统一派发；只有当前挂载的视图会收到）
onMounted(() => {
  window.addEventListener('tree-expand-all', handleExpandAll)
  window.addEventListener('tree-collapse-all', handleCollapseAll)
})
onUnmounted(() => {
  window.removeEventListener('tree-expand-all', handleExpandAll)
  window.removeEventListener('tree-collapse-all', handleCollapseAll)
})

const rootChildren = computed(() => filesStore.fileTree?.children || [])

// 统计已加载的目录数与文件数（说明只统计已加载部分）
const loadedDirs = computed(() => countDirs(rootChildren.value))
const loadedFiles = computed(() => countFiles(rootChildren.value))

function countDirs(entries: any[]): number {
  let n = 0
  for (const e of entries) { if (e.isDirectory) { n++; if (e.children) n += countDirs(e.children) } }
  return n
}
function countFiles(entries: any[]): number {
  let n = 0
  for (const e of entries) { if (!e.isDirectory) n++; else if (e.children) n += countFiles(e.children) }
  return n
}
</script>

<template>
  <div ref="zoneEl" class="filetree-view" data-focus-zone tabindex="0" @keydown="onContentKeydown" @focusin="onContentFocus">
    <ViewHeader title="文件树">
      <template #meta>
        <span class="file-count" v-if="filesStore.fileTree" :title="`已加载 ${loadedFiles} 个文件、${loadedDirs} 个目录`">{{ loadedFiles }} 文件 · {{ loadedDirs }} 目录</span>
      </template>
      <template #actions>
        <button class="icon-btn" tabindex="-1" title="全部展开" aria-label="全部展开" @click="handleExpandAll">
          <ChevronsUpDown :size="14" />
        </button>
        <button class="icon-btn" tabindex="-1" title="全部收起" aria-label="全部收起" @click="handleCollapseAll">
          <ChevronsDownUp :size="14" />
        </button>
      </template>
    </ViewHeader>
    <div class="file-list">
      <FileTreeNode v-for="entry in rootChildren" :key="entry.path" :entry="entry" :depth="0"
        :expand-all="expandAllFlag" :collapse-all="collapseAllCounter" />
      <EmptyState v-if="rootChildren.length === 0 && !filesStore.isLoading" text="目录为空" size="page" />
    </div>
    <ServerTargetMenu :menu="serverMenu" @close="closeServerMenu" />
  </div>
</template>

<style scoped>
/* 焦点容器本身不画外框：焦点会立即交给首行（否则会出现一条蓝色竖线） */
.filetree-view:focus-visible { outline: none; }
.filetree-view { display: flex; flex-direction: column; height: 100%; }
.file-count { color: var(--fg2); font-size: 11px; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--fg2); }
.icon-btn:hover { background: var(--bg3); color: var(--fg); }
.file-list { flex: 1; overflow-y: auto; padding: 4px 0; }
</style>
