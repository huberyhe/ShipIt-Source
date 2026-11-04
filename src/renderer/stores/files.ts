import { defineStore } from 'pinia'
import { reduceSelection } from '../utils/selection'
import { ref } from 'vue'

export interface FileEntry {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  size: number
  modifiedAt: number
  children?: FileEntry[]
  gitStatus?: 'modified' | 'added' | 'deleted' | 'untracked' | null
}

export const useFilesStore = defineStore('files', () => {
  const fileTree = ref<any>(null)
  const selectedFiles = ref<Set<string>>(new Set())
  const isLoading = ref(false)
  /** 服务器菜单（Ctrl+Shift+X）作用的选中项（点击行时设置） */
  const selectedDeployEntry = ref<FileEntry | null>(null)
  /** 选中时的鼠标坐标，用于菜单定位 */
  const selectedDeployPos = ref<{ x: number; y: number } | null>(null)

  /** 多选集合（Ctrl 切换 / Shift 区间），顺序即加入顺序 */
  const deploySelection = ref<Array<{ path: string; name: string; isDirectory: boolean }>>([])
  /** Shift 区间的锚点（最近一次单选/切换的路径） */
  const selectionAnchor = ref<string | null>(null)
  /** 已挂载节点的索引：Shift 区间只需要路径，用它还原条目信息 */
  const entryIndex = new Map<string, { path: string; name: string; isDirectory: boolean }>()

  function registerDeployEntry(entry: FileEntry): void {
    entryIndex.set(entry.path, { path: entry.path, name: entry.name, isDirectory: entry.isDirectory })
  }
  function unregisterDeployEntry(path: string): void {
    entryIndex.delete(path)
  }
  function isDeploySelected(path: string): boolean {
    return deploySelection.value.some((item) => item.path === path)
  }

  /** 选区状态 → 共享 reducer（与 Git 变更树同一套语义） */
  function applySelection(action: { path: string; mode: 'replace' | 'toggle' | 'range'; order?: string[] }): void {
    const next = reduceSelection(
      { paths: deploySelection.value.map((item) => item.path), anchor: selectionAnchor.value },
      action
    )
    selectionAnchor.value = next.anchor
    deploySelection.value = next.paths
      .map((path) => entryIndex.get(path))
      .filter((item): item is { path: string; name: string; isDirectory: boolean } => !!item)
  }

  /** 只更新「当前行」（Shift 区间时不能改锚点，否则区间退化成单点） */
  function setCurrent(entry: FileEntry | null, pos?: { x: number; y: number }): void {
    selectedDeployEntry.value = entry
    if (pos) selectedDeployPos.value = pos
  }

  function selectDeployEntry(
    entry: FileEntry | null,
    pos?: { x: number; y: number },
    mode: 'replace' | 'toggle' = 'replace'
  ): void {
    setCurrent(entry, pos)
    if (!entry) return
    applySelection({ path: entry.path, mode })
  }

  /** 按路径单选/切换（键盘导航用：焦点移动时同步选区） */
  function selectDeployPath(path: string, mode: 'replace' | 'toggle' = 'replace'): void {
    const item = entryIndex.get(path)
    if (!item) return
    selectDeployEntry(item as FileEntry, undefined, mode)
  }

  /** 按可见行顺序整体选中（Ctrl+A） */
  function selectDeployPaths(paths: string[]): void {
    const items = paths
      .map((path) => entryIndex.get(path))
      .filter((item): item is { path: string; name: string; isDirectory: boolean } => !!item)
    deploySelection.value = items
    selectionAnchor.value = items.length > 0 ? items[items.length - 1].path : null
  }

  /** Shift 区间：右端是 clickedPath；锚点保持不变（伸缩语义） */
  function selectDeployRange(visiblePaths: string[], clickedPath: string): void {
    applySelection({ path: clickedPath, mode: 'range', order: visiblePaths })
  }

  /**
   * 已展开目录（按绝对路径）。
   * 刷新（F5）会用 refreshSeq 重建行节点；展开态不再存在子组件里，而是记在这里，
   * 节点重新挂载时自己恢复 —— 否则每次 F5 都把用户辛苦展开的目录收起来。
   */
  const expandedDirs = ref<Set<string>>(new Set())
  /** 当前树根：换项目时必须清空展开态（旧路径对新项目无意义） */
  const treeRoot = ref('')

  function isDirExpanded(path: string): boolean {
    return expandedDirs.value.has(path)
  }

  function setDirExpanded(path: string, value: boolean): void {
    const next = new Set(expandedDirs.value)
    if (value) next.add(path)
    else next.delete(path)
    expandedDirs.value = next
  }

  function clearExpandedDirs(): void {
    expandedDirs.value = new Set()
  }

  /**
   * 请求序号：连续切项目（A → B）时，A 的响应若比 B 晚到，会把 A 的树写到 B 的项目上
   * （projectStore 已指向 B，界面却是 A 的文件）——而下一步就是“选中全部发出去”。
   * git store 的 statusSeq / refsSeq / logSeq 早就有这个保护，文件树是唯一的缺口。
   */
  let treeSeq = 0

  async function loadFileTree(rootPath: string) {
    const seq = ++treeSeq
    isLoading.value = true
    try {
      const tree = await window.deployApi.getFileTree(rootPath)
      if (seq !== treeSeq) return // 过期响应：丢弃，不动 state
      if (rootPath !== treeRoot.value) {
        treeRoot.value = rootPath
        clearExpandedDirs()
      }
      fileTree.value = tree
    } finally {
      if (seq === treeSeq) isLoading.value = false
    }
  }

  async function expandDirectory(dirPath: string): Promise<FileEntry[]> {
    try {
      return await window.deployApi.expandDirectory(dirPath)
    } catch {
      return []
    }
  }

  function toggleFileSelection(filePath: string) {
    const newSet = new Set(selectedFiles.value)
    if (newSet.has(filePath)) {
      newSet.delete(filePath)
    } else {
      newSet.add(filePath)
    }
    selectedFiles.value = newSet
  }

  function clearSelection() {
    selectedFiles.value = new Set()
    deploySelection.value = []
    selectionAnchor.value = null
    selectedDeployEntry.value = null
  }

  return {
    fileTree,
    selectedFiles,
    isLoading,
    selectedDeployEntry,
    selectedDeployPos,
    deploySelection,
    selectDeployEntry,
    selectDeployPath,
    selectDeployPaths,
    selectDeployRange,
    setCurrent,
    registerDeployEntry,
    unregisterDeployEntry,
    isDeploySelected,
    loadFileTree,
    isDirExpanded,
    setDirExpanded,
    clearExpandedDirs,
    expandDirectory,
    toggleFileSelection,
    clearSelection
  }
})
