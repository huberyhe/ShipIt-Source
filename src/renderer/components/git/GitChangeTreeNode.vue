<script setup lang="ts">
import { ref } from 'vue'
import { File, Folder, FolderOpen, ChevronRight, ChevronDown, FileCode, Wrench, Server } from 'lucide-vue-next'
import ContextMenu, { type ContextMenuItem } from '../common/ContextMenu.vue'
import { useServerMenu } from '../../composables/useServerMenu'

export interface ChangeTreeNode {
  name: string
  path: string
  isDirectory: boolean
  children: ChangeTreeNode[]
  change: { status: string; label: string; cssClass: string } | null
}

const props = defineProps<{
  node: ChangeTreeNode
  depth: number
  expandedDirs: Set<string>
  busyPath?: string | null
  /** 当前选中的节点 path（各节点自行比对，递归时原样透传） */
  selectedPath?: string
}>()

const emit = defineEmits<{
  toggleDir: [path: string]
  deployFile: [path: string, targetId?: string]
  deployDir: [node: ChangeTreeNode, targetId?: string]
  showDiff: [path: string]
  select: [node: ChangeTreeNode, pos?: { x: number; y: number }]
}>()

function onRowClick(e: MouseEvent) {
  emit('select', props.node, { x: e.clientX, y: e.clientY })
}

const menu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)

// 服务器选择菜单（与 Ctrl+Shift+Alt+X 一致）
const { serverMenu, openServerMenu, closeServerMenu } = useServerMenu((targetId) => {
  if (props.node.isDirectory) emit('deployDir', props.node, targetId)
  else emit('deployFile', props.node.path, targetId)
})

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()

  const { clientX: x, clientY: y } = e
  const items: ContextMenuItem[] = []

  if (props.node.isDirectory) {
    items.push({
      label: '快速上传',
      icon: Wrench,
      action: () => emit('deployDir', props.node)
    })
    items.push({
      label: '上传到',
      icon: Server,
      shortcut: 'Ctrl+Shift+Alt+X',
      action: () => openServerMenu(x, y)
    })
  } else if (props.node.change) {
    items.push({
      label: '快速上传',
      icon: Wrench,
      action: () => emit('deployFile', props.node.path)
    })
    items.push({
      label: '上传到',
      icon: Server,
      shortcut: 'Ctrl+Shift+Alt+X',
      action: () => openServerMenu(x, y)
    })
    if (props.node.change.status !== 'deleted') {
      items.push({
        label: '查看差异',
        icon: FileCode,
        action: () => emit('showDiff', props.node.path)
      })
    }
  }

  if (items.length === 0) return
  menu.value = { x, y, items }
}

function getDirStats(n: ChangeTreeNode): string {
  const stats = { modified: 0, added: 0, deleted: 0, untracked: 0 }
  function walk(node: ChangeTreeNode) {
    if (node.change) {
      const s = node.change.status as keyof typeof stats
      if (s in stats) stats[s]++
    }
    for (const child of node.children) walk(child)
  }
  walk(n)
  const parts: string[] = []
  if (stats.modified > 0) parts.push(`M:${stats.modified}`)
  if (stats.added > 0) parts.push(`A:${stats.added}`)
  if (stats.deleted > 0) parts.push(`D:${stats.deleted}`)
  if (stats.untracked > 0) parts.push(`?:${stats.untracked}`)
  return parts.join(' ')
}
</script>

<template>
  <!-- 目录节点 -->
  <div v-if="node.isDirectory"
    class="tree-row dir-row"
    :class="{ 'tree-row-selected': selectedPath === node.path }"
    :style="{ paddingLeft: (depth * 16 + 8) + 'px' }"
    @click="onRowClick"
    @contextmenu="onContextMenu"
  >
    <button
      class="expand-icon"
      :aria-expanded="expandedDirs.has(node.path)"
      :aria-label="expandedDirs.has(node.path) ? '收起目录' : '展开目录'"
      @click="emit('toggleDir', node.path)"
    >
      <component :is="expandedDirs.has(node.path) ? ChevronDown : ChevronRight" :size="14" />
    </button>
    <component :is="expandedDirs.has(node.path) ? FolderOpen : Folder" :size="14" class="dir-icon" />
    <span class="node-name" @click="emit('toggleDir', node.path)">{{ node.name }}/</span>
    <span class="dir-badge">{{ getDirStats(node) }}</span>
    <button class="quick-deploy-btn" :disabled="busyPath === node.path" @click.stop="emit('deployDir', node)">
      {{ busyPath === node.path ? '收集中...' : '快速上传' }}
    </button>
  </div>

  <!-- 展开子节点 -->
  <template v-if="node.isDirectory && expandedDirs.has(node.path)">
    <GitChangeTreeNode
      v-for="child in node.children"
      :key="child.path"
      :node="child"
      :depth="depth + 1"
      :expanded-dirs="expandedDirs"
      :busy-path="busyPath"
      :selected-path="selectedPath"
      @select="(n, p) => emit('select', n, p)"
      @toggle-dir="emit('toggleDir', $event)"
      @deploy-file="(p, t) => emit('deployFile', p, t)"
      @deploy-dir="(n, t) => emit('deployDir', n, t)"
      @show-diff="emit('showDiff', $event)"
    />
  </template>

  <!-- 文件节点 -->
  <div v-else-if="!node.isDirectory"
    class="tree-row file-row"
    :class="{ 'tree-row-selected': selectedPath === node.path }"
    :style="{ paddingLeft: (depth * 16 + 22) + 'px' }"
    @click="onRowClick"
    @contextmenu="onContextMenu"
  >
    <span class="status-badge" :class="node.change?.cssClass" v-if="node.change">{{ node.change.label }}</span>
    <File :size="14" class="file-icon" />
    <span class="node-name" :class="node.change?.cssClass">{{ node.name }}</span>
    <button
      v-if="node.change?.status !== 'deleted'"
      class="quick-deploy-btn"
      :disabled="busyPath === node.path"
      @click.stop="emit('deployFile', node.path)"
    >{{ busyPath === node.path ? '收集中...' : '快速上传' }}</button>
  </div>

  <!-- 右键菜单 -->
  <ContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="menu.items"
    @close="menu = null"
  />

  <!-- 服务器选择菜单（右键「上传到」与 Ctrl+Shift+Alt+X 共用） -->
  <ContextMenu
    v-if="serverMenu"
    :x="serverMenu.x"
    :y="serverMenu.y"
    :items="serverMenu.items"
    number-select
    title="选择要上传到的服务器"
    @close="closeServerMenu"
  />
</template>

<style scoped>
.tree-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 8px; font-size: 13px; color: var(--fg);
  cursor: pointer;
}
.tree-row:hover { background: var(--bg2); }
.tree-row-selected { background: var(--accent3) !important; }
.dir-icon { color: var(--purple); flex-shrink: 0; }

.expand-icon {
  width: 16px; height: 16px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--fg2); flex-shrink: 0;
  padding: 0; background: transparent; border: none; border-radius: 4px;
}
.expand-icon:hover { color: var(--fg); }

.node-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-name.status-modified { color: var(--yellow); }
.node-name.status-added { color: var(--green); }
.node-name.status-untracked { color: var(--green); }
.node-name.status-deleted { color: var(--red); text-decoration: line-through; }

.dir-badge { font-size: 9px; color: var(--fg2); white-space: nowrap; }

.status-badge { width: 16px; text-align: center; font-size: 10px; font-weight: bold; flex-shrink: 0; }
.status-modified { color: var(--yellow); }
.status-added { color: var(--green); }
.status-deleted { color: var(--red); }
.status-untracked { color: var(--green); }

.file-icon { color: var(--fg2); flex-shrink: 0; }

.quick-deploy-btn {
  padding: 2px 8px; background: var(--accent); color: var(--on-accent);
  border-radius: 4px; font-size: 11px; white-space: nowrap;
  margin-left: auto; opacity: 0; transition: opacity 0.15s;
}
.tree-row:hover .quick-deploy-btn,
.tree-row:has(:focus-visible) .quick-deploy-btn { opacity: 1; }
.quick-deploy-btn:hover:not(:disabled) { background: var(--accent2); }
.quick-deploy-btn:disabled { opacity: 0.5; cursor: wait; }
</style>
