<script setup lang="ts">
/**
 * 行内操作区（悬浮/键盘聚焦时才显示）。
 *
 * 显隐规则的唯一实现：宿主行加 `has-row-actions` 类，样式在 App.vue 的全局规则里
 * （`.has-row-actions:hover .row-actions` 等）。此前三处各写一套：
 * TreeRow 用 `:deep`、MappingEditor 只认 hover（键盘焦点落在看不见的按钮上）、
 * ProjectSelector 又写一份。
 *
 * 为什么用 `:has(:focus-visible)` 而不是 `:focus-within`：
 * 鼠标点过行后按钮不该常驻显示，只有键盘焦点进入时才展开。
 */
withDefaults(defineProps<{ always?: boolean }>(), { always: false })
</script>

<template>
  <div class="row-actions" :class="{ always }">
    <slot />
  </div>
</template>
