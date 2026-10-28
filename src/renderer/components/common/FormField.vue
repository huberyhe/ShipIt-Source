<script setup lang="ts">
/**
 * 表单字段：label（可带必填星号）+ 控件 + 可选说明。
 *
 * 边界：只负责「label 在上、控件在下」的纵向布局与文案，不持 `v-model`、
 * 不做校验、不生成 id（`for` / 控件 `id` 由调用方给，保证一对一时可关联）。
 * 宽度修饰（如 `--narrow` / `--port`）由调用方通过 class 加在根上。
 */
const props = withDefaults(
  defineProps<{
    /** 省略时只渲染控件（标签由外层控件组表达，如分段选择器） */
    label?: string
    /** 与控件 id 对应，保证点击 label 能聚焦控件 */
    for?: string
    required?: boolean
    /** 控件下方的说明文字（错误提示请由调用方在控件上表达，不要混用） */
    hint?: string
  }>(),
  { label: undefined, for: undefined, required: false, hint: '' }
)
</script>

<template>
  <div class="form-field">
    <label v-if="props.label" :for="props.for">{{ props.label }}<span v-if="required" class="req" aria-hidden="true">*</span></label>
    <slot />
    <span v-if="hint" class="field-hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.form-field { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.form-field label { font-size: 12px; color: var(--fg2); }
.req { color: var(--red); margin-left: 4px; }
.field-hint { font-size: 11px; color: var(--fg2); opacity: 0.8; }

/* 控件样式也收在这里：两个表单此前各自写一份（padding 8px vs 4px、focus 是否有 box-shadow）。
   焦点态只用全局 2px 环 + 描边，不再 `outline: none`（否则键盘焦点看不见） */
.form-field :deep(input),
.form-field :deep(select) {
  padding: 8px; background: var(--input-bg); color: var(--fg);
  border: 1px solid var(--border); border-radius: 4px; font-size: 12px;
  transition: border-color 0.15s ease;
}
.form-field :deep(input:focus-visible),
.form-field :deep(select:focus-visible) { border-color: var(--status-bar); }
.form-field :deep(input::placeholder) { color: var(--fg2); }
</style>
