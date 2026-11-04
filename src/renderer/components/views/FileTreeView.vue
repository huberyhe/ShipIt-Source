<script setup lang="ts">
import { computed, nextTick, ref, onMounted, onUnmounted, watch } from 'vue'
import { useUiStore } from '../../stores/ui'
import { useFilesStore } from '../../stores/files'
import type { FileEntry } from '../../stores/files'
import { ChevronsUpDown, ChevronsDownUp, RefreshCw } from 'lucide-vue-next'
import { reportError } from '../../utils/report-error'
import { useDeployStore } from '../../stores/deploy'
import { useSelectionDeploy } from '../../composables/useSelectionDeploy'
import { useProjectStore } from '../../stores/project'
import FileTreeNode from '../filetree/FileTreeNode.vue'
import EmptyState from '../common/EmptyState.vue'
import ViewHeader from '../common/ViewHeader.vue'
import IconButton from '../common/IconButton.vue'
import ContextMenu from '../common/ContextMenu.vue'
import ServerTargetMenu from '../common/ServerTargetMenu.vue'
import { useDeployHotkeys } from '../../composables/useDeployHotkeys'
import { isEscapeKey, isSelectAllKey, parentRowOf, rowPaths, visibleRows } from '../../utils/tree-keyboard'
import { isOnRow, leaveZoneBackward, tabIntoZoneControls } from '../../utils/focus-zone'
import { shouldCollapseOnSpace } from '../../utils/selection'
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

  // Alt+Enter：只上传焦点所在行（与行内「快速上传」按钮**同一实现**，不复制收集逻辑；
  // 作用于本行，与 Ctrl+X 的选区语义区分开）。按钮是 tabindex=-1，鼠标/键盘都能到它。
  if (event.altKey && event.key === 'Enter') {
    if (index < 0) return
    event.preventDefault()
    row?.querySelector<HTMLButtonElement>('.ftn-deploy-btn')?.click()
    return
  }

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
      // 空格：选中当前行；**已经是唯一选中项时再按一次 = 取消选中**。
      // Ctrl/Cmd+空格 仍是多选切换（Windows 输入法占用时由主进程抢注转发）。
      const uiStore = useUiStore()
/** 选区规模发布给 uiStore（菜单栏读它判断“上传所选”是否可用，不再用 DOM 探针） */
watch(
  () => filesStore.deploySelection.length,
  (count) => uiStore.setSelectionCount(count),
  { immediate: true }
)

const selectedPaths = filesStore.deploySelection.map((item) => item.path)
      if (!event.ctrlKey && !event.metaKey && shouldCollapseOnSpace(selectedPaths, path)) {
        filesStore.clearSelection()
        return
      }
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
  function handleCollapseAll() {
    // 全部收起要连 store 里的展开态一起清，否则刷新后又会一个个展开回来
    filesStore.clearExpandedDirs()
    expandAllFlag.value = false
    collapseAllCounter.value++
  }

/** 刷新中：只管按钮禁用态，不改表头文案（避免文字长短变化引来额外视觉跳动） */
const isRefreshing = ref(false)
const snapshotAt = ref<Date | null>(null)
/**
 * 刷新序号：参与行 key，强制节点重建。
 *
 * 不加它时 Vue 会按 path 复用旧节点 —— 根级目录"看着还展开着"，但里面还是上一次
 * `expandDirectory` 拿到的旧列表（上层新/下层陈旧的假一致）。宁可收起展开态，不要错的数据。
 */
const refreshSeq = ref(0)

/** `HH:mm:ss`（秒级足够核验；等宽数字避免每跳一秒就把后面的内容推一下） */
function formatClock(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(d)}`
}

const snapshotLabel = computed(() => (snapshotAt.value ? `${formatClock(snapshotAt.value)} 刷新` : ''))
const snapshotTitle = computed(() =>
  snapshotAt.value
    ? `这份文件树的数据快照：${formatStamp(snapshotAt.value)}（切回本窗口会自动刷新，也可按 F5 或点右上角刷新）`
    : ''
)

/**
 * 重新加载根目录。
 *
 * 能保住什么：选区（在 store 里，按路径保存）、**已展开的目录**（展开态也在 store 里，
 * 节点重建后自己重新拉子项）、焦点（原来在哪一行就回到哪一行）。
 * 仍然重建节点（refreshSeq）：复用旧节点会留下“上层已刷新、下层是旧列表”的假一致。
 * 重刷后“旧快照里的文件已不存在”时，选区仍按原路径保留（与切视图回来时一致），不做静默清除。
 */
async function refresh(): Promise<void> {
  const root = projectStore.projectPath
  if (!root || isRefreshing.value) return
  // 焦点原来在某一行上：重建后把焦点还回去（否则 F5 一下键盘焦点就掉到 body）
  const focusedPath = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.ftn-row')?.dataset.path
  isRefreshing.value = true
  try {
    await filesStore.loadFileTree(root)
    refreshSeq.value++
    // 只在本视图真正加载过之后才显示时间：表头里的时间必须对应屏幕上这批数据
    snapshotAt.value = new Date()
    if (focusedPath) {
      await nextTick()
      // 用 dataset 逐个比，不拼选择器（路径里有反斜杠/冒号，转义容易出错）
      const still = Array.from(zoneEl.value?.querySelectorAll<HTMLElement>('.ftn-row') ?? [])
        .find((row) => row.dataset.path === focusedPath)
      // 已经不在了（文件被删/改名）就把焦点交给容器，由它恢复到最近一行
      const next = still ?? zoneEl.value
      next?.focus()
    }
  } catch (error) {
    // 失败必须可见（不许空 catch）：旧树保持原样，时间戳停在上一批
    reportError('刷新文件树失败', error)
  } finally {
    isRefreshing.value = false
  }
}

// F5 由 App.vue 统一处理并派发（铁律 5），只有当前挂载的视图响应
function onRefreshView(): void {
  void refresh()
}

/**
 * 窗口重新获得焦点（用户从 IDE / 资源管理器改完文件切回来）时刷新一次。
 *
 * 为什么只做聚焦刷新、不做轮询：目录树每展开一层都是一次 readdir，轮询纯属白烧 IO；
 * 而真正需要看到新文件的时刻，几乎都是"我刚在外面改完切回来"。
 * 这样三视图的新鲜度策略一致：Git 变更 / 提交历史是 60s 轮询 + 聚焦刷新，文件树是聚焦刷新。
 * 表头的「HH:mm:ss 刷新」因此有了确切含义：上次真正拉取数据的时刻。
 */
function onWindowFocus(): void {
  // 只有本窗口真的拿到焦点才刷（焦点可能落到别的窗口上，此时不该动树）
  if (!document.hasFocus()) return
  void refresh()
}

// Ctrl+Shift++ / Ctrl+Shift+- 与 F5 均回 App 统一派发（只有当前挂载的视图会收到）
onMounted(() => {
  window.addEventListener('tree-expand-all', handleExpandAll)
  window.addEventListener('tree-collapse-all', handleCollapseAll)
  window.addEventListener('refresh-view', onRefreshView)
  window.addEventListener('focus', onWindowFocus)
  // 视图切换（Ctrl+1/2/3）会重建组件，展开态本来就已释放；
  // 既然要重建，就顺手拉一次根目录（单层 readdir，很便宜）——否则"回到本视图"看到的
  // 仍是项目打开那一刻的旧列表，而树又没有任何自动刷新。
  void refresh()
})
onUnmounted(() => {
  // 展开态**跨视图保留**（切走再回来应该还是原样）；
  // 但不能“回来时再动态展开”：子项缓存（filesStore.dirChildren）保证首帧就是展开后的样子。
  window.removeEventListener('tree-expand-all', handleExpandAll)
  window.removeEventListener('tree-collapse-all', handleCollapseAll)
  window.removeEventListener('refresh-view', onRefreshView)
  window.removeEventListener('focus', onWindowFocus)
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

/**
 * 选区规模（P0-2）：按 Ctrl+X 之前就能看出"要发几个"。
 * 只数顶层选中项里的目录个数，**不递归统计目录下的文件数**（会把 UI 卡在几万个文件的遍历上）；
 * "含目录"本身就是提示：选目录会带出整个目录里的文件。
 */
const selectionText = computed(() => {
  const total = filesStore.deploySelection.length
  if (total === 0) return ''
  const dirs = filesStore.deploySelection.filter((item) => item.isDirectory).length
  return dirs > 0 ? `已选 ${total} 项（含 ${dirs} 个目录）` : `已选 ${total} 项`
})
</script>

<template>
  <div ref="zoneEl" class="filetree-view" data-focus-zone tabindex="0" @keydown="onContentKeydown" @focusin="onContentFocus">
    <ViewHeader title="文件树">
      <template #meta>
        <span class="file-count" v-if="filesStore.fileTree" :title="`已加载 ${loadedFiles} 个文件、${loadedDirs} 个目录`">{{ loadedFiles }} 文件 · {{ loadedDirs }} 目录</span>
        <!-- 快照时间：回答"这批是什么时候的"；宽度用等宽数字稳定，右侧用 flex 位置固定（出现/消失不推邻元素） -->
        <span v-if="snapshotLabel" class="snapshot-time" :title="snapshotTitle">{{ snapshotLabel }}</span>
        <span class="selection-meta" :title="selectionText ? 'Ctrl+X / 右键「快速上传」上传的是这些选中项' : ''">{{ selectionText }}</span>
      </template>
      <template #actions>
        <IconButton
          class="icon-btn refresh-btn"
          size="sm"
          tabindex="-1"
          label="刷新文件树"
          title="刷新（F5）"
          :disabled="isRefreshing"
          @click="refresh"
        >
          <RefreshCw :size="14" />
        </IconButton>
        <IconButton class="icon-btn" size="sm" tabindex="-1" label="全部展开" @click="handleExpandAll">
          <ChevronsUpDown :size="14" />
        </IconButton>
        <IconButton class="icon-btn" size="sm" tabindex="-1" label="全部收起" @click="handleCollapseAll">
          <ChevronsDownUp :size="14" />
        </IconButton>
      </template>
    </ViewHeader>
    <div class="file-list">
      <!-- role="tree"：容器单一 Tab 停靠点模型不变（行仍 tabindex=-1，↑/↓ 进出行）。
           空态放在树外：树里只允许 treeitem/group 子节点。 -->
      <div v-if="rootChildren.length > 0" role="tree" aria-label="项目文件树" aria-multiselectable="true">
        <FileTreeNode v-for="entry in rootChildren" :key="`${entry.path}#${refreshSeq}`" :entry="entry" :depth="0"
          :expand-all="expandAllFlag" :collapse-all="collapseAllCounter" />
      </div>
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
/* 快照时间：等宽数字（每秒跳变不改变自身宽度，不推后面的元素） */
.snapshot-time { color: var(--fg2); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 选区规模占了"剩余宽度"并右对齐：出现/消失都不移动左侧计数与右侧按钮（防抖动） */
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
/* 尺寸/悬浮/禁用由 IconButton 提供；.icon-btn 仅保留为定位/测试钩子 */
.file-list { flex: 1; overflow-y: auto; padding: 4px 0; }
</style>
