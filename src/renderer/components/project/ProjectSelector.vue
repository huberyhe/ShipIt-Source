<script setup lang="ts">
import { FolderOpen, Folder, ArrowRight } from 'lucide-vue-next'

defineProps<{
  recentProjects: string[]
}>()

const emit = defineEmits<{
  opened: [path: string]
  openRecent: [path: string]
}>()

async function handleOpen() {
  const result = await window.deployApi.openProject()
  if (result) {
    emit('opened', result.path)
  }
}
</script>

<template>
  <div class="project-selector">
    <div class="selector-card">
      <h1 class="app-title">ShipIt</h1>
      <p class="app-subtitle">开发者文件发布工具 · 一键上传到多台服务器</p>

      <button class="open-btn" @click="handleOpen">
        <FolderOpen :size="20" />
        <span>打开项目目录</span>
      </button>

      <div v-if="recentProjects.length > 0" class="recent-section">
        <h3>最近打开的项目</h3>
        <div
          v-for="proj in recentProjects"
          :key="proj"
          class="recent-item"
          @click="emit('openRecent', proj)"
        >
          <Folder :size="14" />
          <span class="recent-path">{{ proj }}</span>
          <ArrowRight :size="14" class="arrow" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.project-selector {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: var(--bg);
}

.selector-card {
  text-align: center;
  max-width: 500px;
}

.app-title {
  font-size: 28px;
  color: var(--fg3);
  margin-bottom: 8px;
}

.app-subtitle {
  font-size: 14px;
  color: var(--fg2);
  margin-bottom: 32px;
}

.open-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 32px;
  background: var(--accent);
  color: var(--fg3);
  border-radius: 6px;
  font-size: 15px;
  transition: background 0.15s;
}

.open-btn:hover {
  background: var(--accent2);
}

.recent-section {
  margin-top: 40px;
  text-align: left;
}

.recent-section h3 {
  font-size: 12px;
  color: var(--fg2);
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: var(--fg);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.recent-item:hover {
  background: var(--bg3);
}

.recent-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.arrow {
  color: var(--fg2);
  opacity: 0;
  transition: opacity 0.15s;
}

.recent-item:hover .arrow {
  opacity: 1;
}
</style>
