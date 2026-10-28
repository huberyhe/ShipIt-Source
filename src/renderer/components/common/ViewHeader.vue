<script setup lang="ts">
/**
 * 内容区视图头：左侧标题、可选次要信息、右侧动作区。
 *
 * 三个视图此前各写一份同构头（padding/font/分隔线一致，但右对齐方式各不相同：
 * 有的 `space-between`、有的 `margin-left:auto`），改一处要改三遍。
 *
 * 约定：根节点保留 `.view-header` 类（审计与既有样式依赖）。
 */
withDefaults(defineProps<{ title?: string }>(), { title: '' })
</script>

<template>
  <div class="view-header">
    <span v-if="title" class="view-title">{{ title }}</span>
    <slot name="meta" />
    <div class="header-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.view-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--fg);
}
.view-title { white-space: nowrap; }
.header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
