<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import { useGitStore } from '../../stores/git'
import { useDeployStore } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import DiffPreview from '../git/DiffPreview.vue'
import GitChangeTreeNode, { type ChangeTreeNode } from '../git/GitChangeTreeNode.vue'

const gitStore = useGitStore()
const deployStore = useDeployStore()
const projectStore = useProjectStore()

const AUTO_REFRESH_MS = 60000

const previewFile = ref<string | null>(null)
const expandedDirs = ref<Set<string>>(new Set())

// 手动刷新（有反馈）
async function refresh() {
  if (!projectStore.projectPath) return
  await gitStore.loadGitStatus(projectStore.projectPath)
}

// 自动轮询（静默）
function autoRefresh() {
  if (projectStore.projectPath) gitStore.loadGitStatus(projectStore.projectPath, true)
}

// 窗口聚焦（用户从 IDE 切回）时立即刷新
function onFocus() {
  if (document.hasFocus()) refresh()
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(autoRefresh, AUTO_REFRESH_MS)
  window.addEventListener('focus', onFocus)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('focus', onFocus)
})

function buildChangeTree(changes: Array<{ relativePath: string; status: string }>): ChangeTreeNode[] {
  const root: ChangeTreeNode[] = []
  const dirMap = new Map<string, ChangeTreeNode>()

  const sorted = [...changes].sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  for (const change of sorted) {
    const parts = change.relativePath.replace(/\\/g, '/').split('/')
    let currentLevel = root
    let currentPath = ''

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      currentPath = currentPath ? currentPath + '/' + part : part
      const isLast = i === parts.length - 1

      if (isLast) {
        currentLevel.push({
          name: part,
          path: change.relativePath,
          isDirectory: false,
          children: [],
          change: {
            status: change.status,
            label: statusLabel(change.status),
            cssClass: statusClass(change.status)
          }
        })
      } else {
        let dir = dirMap.get(currentPath)
        if (!dir) {
          dir = {
            name: part,
            path: currentPath,
            isDirectory: true,
            children: [],
            change: null
          }
          currentLevel.push(dir)
          dirMap.set(currentPath, dir)
        }
        currentLevel = dir.children
      }
    }
  }

  // 按名称排序（目录优先）
  function sortNodes(nodes: ChangeTreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.children.length > 0) sortNodes(node.children)
    }
  }
  sortNodes(root)

  return root
}

const changeTree = computed(() => buildChangeTree(gitStore.changes))

function collectAllDirPaths(nodes: ChangeTreeNode[]): string[] {
  const paths: string[] = []
  for (const n of nodes) {
    if (n.isDirectory) {
      paths.push(n.path)
      paths.push(...collectAllDirPaths(n.children))
    }
  }
  return paths
}

function expandAll() {
  expandedDirs.value = new Set(collectAllDirPaths(changeTree.value))
}

function toggleDir(dirPath: string) {
  const newSet = new Set(expandedDirs.value)
  if (newSet.has(dirPath)) {
    newSet.delete(dirPath)
  } else {
    newSet.add(dirPath)
  }
  expandedDirs.value = newSet
}

// 正在上传的节点路径（用于按钮 loading 态）
const deployingPath = ref<string | null>(null)

async function handleDeployFile(filePath: string, targetId?: string) {
  if (!projectStore.projectPath) return
  deployingPath.value = filePath
  try {
    const fullPath = projectStore.projectPath.replace(/\\/g, '/') + '/' + filePath
    await deployStore.previewDeploy([fullPath], projectStore.projectPath, targetId)
  } catch (e: any) {
    window.dispatchEvent(new CustomEvent('toast', { detail: e?.message || '上传失败' }))
  } finally {
    deployingPath.value = null
  }
}

async function handleDeployDir(node: ChangeTreeNode, targetId?: string) {
  if (!projectStore.projectPath) return
  deployingPath.value = node.path
  try {
    const paths: string[] = []
    function collect(n: ChangeTreeNode) {
      if (n.isDirectory) {
        // 目录：只递归子节点，不收集目录本身
        for (const child of n.children) collect(child)
      } else if (n.change && n.change.status !== 'deleted') {
        // 文件：只收集有变更且未删除的
        paths.push(projectStore.projectPath!.replace(/\\/g, '/') + '/' + n.path)
      }
    }
    collect(node)
    if (paths.length === 0) return
    await deployStore.previewDeploy(paths, projectStore.projectPath, targetId)
  } catch (e: any) {
    window.dispatchEvent(new CustomEvent('toast', { detail: e?.message || '上传失败' }))
  } finally {
    deployingPath.value = null
  }
}

function statusLabel(status: string): string {
  switch (status) { case 'modified': return 'M'; case 'added': return 'A'; case 'deleted': return 'D'; case 'untracked': return '?'; default: return status }
}

function statusClass(status: string): string {
  return `status-${status}`
}
</script>

<template>
  <div class="changes-view">
    <div class="view-header">
      <span>Git 未提交的变更 ({{ gitStore.changes.length }})</span>
      <div class="header-actions">
        <button class="header-btn refresh-btn" title="刷新" aria-label="刷新 Git 变更" @click="refresh">
          <RefreshCw :size="11" /> 刷新
        </button>
        <button class="header-btn" @click="expandAll">全部展开</button>
        <button class="header-btn" @click="expandedDirs.clear()">全部收起</button>
      </div>
    </div>

    <div class="changes-list">
      <template v-if="changeTree.length === 0">
        <div class="empty-state">工作区干净，没有未提交的变更</div>
      </template>

      <GitChangeTreeNode
        v-for="node in changeTree"
        :key="node.path"
        :node="node"
        :depth="0"
        :expanded-dirs="expandedDirs"
        :busy-path="deployingPath"
        @toggle-dir="toggleDir"
        @deploy-file="handleDeployFile"
        @deploy-dir="handleDeployDir"
        @show-diff="previewFile = $event"
      />
    </div>

    <DiffPreview
      v-if="previewFile"
      :file-path="previewFile"
      @close="previewFile = null"
    />
  </div>
</template>

<style scoped>
.changes-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--fg);
}

.header-actions { display: flex; align-items: center; gap: 6px; }
.header-btn {
  padding: 2px 8px; background: transparent; color: var(--fg2);
  border: 1px solid var(--border); border-radius: 4px; font-size: 10px;
}
.header-btn:hover { background: var(--border); color: var(--fg); }
.refresh-btn { display: flex; align-items: center; gap: 3px; }

.changes-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.empty-state {
  padding: 24px;
  text-align: center;
  color: var(--fg2);
}
</style>
