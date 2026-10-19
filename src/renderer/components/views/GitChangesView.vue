<script setup lang="ts">
import { toastError } from '../../utils/toast'
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { ChevronsUpDown, ChevronsDownUp, RefreshCw } from 'lucide-vue-next'
import { useGitStore } from '../../stores/git'
import { statusClassOf, statusShort } from '../../utils/change-status'
import { useDeployStore } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import DiffPreview from '../git/DiffPreview.vue'
import GitChangeTreeNode from '../git/GitChangeTreeNode.vue'
import EmptyState from '../common/EmptyState.vue'
import type { ChangeTreeNode } from '../../types/git'
import ContextMenu from '../common/ContextMenu.vue'
import ServerTargetMenu from '../common/ServerTargetMenu.vue'
import { useDeployHotkeys } from '../../composables/useDeployHotkeys'
import { useServerMenu } from '../../composables/useServerMenu'

const gitStore = useGitStore()
const deployStore = useDeployStore()
const projectStore = useProjectStore()

const AUTO_REFRESH_MS = 60000

// 服务器选择菜单（Ctrl+Shift+X 唤起，数字键或鼠标选择）
const selectedNode = ref<ChangeTreeNode | null>(null)
const selectedPos = ref<{ x: number; y: number } | null>(null)

function onSelectNode(node: ChangeTreeNode, pos?: { x: number; y: number }) {
  selectedNode.value = node
  if (pos) selectedPos.value = pos
}

const { serverMenu, openServerMenu, closeServerMenu } = useServerMenu((targetId) => {
  const n = selectedNode.value
  if (!n) return
  if (n.isDirectory) handleDeployDir(n, targetId); else handleDeployFile(n.path, targetId)
})

useDeployHotkeys(
  () => !!selectedNode.value,
  () => !!serverMenu.value,
  () => {
    const n = selectedNode.value
    if (!n) return
    if (n.isDirectory) handleDeployDir(n); else handleDeployFile(n.path)
  },
  () => {
    const pos = selectedPos.value || { x: 240, y: 160 }
    openServerMenu(pos.x, pos.y)
  }
)

const previewFile = ref<string | null>(null)
/**
 * 展开状态。空串代表「项目目录」这个顶级节点（见 projectRootNode），
 * 默认展开：视觉上与原来一致（多一层项目目录），又便于一键整体上传。
 */
const expandedDirs = ref<Set<string>>(new Set(['']))

// 手动刷新（有反馈）
async function refresh() {
  if (!projectStore.projectPath) return
  await gitStore.loadGitStatus(projectStore.projectPath)
}

// 自动轮询（静默）
function autoRefresh() {
  if (projectStore.projectPath) gitStore.loadGitStatus(projectStore.projectPath, true)
}

// F5 由 App.vue 统一处理并派发（铁律 5），只有当前挂载的视图响应
function onRefreshView() {
  refresh()
}

// 窗口聚焦（用户从 IDE 切回）时立即刷新
function onFocus() {
  if (document.hasFocus()) refresh()
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  // 先注册监听与轮询，再做首屏加载：加载期间按 F5 / 切回窗口也能生效
  window.addEventListener('focus', onFocus)
  window.addEventListener('refresh-view', onRefreshView)
  timer = setInterval(autoRefresh, AUTO_REFRESH_MS)
  // 视图切换（v-if 重建）即事件：立即拉取最新 Git 状态
  // 静默模式避免状态栏“分析中”闪烁；store 侧 in-flight 去重不会与轮询重叠
  if (projectStore.projectPath) gitStore.loadGitStatus(projectStore.projectPath, true)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('refresh-view', onRefreshView)
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
            // 短标记与类名统一由 utils/change-status 提供（与 Git 日志视图同一套词汇表）
            label: statusShort(change.status),
            cssClass: statusClassOf(change.status)
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

/**
 * 顶级「项目目录」节点：把变更树整体挂到项目根下，
 * 这样可以直接对项目根点「快速上传」= 一次性上传本次全部变更（映射规则仍然生效）。
 * path 用空串表示项目根（collect/handleDeployDir 会拼成 projectPath + '/'）。
 */
const projectRootNode = computed<ChangeTreeNode | null>(() => {
  const root = projectStore.projectPath
  if (!root || changeTree.value.length === 0) return null
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const name = normalized.split('/').pop() || normalized
  // 项目根自身不是"变更项"，change 置空（不显示状态徽标）
  return { isDirectory: true, path: '', name, children: changeTree.value, change: null }
})

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
  expandedDirs.value = new Set(['', ...collectAllDirPaths(changeTree.value)])
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
    toastError(e?.message || '上传失败')
  } finally {
    deployingPath.value = null
  }
}

async function handleDeployDir(node: ChangeTreeNode, targetId?: string) {
  if (!projectStore.projectPath) return
  deployingPath.value = node.path
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
    toastError(e?.message || '上传失败')
  } finally {
    deployingPath.value = null
  }
}

</script>

<template>
  <div class="changes-view">
    <div class="view-header">
      <span>Git 未提交的变更 ({{ gitStore.changes.length }})</span>
      <div class="header-actions">
        <button class="icon-btn" title="刷新" aria-label="刷新 Git 变更" @click="refresh">
          <RefreshCw :size="14" />
        </button>
        <button class="icon-btn" title="全部展开" aria-label="全部展开" @click="expandAll">
          <ChevronsUpDown :size="14" />
        </button>
        <button class="icon-btn" title="全部收起" aria-label="全部收起" @click="expandedDirs.clear()">
          <ChevronsDownUp :size="14" />
        </button>
      </div>
    </div>

    <div class="changes-list">
      <template v-if="changeTree.length === 0">
        <EmptyState text="工作区干净，没有未提交的变更" size="page" />
      </template>

      <GitChangeTreeNode
        v-if="projectRootNode"
        :node="projectRootNode"
        :depth="0"
        :expanded-dirs="expandedDirs"
        :busy-path="deployingPath"
        :selected-path="selectedNode?.path"
        @select="onSelectNode"
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

    <ServerTargetMenu :menu="serverMenu" @close="closeServerMenu" />
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
  padding: 4px 12px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--fg);
}

.header-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--fg2); }
.icon-btn:hover { background: var(--border); color: var(--fg); }
.refresh-btn { display: flex; align-items: center; gap: 4px; }

.changes-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

</style>
