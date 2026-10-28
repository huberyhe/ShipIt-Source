<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { Upload, X } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'

import ProgressBar from '../common/ProgressBar.vue'

const deployStore = useDeployStore()

const progressPercent = computed(() => {
  if (deployStore.uploadProgress.total === 0) return 0
  return Math.round((deployStore.uploadProgress.current / deployStore.uploadProgress.total) * 100)
})

/**
 * 当前文件名：超长时省略**前面**、保留末尾。
 *
 * 上传路径的前缀通常都一样（`dist/assets/...`），真正区分文件的是
 * 尾部（文件名/末级目录）；末尾省略会把最关键的信息先丢掉。
 * 卡片宽度固定（320 - 2×16 = 288px），11px 字号约容纳 52 个字符，留 1 位给 `…`。
 */
const MAX_FILE_CHARS = 52
const currentFile = computed(() => {
  const file = deployStore.uploadProgress.file
  if (!file) return ''
  return file.length <= MAX_FILE_CHARS ? file : '…' + file.slice(-(MAX_FILE_CHARS - 1))
})

// Esc 取消上传（与取消按钮行为一致）
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    deployStore.cancelUpload()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="progress-overlay" tabindex="-1">
    <div class="progress-card">
      <!-- 与其他弹窗一致的右上角关闭样式：Esc 提示 + ✕（不做成常规按钮） -->
      <button class="cancel-btn" type="button" aria-label="取消上传" title="取消上传（Esc）" @click="deployStore.cancelUpload()">
        <span class="close-hint">Esc</span><X :size="14" />
      </button>
      <div class="progress-header">
        <Upload :size="16" class="head-icon" />
        <span>正在上传…</span>
      </div>

      <ProgressBar :value="progressPercent" label="上传进度" />

      <div class="progress-info" aria-live="polite">
        <span class="percent">{{ progressPercent }}%</span>
        <span class="count">{{ deployStore.uploadProgress.current }} / {{ deployStore.uploadProgress.total }}</span>
      </div>

      <!-- 固定高度：文件名从无到有时不会把卡片顶高（避免抖动） -->
      <div class="current-file">
        <span class="current-file-text" :title="deployStore.uploadProgress.file">{{ currentFile }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.progress-overlay {
  position: fixed;
  bottom: 40px;
  right: 12px;
  z-index: 1002;
}
/* 右上角关闭：与 BaseDialog 的 .base-dialog-close 同一套观感（透明、无边框） */
.cancel-btn {
  position: absolute; top: 8px; right: 8px;
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px; line-height: 1;
  background: transparent; color: var(--fg2);
  border: 0; border-radius: 4px; cursor: pointer;
}
.cancel-btn svg { display: block; }
.cancel-btn:hover { background: var(--bg3); color: var(--fg); }
.close-hint { font-size: 11px; line-height: 14px; }

.progress-card {
  position: relative;
  width: 320px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  box-shadow: var(--shadow-float);
}
.progress-header {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 与卡片上边距对齐即可，不要额外 margin（此前 16 + 12 = 28px 顶空，标题被顶到第二行） */
  margin: 0 0 12px;
  padding-right: 32px; /* 给右上角关闭按钮留位 */
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--fg);
}
/* 与标题行同一水平线（标题行高 20 + 卡片 padding 16，按钮 24 高，取 10 居中） */
.cancel-btn { position: absolute; top: 10px; right: 10px; }
/* 与进度条左右边缘严格对齐（此前 margin: 4px 导致数字比进度条内缩 4px） */
.progress-info {
  display: flex; justify-content: space-between;
  margin: 8px 0 0;
  font-size: 12px; color: var(--fg2);
  font-variant-numeric: tabular-nums; /* 数字变化时宽度不跳 */
}
.head-icon { color: var(--accent-text); flex-shrink: 0; }
.percent { font-weight: 500; color: var(--fg); }
.current-file {
  margin: 12px 0 0; padding-top: 8px;
  border-top: 1px solid var(--bg3);
  min-height: 16px; /* 预留一行：与 .current-file-text 的 line-height 一致 */
}
/* 截断由 currentFile 负责（保留末尾）；这里的 ellipsis 只是兜底，避免极端窄窗时溢出 */
.current-file-text { font-size: 11px; color: var(--fg2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; line-height: 16px; }
</style>
