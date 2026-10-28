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

  async function loadFileTree(rootPath: string) {
    isLoading.value = true
    try {
      fileTree.value = await window.deployApi.getFileTree(rootPath)
    } finally {
      isLoading.value = false
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

  function selectAll() {
    // TODO: flatten file tree
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
    expandDirectory,
    toggleFileSelection,
    selectAll,
    clearSelection
  }
})
