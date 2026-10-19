<script setup lang="ts">
/**
 * 进度条：确定进度（0–100）与不确定进度（来回滑动）同一个组件。
 *
 * 边界：只做展示，`role="progressbar"` 与 `aria-valuenow/min/max` 由这里提供，
 * 调用方不需要重复标注；不负责计时、不接管文案与百分比数字。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 0–100；传 null / undefined 表示「不确定进度」（往返滑动） */
    value?: number | null
    /** 轨道高度：2px 用于页面顶部，6px 用于卡片内 */
    height?: 2 | 6
    /** 读屏用的进度条名称（如「上传进度」） */
    label?: string
  }>(),
  { value: null, height: 6, label: '进度' }
)

const indeterminate = computed(() => props.value === null || props.value === undefined)
const percent = computed(() => {
  if (indeterminate.value) return 0
  const raw = Number(props.value)
  if (!Number.isFinite(raw)) return 0
  return Math.min(100, Math.max(0, Math.round(raw)))
})
</script>

<template>
  <div
    class="progress-track"
    :class="[`h-${height}`, { indeterminate }]"
    role="progressbar"
    :aria-label="label"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="indeterminate ? undefined : percent"
  >
    <div v-if="indeterminate" class="progress-slide" aria-hidden="true"></div>
    <div v-else class="progress-fill" :style="{ width: percent + '%' }"></div>
  </div>
</template>

<style scoped>
.progress-track { width: 100%; background: var(--bg5); border-radius: 4px; overflow: hidden; }
.h-2 { height: 2px; background: var(--border); }
.h-6 { height: 6px; }

.progress-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s ease; }

.progress-slide {
  display: block; height: 100%; width: 30%;
  background: var(--accent); border-radius: 4px;
  animation: progress-slide 1.15s ease-in-out infinite;
}
@keyframes progress-slide {
  0% { transform: translateX(-100%); }
  50% { transform: translateX(240%); }
  100% { transform: translateX(-100%); }
}
/* 尊重系统的减少动效偏好：不确定进度改为静态 30% 块（仍有形状，不误导为 0%） */
@media (prefers-reduced-motion: reduce) {
  .progress-slide { animation: none; width: 30%; }
}
</style>
