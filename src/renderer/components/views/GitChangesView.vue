<script setup lang="ts">
import { toastError } from '../../utils/toast'
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { ChevronsUpDown, ChevronsDownUp, RefreshCw } from 'lucide-vue-next'
import { useUiStore } from '../../stores/ui'
import { useGitStore } from '../../stores/git'
import { statusClassOf, statusShort } from '../../utils/change-status'
import { reduceSelection, shouldCollapseOnSpace } from '../../utils/selection'
import { isEscapeKey, isSelectAllKey, parentRowOf, visibleRows } from '../../utils/tree-keyboard'
import { isOnRow, leaveZoneBackward, tabIntoZoneControls } from '../../utils/focus-zone'
import { useDeployStore } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import DiffPreview from '../git/DiffPreview.vue'
import GitChangeTreeNode from '../git/GitChangeTreeNode.vue'
import EmptyState from '../common/EmptyState.vue'
import ViewHeader from '../common/ViewHeader.vue'
import IconButton from '../common/IconButton.vue'
import type { ChangeTreeNode } from '../../types/git'
import ContextMenu from '../common/ContextMenu.vue'
import ServerTargetMenu from '../common/ServerTargetMenu.vue'
import { useDeployHotkeys } from '../../composables/useDeployHotkeys'
import { useServerMenu } from '../../composables/useServerMenu'
import { useContentKeyFallback } from '../../composables/useContentKeyFallback'

const gitStore = useGitStore()
const deployStore = useDeployStore()
const projectStore = useProjectStore()

const AUTO_REFRESH_MS = 60000

// 服务器选择菜单（Ctrl+Shift+X 唤起，数字键或鼠标选择）
const uiStore = useUiStore()
const selectedPaths = ref<string[]>([])
/** 选区规模发布给 uiStore（单一来源；菜单栏读它，不再用 DOM 探针） */
watch(() => selectedPaths.value.length, (count) => uiStore.setSelectionCount(count), { immediate: true })
const selectionAnchor = ref<string | null>(null)
const selectedPos = ref<{ x: number; y: number } | null>(null)

/** 路径 → 节点索引（Shift 区间只需要 DOM 里的路径顺序） */
const nodeIndex = computed(() => {
  const map = new Map<string, ChangeTreeNode>()
  const walk = (n: ChangeTreeNode) => { map.set(n.path, n); n.children.forEach(walk) }
  displayNodes.value.forEach(walk)
  return map
})

function isSelectedPath(path: string): boolean {
  return selectedPaths.value.includes(path)
}

/** Ctrl 切换 / Shift 区间 / 普通点击替换 */
/** 当前可见行顺序（区间选择用）：DOM 顺序即渲染顺序 */
function visibleOrder(): string[] {
  const container = document.querySelector('.changes-view') ?? document
  return Array.from(container.querySelectorAll<HTMLElement>('.tree-row'))
    .map((row) => row.dataset.path ?? '')
    .filter(Boolean)
}

/**
 * 内容区键盘：统一在容器上处理（事件冒泡上来）。
 * 行内不再绑 keydown —— 焦点可能停在容器（Shift+Tab 回退、点击空白），行级监听会失效。
 */

/** 从行回到容器时停在容器上，否则 Shift+Tab 会被推回首行、出不去 */
let lastRowPath = ''
const zoneEl = ref<HTMLElement | null>(null)
// 焦点不在内容区时（刚打开项目/点过工具条）按空格也能选中
useContentKeyFallback(zoneEl, '.tree-row')

function onContentFocus(event: FocusEvent): void {
  const zone = event.currentTarget as HTMLElement
  const targetRow = (event.target as HTMLElement).closest?.<HTMLElement>('.tree-row')
  if (event.target !== zone) {
    if (targetRow?.dataset.path) lastRowPath = targetRow.dataset.path
    return
  }
  const from = event.relatedTarget as Node | null
  if (from && zone.contains(from)) return
  const rows = Array.from(zone.querySelectorAll<HTMLElement>('.tree-row'))
  const remembered = lastRowPath ? rows.find((row) => row.dataset.path === lastRowPath) : null
  const target = remembered ?? rows[0]
  // 只移焦点，不改选区
  target?.focus()
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
  const rows = visibleRows(zone, '.tree-row')
  if (rows.length === 0) return
  const row = (event.target as HTMLElement).closest<HTMLElement>('.tree-row')
  const index = row ? rows.indexOf(row) : -1
  const path = row?.dataset.path ?? ''
  const expandBtn = (el: HTMLElement | null): HTMLElement | null => el?.querySelector<HTMLElement>('.expand-icon') ?? null

  /** 方向键只移动焦点；选区必须由空格/回车/鼠标点击显式改变 */
  const focusAt = (next: number): void => {
    rows[next]?.focus()
  }

  // Alt+Enter：只上传焦点所在行（与行内「快速上传」同一实现，不影响选区）。
  // 已删除的文件没有行内按钮（本来就无本地内容可发）——必须给提示，不能静默无反应。
  if (event.altKey && event.key === 'Enter') {
    if (index < 0) return
    event.preventDefault()
    const btn = row?.querySelector<HTMLButtonElement>('.quick-deploy-btn')
    if (btn) btn.click()
    else toastError('该文件已在本地删除，没有可上传的内容')
    return
  }

  if (isSelectAllKey(event)) {
    event.preventDefault()
    selectAllVisible()
    return
  }
  if (isEscapeKey(event)) {
    event.preventDefault()
    clearSelection()
    return
  }

  switch (event.key) {
    case ' ':
    case 'Spacebar':
      event.preventDefault()
      if (index < 0) { focusAt(0); return }
      // 空格：选中；已是唯一选中项时再按一次 = 取消（与文件树一致）
      if (!event.ctrlKey && !event.metaKey && shouldCollapseOnSpace(selectedPaths.value, path)) {
        clearSelection()
        return
      }
      onSelectNode(nodeIndex.value.get(path)!, undefined, event.ctrlKey || event.metaKey ? 'toggle' : 'replace')
      return
    case 'Enter':
      event.preventDefault()
      if (index < 0) { focusAt(0); return }
      if (event.ctrlKey || event.metaKey) {
        onSelectNode(nodeIndex.value.get(path)!, undefined, 'toggle')
        return
      }
      if (expandBtn(row)) expandBtn(row)?.click()
      else if (path) selectPathByKey(path)
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
      const btn = expandBtn(row)
      if (btn && row?.getAttribute('aria-expanded') !== 'true') btn.click()
      else focusAt(index + 1)
      return
    }
    case 'ArrowLeft': {
      event.preventDefault()
      const btn = expandBtn(row)
      if (btn && row?.getAttribute('aria-expanded') === 'true') {
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

/** 键盘：按路径选中（方向键移动焦点时走这里） */
function selectPathByKey(path: string): void {
  const node = nodeIndex.value.get(path)
  if (node) onSelectNode(node, undefined, 'replace')
}

/** 键盘 Ctrl+A：选中当前可见行 */
function selectAllVisible(): void {
  const order = visibleOrder().filter((path) => nodeIndex.value.has(path))
  selectedPaths.value = order
  selectionAnchor.value = order.length > 0 ? order[order.length - 1] : null
}

/** 键盘 Esc：清空选区 */
function clearSelection(): void {
  selectedPaths.value = []
  selectionAnchor.value = null
}

/** Ctrl 切换 / Shift 区间 / 普通点击替换：语义由 utils/selection 统一 */
function onSelectNode(node: ChangeTreeNode, pos?: { x: number; y: number }, mode: 'replace' | 'toggle' | 'range' = 'replace') {
  if (pos) selectedPos.value = pos
  const next = reduceSelection(
    { paths: selectedPaths.value, anchor: selectionAnchor.value },
    { path: node.path, mode, order: mode === 'range' ? visibleOrder() : undefined }
  )
  selectedPaths.value = next.paths
  selectionAnchor.value = next.anchor
}

const { serverMenu, openServerMenu, closeServerMenu } = useServerMenu((targetId) => {
  void deploySelection(targetId)
})

useDeployHotkeys(
  () => selectedPaths.value.length > 0,
  () => !!serverMenu.value,
  () => { void deploySelection() },
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

/**
 * 变更列表 → 目录树。
 *
 * `prefix` 用于**仓库分组**：按「仓库内相对路径」分层（否则仓库行下面会又出现一层同名目录），
 * 但节点 `path` 仍是**项目相对**全路径 —— 上传链路靠它拼绝对路径，不能改成仓库相对。
 */
function buildChangeTree(changes: Array<{ relativePath: string; status: string }>, prefix = ''): ChangeTreeNode[] {
  const root: ChangeTreeNode[] = []
  const dirMap = new Map<string, ChangeTreeNode>()
  const head = prefix === '' ? '' : `${prefix}/`

  const sorted = [...changes].sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  for (const change of sorted) {
    const full = change.relativePath.replace(/\\/g, '/')
    const sub = head && full.startsWith(head) ? full.slice(head.length) : full
    const parts = sub.split('/')
    let currentLevel = root
    let currentPath = ''

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      currentPath = currentPath ? currentPath + '/' + part : part
      const isLast = i === parts.length - 1

      if (isLast) {
        currentLevel.push({
          name: part,
          path: full,
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

/** 仓库在项目里的相对目录（`/` 归一；根仓库为 ''） */
function repoRelDir(repoPath: string): string {
  const root = (projectStore.projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const repo = repoPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root || repo === root) return ''
  if (!repo.startsWith(`${root}/`)) return repo
  return repo.slice(root.length + 1)
}

/**
 * 仓库节点的 key：「项目相对目录 + `/`」，根仓库用 `/`。
 *
 * 不能直接用目录路径：仓库内的节点也是 `目录/...`，仓库节点会与它自己的第一个目录层撞 key
 * （选区、展开态、nodeIndex 都会串）。而 `目录/` 这个形态（末尾带斜杠）不会出现在文件路径里；
 * 空串已被「项目目录」根节点占用。目录节点不会被上传，key 只需唯一且稳定。
 */
function repoNodeKey(repoPath: string): string {
  const rel = repoRelDir(repoPath)
  return rel === '' ? '/' : `${rel}/`
}

/**
 * 什么时候多一层仓库：多个仓库，或唯一仓库不是项目根。
 * 只有一个仓库且它就是项目根时不显示仓库层（保持原有观感，不制造噪音）；
 * 例外：某个仓库读取失败时也要开（否则单仓库读失败会静默显示成「工作区干净」，
 * 用户会以为这个仓库没有变更）。
 */
const showRepoLayer = computed(
  () =>
    gitStore.repos.length > 1 ||
    gitStore.repos.some((repo) => repoRelDir(repo.repoPath) !== '' || !!repo.error)
)

const repoGroups = computed(() =>
  gitStore.repos.map((repo) => {
    const rel = repoRelDir(repo.repoPath)
    // 按「仓库内相对路径」分层；节点 path 仍由 buildChangeTree 写成项目相对全路径
    return { repo, key: repoNodeKey(repo.repoPath), nodes: buildChangeTree(repo.changes, rel) }
  })
)

/** 仓库节点 → 分支 / 错误 / 文件数（展示用元数据，不往树结构里塞 UI 字段） */
const repoMeta = computed(() => {
  const map: Record<string, { branch?: string; error?: string; fileCount: number }> = {}
  for (const group of repoGroups.value) {
    map[group.key] = {
      branch: group.repo.branch,
      error: group.repo.error,
      fileCount: group.repo.changes.length
    }
  }
  return map
})

/**
 * 仓库层默认展开：只对**首次出现**的仓库自动展开，用户手动收起的不会被下一次轮询又弹开。
 * （仓库节点的展开态与目录共用 `expandedDirs`，不另开一份状态）
 */
const knownRepoKeys = new Set<string>()
watch(
  () => repoGroups.value.map((group) => group.key),
  (keys) => {
    const fresh = keys.filter((key) => !knownRepoKeys.has(key))
    if (fresh.length === 0) return
    fresh.forEach((key) => knownRepoKeys.add(key))
    expandedDirs.value = new Set([...expandedDirs.value, ...fresh])
  },
  { immediate: true }
)

/** 树的真正顶层：开启仓库层时是仓库节点，否则直接是变更树 */
const displayNodes = computed<ChangeTreeNode[]>(() => {
  if (!showRepoLayer.value) return changeTree.value
  return (
    repoGroups.value
      // 没有变更也没有错误的仓库不占行（只列有变化的仓库）
      .filter((group) => group.nodes.length > 0 || !!group.repo.error)
      .map((group) => ({
        name: group.repo.repoName,
        path: group.key,
        isDirectory: true,
        children: group.nodes,
        change: null
      }))
  )
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

function collapseAll() {
  // 没有“项目目录”虚拟根了：全部收起就是空集
  expandedDirs.value = new Set()
}

// Ctrl+Shift++ / Ctrl+Shift+-（App 统一派发）
onMounted(() => {
  window.addEventListener('tree-expand-all', expandAll)
  window.addEventListener('tree-collapse-all', collapseAll)
})
onUnmounted(() => {
  window.removeEventListener('tree-expand-all', expandAll)
  window.removeEventListener('tree-collapse-all', collapseAll)
})

function expandAll() {
  expandedDirs.value = new Set(collectAllDirPaths(displayNodes.value))
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

/**
 * 上传整个选区：目录递归收集「有变更且未删除」的文件，文件直接入列，按绝对路径去重。
 * 快速上传（按钮/右键/Ctrl+X）都走这里，保证与多选语义一致。
 */
async function deploySelection(targetId?: string): Promise<void> {
  const root = projectStore.projectPath
  if (!root) return
  if (selectedPaths.value.length === 0) {
    toastError('请先选择要上传的文件或目录（Ctrl / Shift 可多选）')
    return
  }
  try {
    const paths: string[] = []
    const collect = (n: ChangeTreeNode) => {
      if (n.isDirectory) {
        for (const child of n.children) collect(child)
      } else if (n.change && n.change.status !== 'deleted') {
        paths.push(root.replace(/\\/g, '/') + '/' + n.path)
      }
    }
    for (const path of selectedPaths.value) {
      const node = nodeIndex.value.get(path)
      if (node) collect(node)
    }
    const unique = [...new Set(paths)]
    if (unique.length === 0) {
      toastError('选中项没有可上传的变更文件')
      return
    }
    await deployStore.previewDeploy(unique, root, targetId)
  } catch (e: any) {
    toastError(e?.message || '上传失败')
  }
}

/** 快速上传：右键/按钮作用于未选中项时，先把它变成唯一选区 */
function quickDeploy(node: ChangeTreeNode, targetId?: string): void {
  if (!isSelectedPath(node.path)) {
    selectedPaths.value = [node.path]
    selectionAnchor.value = node.path
  }
  void deploySelection(targetId)
}

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

/**
 * 选区规模（P0-2）：数量与"含几个目录"都在按 Ctrl+X 之前可见。
 * 目录只数顶层选中项，**不递归统计目录下的文件数**（避免为表头数字遍历上万文件）。
 */
const selectionText = computed(() => {
  const total = selectedPaths.value.length
  if (total === 0) return ''
  const dirs = selectedPaths.value.filter((path) => nodeIndex.value.get(path)?.isDirectory).length
  return dirs > 0 ? `已选 ${total} 项（含 ${dirs} 个目录）` : `已选 ${total} 项`
})
</script>

<template>
  <div ref="zoneEl" class="changes-view" data-focus-zone tabindex="0" @keydown="onContentKeydown" @focusin="onContentFocus">
    <ViewHeader :title="`Git 未提交的变更 (${gitStore.changes.length})`">
      <template #meta>
        <!-- 仓库过多时不能静默少列：给出固定文案的提示（不插行，不引发布局跳动） -->
        <span v-if="gitStore.reposTruncated" class="truncated-hint" title="项目内仓库数量超过上限，只展示了前几个；请直接打开对应子仓库">仓库数超出上限，仅显示部分</span>
        <span v-else-if="gitStore.reposScanTruncated" class="truncated-hint" title="目录过多，仓库扫描已提前结束；可能有更深的仓库未显示">仓库扫描未完成</span>
        <!-- 选区规模占"剩余宽度"并右对齐：出现/消失不推动左侧标题与右侧按钮（防抖动） -->
        <span class="selection-meta" :title="selectionText ? 'Ctrl+X / 右键「快速上传」上传的是这些选中项' : ''">{{ selectionText }}</span>
      </template>
      <template #actions>
        <IconButton class="icon-btn" size="sm" tabindex="-1" label="刷新 Git 变更" title="刷新" @click="refresh">
          <RefreshCw :size="14" />
        </IconButton>
        <IconButton class="icon-btn" size="sm" tabindex="-1" label="全部展开" @click="expandAll">
          <ChevronsUpDown :size="14" />
        </IconButton>
        <IconButton class="icon-btn" size="sm" tabindex="-1" label="全部收起" @click="expandedDirs.clear()">
          <ChevronsDownUp :size="14" />
        </IconButton>
      </template>
    </ViewHeader>

    <div class="changes-list">
      <EmptyState v-if="displayNodes.length === 0" text="工作区干净，没有未提交的变更" size="page" />
      <!-- role="tree"：容器单一 Tab 停靠点模型不变（行仍 tabindex=-1）；空态放在树外。
           不再套“项目目录”虚拟根：单仓库时变更树直接是顶层（避免 ssmp/ssmp），
           多仓库时每个仓库各是一个顶层节点（并列多个根）。 -->
      <div v-else role="tree" aria-label="Git 未提交的变更" aria-multiselectable="true">
        <GitChangeTreeNode
          v-for="node in displayNodes"
          :key="node.path"
          :node="node"
          :depth="0"
          :expanded-dirs="expandedDirs"
          :busy-path="deployingPath"
          :selected-paths="selectedPaths"
          :repo-meta="repoMeta"
          @select="onSelectNode"
          @toggle-dir="toggleDir"
          @deploy-file="handleDeployFile"
          @deploy-dir="handleDeployDir"
          @quick-deploy="quickDeploy"
          @select-path="selectPathByKey"
          @select-all-visible="selectAllVisible"
          @clear-selection="clearSelection"
          @show-diff="previewFile = $event"
        />
      </div>
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
/* 焦点容器本身不画外框：焦点交给行 */
.changes-view:focus-visible { outline: none; }
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
/* 尺寸/悬浮由 IconButton 提供；.icon-btn 仅作钩子 */
.refresh-btn { display: flex; align-items: center; gap: 4px; }
.truncated-hint {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 11px;
  color: var(--yellow-text);
  white-space: nowrap;
}
.selection-meta {
  flex: 1;
  min-width: 0;
  margin-left: 12px;
  text-align: right;
  font-size: 11px;
  color: var(--fg2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.changes-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

</style>
