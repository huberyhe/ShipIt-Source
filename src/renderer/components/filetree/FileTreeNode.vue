<script setup lang="ts">
import { toastError } from '../../utils/toast'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
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
import { useSelectionDeploy } from '../../composables/useSelectionDeploy'
import { resolveSelectionMode } from '../../utils/selection'

const props = defineProps<{
  entry: FileEntry; depth: number
  expandAll?: boolean; collapseAll?: number
}>()

const deployStore = useDeployStore()
const projectStore = useProjectStore()
const filesStore = useFilesStore()

const expanded = ref(false)
const isSelected = computed(() => filesStore.isDeploySelected(props.entry.path))

// Shift 区间要知道「当前可见行」的顺序：用 DOM 顺序（展开状态在子组件内部，父级看不到）
function visibleRowPaths(e: MouseEvent): string[] {
  const container = (e.currentTarget as HTMLElement).closest('.filetree-view')
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>('.ftn-row'))
    .map((row) => row.dataset.path ?? '')
    .filter(Boolean)
}

function selectSelf(e: MouseEvent) {
  // 行是 tabindex=-1：点击后显式聚焦，否则后续 Space/Enter 收不到按键（"空格选中失效"）
  ;(e.currentTarget as HTMLElement | null)?.focus?.()
  const pos = { x: e.clientX, y: e.clientY }
  const mode = resolveSelectionMode(e)
  if (mode === 'range') {
    // 只更新「当前行」，锚点保持不变；区间右端是本次点击的行
    filesStore.setCurrent(props.entry, pos)
    filesStore.selectDeployRange(visibleRowPaths(e), props.entry.path)
    return
  }
  filesStore.selectDeployEntry(props.entry, pos, mode)
}

onMounted(() => filesStore.registerDeployEntry(props.entry))
onBeforeUnmount(() => filesStore.unregisterDeployEntry(props.entry.path))
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
  // 右键项若不在多选集合里，先让它成为唯一选区（与资源管理器一致）
  if (!filesStore.isDeploySelected(props.entry.path)) {
    filesStore.selectDeployEntry(props.entry)
  }
  const items: ContextMenuItem[] = [{
    label: '快速上传', icon: Wrench, shortcut: 'Ctrl+X',
    action: () => doDeploy()
  }, {
    label: '上传到', icon: Server, shortcut: 'Ctrl+Shift+X',
    action: () => openServerMenu(x, y)
  }]
  ctxMenu.value = { x, y, items }
}

const { deploySelection } = useSelectionDeploy()

/** 右键「快速上传」/ Ctrl+X：作用于**整个选区** */
async function doDeploy(targetId?: string) {
  if (!filesStore.isDeploySelected(props.entry.path)) {
    filesStore.selectDeployEntry(props.entry)
  }
  isDeploying.value = true
  try {
    await deploySelection(targetId)
  } finally {
    isDeploying.value = false
  }
}

/** 行内「快速上传」按钮：只上传**本行**对应的文件/目录（与选区无关） */
async function deployThis(): Promise<void> {
  const root = projectStore.projectPath
  if (!root) return
  isDeploying.value = true
  try {
    if (props.entry.isDirectory) {
      const allPaths = await window.deployApi.collectFiles(props.entry.path)
      if (allPaths.length === 0) {
        toastError('目录为空或无文件')
        return
      }
      await deployStore.previewDeploy(allPaths, root)
    } else {
      await deployStore.previewDeploy([props.entry.path], root)
    }
  } catch (error: any) {
    toastError(error?.message || '上传失败')
  } finally {
    isDeploying.value = false
  }
}

</script>

<template>
  <div class="ftn-wrapper">
    <TreeRow
      row-class="ftn-row"
      :data-path="entry.path"
      :data-depth="depth"
      :selected="isSelected"
      :indent="depth * 16 + 8"
      role="treeitem"
      :tabindex="-1"
      :aria-expanded="entry.isDirectory ? expanded : undefined"
      @click="selectSelf"
      @contextmenu="onContextMenu"
    >
      <template #toggle>
        <button
          v-if="entry.isDirectory"
          class="ftn-expand"
          tabindex="-1"
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
        <button class="ftn-deploy-btn" tabindex="-1" :disabled="isDeploying" @click.stop="deployThis()">
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
/* 深色主题的选中底是实色强调色：文字与图标必须转白，
   --purple / --fg2 压在其上不足 3:1。
   浅色主题是浅蓝底，保持原有语义色即可（不要反白）。 */
.theme-dark .ftn-row.selected .ftn-name,
.theme-dark .ftn-row.selected .ftn-expand,
.theme-dark .ftn-row.selected .ftn-dir-icon,
.theme-dark .ftn-row.selected .ftn-file-icon { color: var(--on-accent); }
.ftn-spacer { flex: 1; }
/* 悬浮显隐由 TreeRow 的 .row-actions 统一负责 */
.ftn-deploy-btn { padding: 4px 8px; background: var(--accent); color: var(--on-accent); border-radius: 4px; font-size: 11px; white-space: nowrap; }
.ftn-deploy-btn:hover { background: var(--accent2); }
/* 深色主题选中行是实色底：按钮反色；浅色主题浅蓝底上正常显示即可 */
.theme-dark .ftn-row.selected .ftn-deploy-btn { background: var(--on-accent); color: var(--accent); }
.theme-dark .ftn-row.selected .ftn-deploy-btn:hover {
  background: var(--on-accent); color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
</style>
