<script setup lang="ts">
import { computed } from 'vue'
import { FolderTree, GitBranch, GitCommit } from 'lucide-vue-next'
import { useUiStore } from '../../stores/ui'
import { useGitStore } from '../../stores/git'
import FileTreeView from './FileTreeView.vue'
import GitChangesView from './GitChangesView.vue'
import GitLogView from './GitLogView.vue'
import type { ActiveView } from '../../types'
const uiStore = useUiStore(); const gitStore = useGitStore()
const views = computed(() => {
  const changeCount = gitStore.changes.length
  return [
    { id: 'filetree' as ActiveView, label: '文件树', icon: FolderTree, disabled: false, hasChanges: false, title: '文件树' },
    {
      id: 'gitchanges' as ActiveView,
      label: 'Git变更',
      icon: GitCommit,
      disabled: !uiStore.gitAvailable,
      // 只提示"有未提交变更"（红点），不显示数字：数量在视图标题与 title 里
      hasChanges: changeCount > 0,
      title: changeCount > 0 ? `Git变更（${changeCount} 个未提交变更）` : 'Git变更'
    },
    { id: 'gitlog' as ActiveView, label: 'Git日志', icon: GitBranch, disabled: !uiStore.gitAvailable, hasChanges: false, title: 'Git日志' }
  ]
})
</script>
<template>
  <div class="view-switcher">
    <div class="view-buttons">
      <button
        v-for="view in views"
        :key="view.id"
        class="view-btn"
        :class="{ active: uiStore.activeView === view.id, disabled: view.disabled }"
        :disabled="view.disabled"
        :title="view.title"
        @click="uiStore.switchView(view.id)"
      >
        <component :is="view.icon" :size="18" />
        <span class="btn-label">{{ view.label }}</span>
        <span v-if="view.hasChanges" class="change-dot" aria-hidden="true" />
      </button>
    </div>
    <div class="view-content">
      <FileTreeView v-if="uiStore.activeView === 'filetree'" />
      <GitChangesView v-else-if="uiStore.activeView === 'gitchanges'" />
      <GitLogView v-else-if="uiStore.activeView === 'gitlog'" />
    </div>
  </div>
</template>
<style scoped>
.view-switcher { display: flex; flex: 1; overflow: hidden; }
.view-buttons { display: flex; flex-direction: column; width: 68px; background: var(--bg4); border-right: 1px solid var(--border); flex-shrink: 0; padding: 4px; }
.view-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 52px; padding: 8px 4px; background: transparent; color: var(--fg2); position: relative; border-radius: 0; }
.view-btn:hover:not(.disabled) { background: var(--border); color: var(--fg); }
.view-btn.active { background: var(--bg2); color: var(--fg3); border-left: 2px solid var(--accent); }
.view-btn.disabled { opacity: 0.3; cursor: not-allowed; }
.btn-label { font-size: 11px; line-height: 1.1; white-space: nowrap; }
/*
 * 「有未提交变更」提示：按钮右上角一个红点（绝对定位 → 不参与布局，三个 tab 等高）。
 * 不显示数量：精确数量在视图标题与按钮 title 里，避免角标变宽压住图标、也少一处视觉噪音。
 */
.change-dot {
  position: absolute; top: 4px; right: 4px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--red);
}
.view-content { flex: 1; overflow: hidden; }
</style>
