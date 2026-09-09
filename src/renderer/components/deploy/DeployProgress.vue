<script setup lang="ts">
import { computed } from 'vue'
import { Wrench, X } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'

const deployStore = useDeployStore()

const progressPercent = computed(() => {
  if (deployStore.uploadProgress.total === 0) return 0
  return Math.round((deployStore.uploadProgress.current / deployStore.uploadProgress.total) * 100)
})
</script>

<template>
  <div class="progress-overlay">
    <div class="progress-card">
      <div class="progress-header">
        <Wrench :size="16" />
        <span>正在上传...</span>
        <button class="cancel-btn" aria-label="取消上传" @click="deployStore.cancelUpload()">
          <X :size="14" /> 取消
        </button>
      </div>

      <div class="progress-bar-track">
        <div class="progress-bar-fill" :style="{ width: progressPercent + '%' }"></div>
      </div>

      <div class="progress-info" aria-live="polite">
        <span class="percent">{{ progressPercent }}%</span>
        <span class="count">{{ deployStore.uploadProgress.current }} / {{ deployStore.uploadProgress.total }}</span>
      </div>

      <div class="current-file">
        <span v-if="deployStore.uploadProgress.file" class="current-file-text" :title="deployStore.uploadProgress.file">{{ deployStore.uploadProgress.file }}</span>
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
.progress-card {
  width: 320px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}
.progress-header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fg);
  font-size: 13px;
  margin-bottom: 12px;
}
.cancel-btn {
  margin-left: auto;
  display: flex; align-items: center; gap: 3px;
  padding: 3px 8px;
  background: var(--bg4); color: var(--fg);
  border: 1px solid var(--border2); border-radius: 4px;
  font-size: 11px;
}
.cancel-btn:hover { background: var(--red-bg2); color: var(--red); border-color: var(--red); }
.progress-bar-track { height: 6px; background: var(--bg5); border-radius: 4px; overflow: hidden; }
.progress-bar-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s ease; }
.progress-info { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; color: var(--fg2); }
.percent { font-weight: 500; color: var(--fg); }
.current-file { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--bg3); min-height: 27px; box-sizing: border-box; }
.current-file-text { font-size: 11px; color: var(--fg2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; line-height: 16px; }
</style>
