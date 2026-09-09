<script setup lang="ts">
import { computed, ref } from 'vue'
import { useFilesStore } from '../../stores/files'
import FileTreeNode from '../filetree/FileTreeNode.vue'

const filesStore = useFilesStore()
const expandAllFlag = ref(false)
const collapseAllCounter = ref(0)

function handleExpandAll() { expandAllFlag.value = true }
function handleCollapseAll() { expandAllFlag.value = false; collapseAllCounter.value++ }

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
</script>

<template>
  <div class="filetree-view">
    <div class="view-header">
      <span>文件树</span>
      <div class="header-right">
        <span class="file-count" v-if="filesStore.fileTree">已加载 {{ loadedFiles }} 个文件 · {{ loadedDirs }} 个目录</span>
        <button class="header-btn" @click="handleExpandAll">全部展开</button>
        <button class="header-btn" @click="handleCollapseAll">全部收起</button>
      </div>
    </div>
    <div class="file-list">
      <FileTreeNode v-for="entry in rootChildren" :key="entry.path" :entry="entry" :depth="0"
        :expand-all="expandAllFlag" :collapse-all="collapseAllCounter" />
      <div v-if="rootChildren.length === 0 && !filesStore.isLoading" class="empty-state">目录为空</div>
    </div>
  </div>
</template>

<style scoped>
.filetree-view { display: flex; flex-direction: column; height: 100%; }
.view-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); font-size: 12px; color: var(--fg); }
.header-right { display: flex; align-items: center; gap: 6px; }
.file-count { color: var(--fg2); font-size: 11px; }
.header-btn { padding: 3px 10px; background: var(--bg4); color: var(--fg); border: 1px solid var(--border2); border-radius: 4px; font-size: 11px; }
.header-btn:hover { background: var(--bg5); color: var(--fg3); }
.file-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.empty-state { padding: 24px; text-align: center; color: var(--fg2); }
</style>
