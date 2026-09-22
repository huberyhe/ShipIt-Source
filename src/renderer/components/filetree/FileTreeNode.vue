<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, Wrench, Server } from 'lucide-vue-next'
import type { FileEntry } from '../../stores/files'
import { useFilesStore } from '../../stores/files'
import { useDeployStore } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import ContextMenu, { type ContextMenuItem } from '../common/ContextMenu.vue'
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
  try { children.value = await window.deployApi.expandDirectory(props.entry.path); expanded.value = true } catch {}
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
        window.dispatchEvent(new CustomEvent('toast', { detail: '目录为空或无文件' }))
        return
      }
      await deployStore.previewDeploy(allPaths, projectStore.projectPath, targetId)
    } else {
      await deployStore.previewDeploy([props.entry.path], projectStore.projectPath, targetId)
    }
  } catch (e: any) {
    window.dispatchEvent(new CustomEvent('toast', { detail: e?.message || '上传失败' }))
  } finally {
    isDeploying.value = false
  }
}
</script>

<template>
  <div class="ftn-wrapper">
    <div class="ftn-row" :class="{ 'ftn-row-selected': isSelected }" :style="{ paddingLeft: (depth * 16 + 8) + 'px' }" @click="selectSelf" @contextmenu="onContextMenu">
      <button
        v-if="entry.isDirectory"
        class="ftn-expand"
        :aria-expanded="expanded"
        :aria-label="expanded ? '收起目录' : '展开目录'"
        @click="toggleExpand"
      >
        <component :is="expanded ? ChevronDown : ChevronRight" :size="14" />
      </button>
      <span v-else class="ftn-expand ph" />
      <component :is="expanded ? FolderOpen : entry.isDirectory ? Folder : File" :size="14"
        :class="entry.isDirectory ? 'ftn-dir-icon' : 'ftn-file-icon'" />
      <span class="ftn-name">{{ entry.name }}</span>
      <span class="ftn-spacer" />
      <button class="ftn-deploy-btn" :disabled="isDeploying" @click.stop="doDeploy()">
        {{ isDeploying ? '收集中...' : '快速上传' }}
      </button>
    </div>

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

    <ContextMenu
      v-if="serverMenu"
      :x="serverMenu.x"
      :y="serverMenu.y"
      :items="serverMenu.items"
      number-select
      title="选择要上传到的服务器"
      @close="closeServerMenu"
    />
  </div>
</template>

<style scoped>
.ftn-wrapper { }
.ftn-row { display: flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 13px; color: var(--fg); cursor: pointer; }
.ftn-row:hover { background: var(--bg2); }
.ftn-row-selected { background: var(--accent3) !important; }
.ftn-expand { width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--fg2); flex-shrink: 0; padding: 0; background: transparent; border: none; border-radius: 4px; }
.ftn-expand:hover { color: var(--fg); }
.ftn-expand.ph { visibility: hidden; }
.ftn-dir-icon { color: var(--purple); flex-shrink: 0; }
.ftn-file-icon { color: var(--fg2); flex-shrink: 0; }
.ftn-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ftn-spacer { flex: 1; }
.ftn-deploy-btn { padding: 2px 8px; background: var(--accent); color: var(--on-accent); border-radius: 4px; font-size: 11px; white-space: nowrap; opacity: 0; transition: opacity 0.15s; }
.ftn-row:hover .ftn-deploy-btn,
.ftn-row:has(:focus-visible) .ftn-deploy-btn { opacity: 1; }
.ftn-deploy-btn:hover { background: var(--accent2); }
</style>
