<script setup lang="ts">
import { toastError } from '../../utils/toast'
import { ref, computed, watch } from 'vue'
import { reportError } from '../../utils/report-error'
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, Wrench, Server } from 'lucide-vue-next'
import type { FileEntry } from '../../stores/files'
import { useFilesStore } from '../../stores/files'
import { useDeployStore } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import ContextMenu from '../common/ContextMenu.vue'
import ServerTargetMenu from '../common/ServerTargetMenu.vue'
import TreeRow from '../common/TreeRow.vue'
import type { ContextMenuItem } from '../../types/context-menu'
import { useServerMenu } from '../../composables/useServerMenu'

const props = defineProps<{
  entry: FileEntry; depth: number
  expandAll?: boolean; collapseAll?: number
}>()

const deployStore = useDeployStore()
const projectStore = useProjectStore()
const filesStore = useFilesStore()

const expanded = ref(false)
const isSelected = computed(() => filesStore.selectedDeployEntry?.path === props.entry.path)

function selectSelf(e: MouseEvent) {
  filesStore.selectDeployEntry(props.entry, { x: e.clientX, y: e.clientY })
}
const children = ref<FileEntry[]>([])
const isDeploying = ref(false)
const ctxMenu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)

watch(() => props.expandAll, (v) => { if (v && props.entry.isDirectory && !expanded.value) loadAndExpand() })
watch(() => props.collapseAll, () => { expanded.value = false })

async function loadAndExpand() {
  try { children.value = await window.deployApi.expandDirectory(props.entry.path); expanded.value = true } catch (error) {
    reportError('展开目录失败', error)}
}
async function toggleExpand() {
  if (!props.entry.isDirectory) return
  if (!expanded.value) await loadAndExpand(); else expanded.value = false
}

// 服务器选择菜单（与 Ctrl+Shift+X 一致）
const { serverMenu, openServerMenu, closeServerMenu } = useServerMenu((targetId) => doDeploy(targetId))

function onContextMenu(e: MouseEvent) {
  e.preventDefault(); e.stopPropagation()
  const { clientX: x, clientY: y } = e
  const items: ContextMenuItem[] = [{
    label: '快速上传', icon: Wrench, shortcut: 'Ctrl+X',
    action: () => doDeploy()
  }, {
    label: '上传到', icon: Server, shortcut: 'Ctrl+Shift+X',
    action: () => openServerMenu(x, y)
  }]
  ctxMenu.value = { x, y, items }
}

async function doDeploy(targetId?: string) {
  if (!projectStore.projectPath) return
  isDeploying.value = true
  try {
    if (props.entry.isDirectory) {
      const allPaths = await window.deployApi.collectFiles(props.entry.path)
      if (allPaths.length === 0) {
        toastError('目录为空或无文件')
        return
      }
      await deployStore.previewDeploy(allPaths, projectStore.projectPath, targetId)
    } else {
      await deployStore.previewDeploy([props.entry.path], projectStore.projectPath, targetId)
    }
  } catch (e: any) {
    toastError(e?.message || '上传失败')
  } finally {
    isDeploying.value = false
  }
}

  /**
   * 行级键盘交互：
   * - Enter：目录展开/收起，文件选中
   * - Space：选中当前行
   * - ↑/↓：在树内相邻行之间移动焦点（跨行导航按 DOM 顺序）
   */
  function onRowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (props.entry.isDirectory) void toggleExpand()
      else selectSelf(event as unknown as MouseEvent)
      return
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      selectSelf(event as unknown as MouseEvent)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const current = event.currentTarget as HTMLElement
      const container = current.closest('.filetree-view') ?? document
      const rows = Array.from(container.querySelectorAll<HTMLElement>('.ftn-row'))
      const index = rows.indexOf(current)
      const target = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
      target?.focus()
    }
  }
</script>

<template>
  <div class="ftn-wrapper">
    <TreeRow
      row-class="ftn-row"
      :selected="isSelected"
      :indent="depth * 16 + 8"
      role="treeitem"
      :tabindex="0"
      :aria-expanded="entry.isDirectory ? expanded : undefined"
      @click="selectSelf"
      @contextmenu="onContextMenu"
      @keydown="onRowKeydown"
    >
      <template #toggle>
        <button
          v-if="entry.isDirectory"
          class="ftn-expand"
          :aria-expanded="expanded"
          :aria-label="expanded ? '收起目录' : '展开目录'"
          @click.stop="toggleExpand"
        >
          <component :is="expanded ? ChevronDown : ChevronRight" :size="14" />
        </button>
        <span v-else class="ftn-expand ph" />
      </template>
      <template #icon>
        <component :is="expanded ? FolderOpen : entry.isDirectory ? Folder : File" :size="14"
          :class="entry.isDirectory ? 'ftn-dir-icon' : 'ftn-file-icon'" />
      </template>
      <template #label><span class="ftn-name">{{ entry.name }}</span></template>
      <template #meta><span class="ftn-spacer" /></template>
      <template #actions>
        <button class="ftn-deploy-btn row-actions" :disabled="isDeploying" @click.stop="doDeploy()">
          {{ isDeploying ? '收集中...' : '快速上传' }}
        </button>
      </template>
    </TreeRow>

    <div v-if="expanded && children.length > 0">
      <FileTreeNode v-for="child in children" :key="child.path" :entry="child" :depth="depth + 1"
        :expand-all="expandAll" :collapse-all="collapseAll" />
    </div>

    <ContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenu.items"
      @close="ctxMenu = null"
    />

    <ServerTargetMenu :menu="serverMenu" @close="closeServerMenu" />
  </div>
</template>

<style scoped>
.ftn-wrapper { }
.ftn-expand { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--fg2); flex-shrink: 0; padding: 0; background: transparent; border: none; border-radius: 4px; }
.ftn-expand:hover { color: var(--fg); }
.ftn-expand.ph { visibility: hidden; }
.ftn-dir-icon { color: var(--purple); flex-shrink: 0; }
.ftn-file-icon { color: var(--fg2); flex-shrink: 0; }
.ftn-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ftn-spacer { flex: 1; }
/* 悬浮显隐由 TreeRow 的 .row-actions 统一负责 */
.ftn-deploy-btn { padding: 4px 8px; background: var(--accent); color: var(--on-accent); border-radius: 4px; font-size: 11px; white-space: nowrap; }
.ftn-deploy-btn:hover { background: var(--accent2); }
</style>
