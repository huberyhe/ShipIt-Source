<script setup lang="ts">
/**
 * 区块标题：左标题 + 可选次要信息 + 右侧动作。
 *
 * 抽出来之前同构结构写了三份（设置页的 `.section-header`、卡片内的 `.mapping-header`、
 * 日志面板的折叠头），标题的字号/字重/颜色/外边距各不相同。
 *
 * 本组件只负责「非折叠」区块头；可折叠的条带（上传日志）有自己的键盘与 aria 要求，
 * 仍由 LogPanel 自己实现。
 */
withDefaults(
  defineProps<{
    title: string
    /** section：13px/600；sub：12px 常规、次要色（卡片内小节） */
    size?: 'section' | 'sub'
    /** 语义标题层级（读屏大纲），默认 h3 */
    tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5'
  }>(),
  { size: 'section', tag: 'h3' }
)
</script>

<template>
  <div class="section-header" :class="`is-${size}`">
    <component :is="tag" class="section-title">{{ title }}</component>
    <slot name="meta" />
    <div class="section-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 4px;
}
.section-title { margin: 0; }
.is-section .section-title { font-size: 13px; font-weight: 600; color: var(--fg); }
.is-sub .section-title { font-size: 12px; font-weight: normal; color: var(--fg2); }
.section-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
