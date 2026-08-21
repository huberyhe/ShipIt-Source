import { defineStore } from 'pinia'
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
  }

  return {
    fileTree,
    selectedFiles,
    isLoading,
    loadFileTree,
    expandDirectory,
    toggleFileSelection,
    selectAll,
    clearSelection
  }
})
