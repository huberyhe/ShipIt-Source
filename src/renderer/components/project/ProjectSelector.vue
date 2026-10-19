<script setup lang="ts">
import { FolderOpen, Folder, ArrowRight, X } from 'lucide-vue-next'
import { shortenPath } from '../../utils/path-display'

defineProps<{
  recentProjects: string[]
}>()

const emit = defineEmits<{
  opened: [path: string]
  openRecent: [path: string]
  /** 移除单条最近记录（由父组件执行 IPC + 刷新列表） */
  removeRecent: [path: string]
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
        <div v-for="proj in recentProjects" :key="proj" class="recent-row">
          <button type="button" class="recent-item" :title="proj" @click="emit('openRecent', proj)">
            <Folder :size="14" />
            <!-- 长路径省略中段（与状态栏同一实现），完整路径见 title -->
            <span class="recent-path">{{ shortenPath(proj, { maxChars: 56 }) }}</span>
            <ArrowRight :size="14" class="arrow" />
          </button>
          <button
            type="button"
            class="recent-remove"
            :aria-label="`从最近项目移除 ${proj}`"
            title="从最近项目移除"
            @click.stop="emit('removeRecent', proj)"
          ><X :size="12" /></button>
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
  /* 固定宽度：此前卡片按最长一行自适应，导致"路径长的那行背景更长"、各行不齐 */
  width: 460px;
  max-width: 90vw;
}

.app-title {
  font-size: 28px;
  color: var(--fg3);
  margin: 8px;
}

.app-subtitle {
  font-size: 14px;
  color: var(--fg2);
  margin: 32px;
}

.open-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 32px;
  background: var(--accent);
  color: var(--on-accent);
  border-radius: 6px;
  font-size: 15px;
  transition: background 0.15s;
}

.open-btn:hover {
  background: var(--accent2);
}

.recent-section {
  margin: 24px 0 0;
  text-align: left;
}

.recent-section h3 {
  font-size: 12px;
  color: var(--fg2);
  margin: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* 最近项目行：条目 + 移除按钮并排（移除按钮 hover 才显示，避免列表噪音） */
.recent-row { display: flex; align-items: center; gap: 4px; }
.recent-remove {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0;
  background: transparent; color: var(--fg2);
  border: 1px solid transparent; border-radius: 4px; cursor: pointer;
  opacity: 0; transition: opacity 0.15s;
}
.recent-row:hover .recent-remove { opacity: 1; }
.recent-remove:hover { background: var(--red-bg2); color: var(--red); }
.recent-remove:focus-visible { opacity: 1; }


.recent-item {
  width: 100%; text-align: left; font: inherit; cursor: pointer;
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
  /* min-width:0 才能让 flex 项收缩到内容宽度以下（否则长路径把行撑宽、各行背景不齐） */
  min-width: 0;
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
