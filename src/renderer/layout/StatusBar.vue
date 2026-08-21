<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore } from '../stores/project'
import { useGitStore } from '../stores/git'
const projectStore = useProjectStore()
const gitStore = useGitStore()

// 分析中的提示（优先展示，避免看起来卡顿）
const analyzingText = computed(() => {
  if (gitStore.isAnalyzing) return '正在分析 Git 状态...'
  if (gitStore.isLoading) return '正在加载提交历史...'
  return ''
})

const statusText = computed(() => {
  const p: string[] = []
  if (projectStore.projectPath) p.push(projectStore.projectPath)
  if (gitStore.hasGit && gitStore.branch) p.push('分支: ' + gitStore.branch)
  if (gitStore.hasGit) p.push('变更: ' + gitStore.changes.length)
  return p.join('  |  ')
})
</script>
<template>
  <div class="status-bar">
    <div class="status-left">
      <span v-if="analyzingText" class="status-text analyzing">
        <span class="spinner" aria-hidden="true"></span>{{ analyzingText }}
      </span>
      <span v-else class="status-text" :title="statusText">{{ statusText }}</span>
    </div>
  </div>
</template>
<style scoped>
.status-bar { display: flex; align-items: center; height: 24px; padding: 0 12px; background: var(--status-bar); color: #fff; font-size: 12px; flex-shrink: 0; }
.status-left { flex: 1; min-width: 0; }
.status-text { display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analyzing { color: #fff; }
.spinner {
  width: 10px; height: 10px; flex-shrink: 0;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
