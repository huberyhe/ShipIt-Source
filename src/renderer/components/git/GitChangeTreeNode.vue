<script setup lang="ts">
import { ref } from 'vue'
import { File, Folder, FolderOpen, ChevronRight, ChevronDown, FileCode, Wrench, Server } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import ContextMenu, { type ContextMenuItem } from '../common/ContextMenu.vue'

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
}>()

const emit = defineEmits<{
  toggleDir: [path: string]
  deployFile: [path: string, targetId?: string]
  deployDir: [node: ChangeTreeNode, targetId?: string]
  showDiff: [path: string]
}>()

const deployStore = useDeployStore()
const projectStore = useProjectStore()

const menu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()

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
      children: deployStore.targets.length > 0
        ? deployStore.targets.map(t => ({
            label: `${t.name} (${t.protocol.toUpperCase()})`,
            icon: Server,
            action: () => emit('deployDir', props.node, t.id)
          }))
        : [{ label: '无可用目标', icon: Server, action: () => {} }]
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
      children: deployStore.targets.length > 0
        ? deployStore.targets.map(t => ({
            label: `${t.name} (${t.protocol.toUpperCase()})`,
            icon: Server,
            action: () => emit('deployFile', props.node.path, t.id)
          }))
        : [{ label: '无可用目标', icon: Server, action: () => {} }]
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
  menu.value = { x: e.clientX, y: e.clientY, items }
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
    :style="{ paddingLeft: (depth * 16 + 8) + 'px' }"
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
      @toggle-dir="emit('toggleDir', $event)"
      @deploy-file="(p, t) => emit('deployFile', p, t)"
      @deploy-dir="(n, t) => emit('deployDir', n, t)"
      @show-diff="emit('showDiff', $event)"
    />
  </template>

  <!-- 文件节点 -->
  <div v-else-if="!node.isDirectory"
    class="tree-row file-row"
    :style="{ paddingLeft: (depth * 16 + 22) + 'px' }"
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
</template>

<style scoped>
.tree-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 8px; font-size: 13px; color: var(--fg);
}
.tree-row:hover { background: var(--bg2); }
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
.tree-row:focus-within .quick-deploy-btn { opacity: 1; }
.quick-deploy-btn:hover:not(:disabled) { background: var(--accent2); }
.quick-deploy-btn:disabled { opacity: 0.5; cursor: wait; }
</style>
