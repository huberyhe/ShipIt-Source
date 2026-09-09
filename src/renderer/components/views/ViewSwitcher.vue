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
const views = computed(() => [
  { id: 'filetree' as ActiveView, label: '文件树', icon: FolderTree, disabled: false, badge: null },
  { id: 'gitchanges' as ActiveView, label: 'Git变更', icon: GitCommit, disabled: !uiStore.gitAvailable, badge: gitStore.changes.length > 0 ? gitStore.changes.length : null },
  { id: 'gitlog' as ActiveView, label: 'Git日志', icon: GitBranch, disabled: !uiStore.gitAvailable, badge: null }
])
</script>
<template>
  <div class="view-switcher">
    <div class="view-buttons">
      <button v-for="view in views" :key="view.id" class="view-btn" :class="{ active: uiStore.activeView === view.id, disabled: view.disabled }" :disabled="view.disabled" :title="view.label" @click="uiStore.switchView(view.id)">
        <component :is="view.icon" :size="18" /><span class="btn-label">{{ view.label }}</span>
        <span v-if="view.badge" class="badge">{{ view.badge }}</span>
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
.view-buttons { display: flex; flex-direction: column; width: 52px; background: var(--bg4); border-right: 1px solid var(--border); flex-shrink: 0; padding-top: 4px; }
.view-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 10px 4px; background: transparent; color: var(--fg2); position: relative; border-radius: 0; }
.view-btn:hover:not(.disabled) { background: var(--border); color: var(--fg); }
.view-btn.active { background: var(--bg2); color: var(--fg3); border-left: 2px solid var(--accent); }
.view-btn.disabled { opacity: 0.3; cursor: not-allowed; }
.btn-label { font-size: 10px; line-height: 1.1; }
.badge { position: absolute; top: 2px; right: 6px; background: var(--red); color: var(--on-danger); font-size: 10px; min-width: 16px; height: 16px; line-height: 16px; border-radius: 8px; text-align: center; padding: 0 4px; }
.view-content { flex: 1; overflow: hidden; }
</style>
