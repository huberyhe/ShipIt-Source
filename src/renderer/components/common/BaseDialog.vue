<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { getCurrentInstance } from 'vue'
import type { Component } from 'vue'

withDefaults(defineProps<{
  title: string
  icon?: Component
  badge?: string
  /** CSS width，如 '600px' / 'min(66.67vw, 1200px)'，默认自适应 */
  width?: string
  /** 点击遮罩是否关闭（默认不关闭，防止误触丢失数据） */
  closeOnOverlay?: boolean
}>(), {
  closeOnOverlay: false
})

const emit = defineEmits<{ close: [] }>()

// 唯一标题 id，供 aria-labelledby 关联
const titleId = `dlg-title-${getCurrentInstance()?.uid ?? 'x'}`
</script>

<template>
  <div class="base-dialog-overlay" @click.self="closeOnOverlay && emit('close')" @keydown.esc="emit('close')">
    <div class="base-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" :style="width ? { width } : {}">
      <div class="base-dialog-header">
        <component :is="icon" v-if="icon" :size="16" class="base-dialog-icon" />
        <span class="base-dialog-title" :id="titleId">{{ title }}</span>
        <span v-if="badge" class="base-dialog-badge">{{ badge }}</span>
        <slot name="header-extras" />
        <button class="base-dialog-close" aria-label="关闭" @click="emit('close')"><X :size="14" /></button>
      </div>
      <div class="base-dialog-body">
        <slot />
      </div>
      <div v-if="$slots.footer" class="base-dialog-footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.base-dialog-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.base-dialog {
  max-width: 92vw;
  max-height: 80vh;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  display: flex; flex-direction: column;
}
.base-dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px;
  background: var(--bg3);
  border-bottom: 1px solid var(--border);
  color: var(--fg);
  flex-shrink: 0;
}
.base-dialog-icon { color: var(--fg2); flex-shrink: 0; }
.base-dialog-title { font-size: 14px; font-weight: 500; white-space: nowrap; }
.base-dialog-badge {
  font-size: 11px; padding: 1px 8px;
  background: var(--accent); color: var(--fg3);
  border-radius: 4px;
}
.base-dialog-close {
  margin-left: auto; padding: 2px;
  background: transparent; color: var(--fg2);
  border-radius: 4px;
}
.base-dialog-close:hover { background: var(--border); color: var(--fg); }
.base-dialog-body { flex: 1; overflow-y: auto; }
.base-dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px;
  background: var(--bg2);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
</style>
