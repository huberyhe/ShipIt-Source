<script setup lang="ts">
import { ref } from 'vue'
import { File, Folder, FolderOpen, ChevronRight, ChevronDown, FileCode, Wrench, Server } from 'lucide-vue-next'
import ContextMenu from '../common/ContextMenu.vue'
import ServerTargetMenu from '../common/ServerTargetMenu.vue'
import TreeRow from '../common/TreeRow.vue'
import type { ContextMenuItem } from '../../types/context-menu'
import type { ChangeTreeNode } from '../../types/git'
import { useServerMenu } from '../../composables/useServerMenu'
import { resolveSelectionMode } from '../../utils/selection'

export type { ChangeTreeNode }

const props = defineProps<{
  node: ChangeTreeNode
  depth: number
  expandedDirs: Set<string>
  busyPath?: string | null
  /** 当前选中的节点路径集合（Ctrl 切换 / Shift 区间，递归时原样透传） */
  selectedPaths?: string[]
}>()

const emit = defineEmits<{
  toggleDir: [path: string]
  deployFile: [path: string, targetId?: string]
  deployDir: [node: ChangeTreeNode, targetId?: string]
  /** 快速上传：由视图决定「作用于整个选区」 */
  quickDeploy: [node: ChangeTreeNode, targetId?: string]
  showDiff: [path: string]
  select: [node: ChangeTreeNode, pos?: { x: number; y: number }, mode?: 'replace' | 'toggle' | 'range']
}>()

function onRowClick(e: MouseEvent) {
  emit('select', props.node, { x: e.clientX, y: e.clientY }, resolveSelectionMode(e))
}

/** 双击文件 = 查看差异（已删除的文件没有本地内容，跳过） */
function onRowDblClick(): void {
  if (props.node.isDirectory || !props.node.change) return
  if (props.node.change.status === 'deleted') return
  emit('showDiff', props.node.path)
}

/** 行级键盘交互：Enter 展开/选中，Space 选中（此前整棵树键盘不可达） */
function onRowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
  event.preventDefault()
  if (props.node.isDirectory && event.key === 'Enter') emit('toggleDir', props.node.path)
  else emit('select', props.node)
}

const menu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)

// 服务器选择菜单（与 Ctrl+Shift+X 一致）
const { serverMenu, openServerMenu, closeServerMenu } = useServerMenu((targetId) => {
  // 选完服务器后上传**整个选区**（与 Ctrl+X 一致），必须带上用户选的 targetId
  emit('quickDeploy', props.node, targetId)
})

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()

  const { clientX: x, clientY: y } = e
  // 右键项若不在选区里，先让它成为唯一选区（与文件树一致）
  if (!(props.selectedPaths ?? []).includes(props.node.path)) {
    emit('select', props.node, { x, y })
  }
  const items: ContextMenuItem[] = []

  if (props.node.isDirectory) {
    items.push({
      label: '快速上传',
      icon: Wrench,
      shortcut: 'Ctrl+X',
      action: () => emit('quickDeploy', props.node)
    })
    items.push({
      label: '上传到',
      icon: Server,
      shortcut: 'Ctrl+Shift+X',
      action: () => openServerMenu(x, y)
    })
  } else if (props.node.change) {
    items.push({
      label: '快速上传',
      icon: Wrench,
      shortcut: 'Ctrl+X',
      action: () => emit('quickDeploy', props.node)
    })
    items.push({
      label: '上传到',
      icon: Server,
      shortcut: 'Ctrl+Shift+X',
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
  <TreeRow
    v-if="node.isDirectory"
    row-class="tree-row dir-row"
    :data-path="node.path"
    :selected="(selectedPaths ?? []).includes(node.path)"
    :indent="depth * 16 + 8"
    role="button"
    :tabindex="0"
    :aria-expanded="expandedDirs.has(node.path)"
    @click="onRowClick"
    @contextmenu="onContextMenu"
    @keydown="onRowKeydown"
  >
    <template #toggle>
      <button
        class="expand-icon"
        :aria-expanded="expandedDirs.has(node.path)"
        :aria-label="expandedDirs.has(node.path) ? '收起目录' : '展开目录'"
        @click.stop="emit('toggleDir', node.path)"
      >
        <component :is="expandedDirs.has(node.path) ? ChevronDown : ChevronRight" :size="14" />
      </button>
    </template>
    <template #icon>
      <component :is="expandedDirs.has(node.path) ? FolderOpen : Folder" :size="14" class="dir-icon" />
    </template>
    <template #label>
      <span class="node-name">{{ node.name }}</span>
    </template>
    <template #meta><span class="dir-badge">{{ getDirStats(node) }}</span></template>
    <template #actions>
      <button class="quick-deploy-btn row-actions" :disabled="busyPath === node.path" @click.stop="emit('deployDir', node)">
        {{ busyPath === node.path ? '收集中...' : '快速上传' }}
      </button>
    </template>
  </TreeRow>

  <!-- 展开子节点 -->
  <template v-if="node.isDirectory && expandedDirs.has(node.path)">
    <GitChangeTreeNode
      v-for="child in node.children"
      :key="child.path"
      :node="child"
      :depth="depth + 1"
      :expanded-dirs="expandedDirs"
      :busy-path="busyPath"
      :selected-paths="selectedPaths"
      @select="(n, p, m) => emit('select', n, p, m)"
      @toggle-dir="emit('toggleDir', $event)"
      @deploy-file="(p, t) => emit('deployFile', p, t)"
      @deploy-dir="(n, t) => emit('deployDir', n, t)"
      @show-diff="emit('showDiff', $event)"
      @quick-deploy="(n, t) => emit('quickDeploy', n, t)"
    />
  </template>

  <!-- 文件节点 -->
  <TreeRow
    v-else-if="!node.isDirectory"
    row-class="tree-row file-row"
    :data-path="node.path"
    :selected="(selectedPaths ?? []).includes(node.path)"
    :indent="depth * 16 + 22"
    role="button"
    :tabindex="0"
    @click="onRowClick"
    @dblclick="onRowDblClick"
    @contextmenu="onContextMenu"
    @keydown="onRowKeydown"
  >
    <template #before>
      <span class="status-badge" :class="node.change?.cssClass" v-if="node.change">{{ node.change.label }}</span>
    </template>
    <template #icon><File :size="14" class="file-icon" /></template>
    <template #label>
      <span class="node-name" :class="node.change?.cssClass">{{ node.name }}</span>
    </template>
    <template #actions>
      <button
        v-if="node.change?.status !== 'deleted'"
        class="quick-deploy-btn row-actions"
        :disabled="busyPath === node.path"
        @click.stop="emit('deployFile', node.path)"
      >{{ busyPath === node.path ? '收集中...' : '快速上传' }}</button>
    </template>
  </TreeRow>

  <!-- 右键菜单 -->
  <ContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="menu.items"
    @close="menu = null"
  />

  <!-- 服务器选择菜单（右键「上传到」与 Ctrl+Shift+X 共用） -->
    <ServerTargetMenu :menu="serverMenu" @close="closeServerMenu" />
</template>

<style scoped>
.tree-row {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 8px; font-size: 13px; color: var(--fg);
  cursor: pointer;
}
.dir-icon { color: var(--purple); flex-shrink: 0; }

.expand-icon {
  width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--fg2); flex-shrink: 0;
  padding: 0; background: transparent; border: none; border-radius: 4px;
}
.expand-icon:hover { color: var(--fg); }

.node-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-name.status-modified { color: var(--yellow); }
.node-name.status-added { color: var(--green); }
.node-name.status-untracked { color: var(--green); }
.node-name.status-deleted { color: var(--red); text-decoration: line-through; }

/* 目录统计贴行尾（长目录名下不再紧贴名称），左侧留最小间距便于扫读 */
.dir-badge { font-size: 11px; color: var(--fg2); white-space: nowrap; margin-left: auto; padding-left: 16px; }

.status-badge { width: 16px; text-align: center; font-size: 11px; font-weight: bold; flex-shrink: 0; }
.status-modified { color: var(--yellow); }
.status-added { color: var(--green); }
.status-deleted { color: var(--red); }
.status-untracked { color: var(--green); }

.file-icon { color: var(--fg2); flex-shrink: 0; }

.quick-deploy-btn {
  padding: 4px 8px; background: var(--accent); color: var(--on-accent);
  border-radius: 4px; font-size: 11px; white-space: nowrap;
  margin: auto;
}
.quick-deploy-btn:hover:not(:disabled) { background: var(--accent2); }
.quick-deploy-btn:disabled { opacity: 0.5; cursor: wait; }
</style>
