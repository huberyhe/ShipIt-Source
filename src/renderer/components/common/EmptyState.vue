<script setup lang="ts">
/**
 * 空态：统一「没有内容」的呈现，避免每个视图各写一套 padding/字号/颜色。
 *
 * 三档尺寸对应真实出现的三种场景（此前 padding 分别是 4 / 8 / 24 / 32）：
 * - `inline`：嵌在列表/面板里的一行提示（4x0）
 * - `block` ：占据一个区块（16px）
 * - `page`  ：占满整个视图（24px）
 *
 * 边界：只做展示，不判断 loading（加载中/空态由调用方 `v-if` 决定）。
 */
withDefaults(
  defineProps<{
    /** 主文案 */
    text: string
    /** 次要说明（可选） */
    description?: string
    size?: 'inline' | 'block' | 'page'
    /** 虚线边框：用于「可添加内容」的空区域（如上传目标列表） */
    bordered?: boolean
  }>(),
  { description: '', size: 'page', bordered: false }
)
</script>

<template>
  <div class="empty-state" :class="[`e-${size}`, { bordered }]">
    <div class="empty-text">{{ text }}</div>
    <div v-if="description" class="empty-desc">{{ description }}</div>
    <slot />
  </div>
</template>

<style scoped>
.empty-state { text-align: center; color: var(--fg2); }
.e-inline { padding: 4px 0; font-size: 12px; }
.e-block { padding: 16px 0; font-size: 12px; }
.e-page { padding: 24px; font-size: 13px; }
.bordered { border: 1px dashed var(--border); border-radius: 6px; }
.empty-desc { margin-top: 4px; font-size: 11px; opacity: 0.8; }
</style>
