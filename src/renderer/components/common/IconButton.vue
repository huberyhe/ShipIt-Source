<script setup lang="ts">
/**
 * 纯图标按钮：只负责「图标 → 可访问按钮」。
 *
 * - `label` 必填：同时落到 `aria-label` 与 `title`（只有图形时读屏无法识别用途）；
 * - 尺寸/悬浮/禁用/按下态统一在这里，避免 `.icon` / `.icon-btn` / `.refresh-btn` 各写一套；
 * - 带**文字**的操作按钮请用 `BaseButton` + `icon` slot，不要复用本组件
 *   （此前两者共用 `.icon-btn` 类名，已经造成语义混淆）。
 */
withDefaults(
  defineProps<{
    label: string
    size?: 'xs' | 'sm' | 'md'
    tone?: 'default' | 'danger'
    disabled?: boolean
    /** 对应 aria-pressed：用于「展开/收起」这类可切换按钮 */
    active?: boolean
  }>(),
  { size: 'sm', tone: 'default', disabled: false, active: false }
)
</script>

<template>
  <button
    type="button"
    class="icon-btn-base"
    :class="[`i-${size}`, `t-${tone}`, { active }]"
    :aria-label="label"
    :title="label"
    :aria-pressed="active || undefined"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.icon-btn-base {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  color: var(--fg2);
  border: 1px solid transparent;
  border-radius: 4px;
  flex-shrink: 0;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
/* 尺寸即点击目标：xs 20 / sm 24 / md 28（4px 网格） */
.i-xs { width: 20px; height: 20px; }
.i-sm { width: 24px; height: 24px; }
.i-md { width: 28px; height: 28px; }

/* 悬浮统一用 bg3：--border 是描边色，当底色用会发灰（此前各文件写法不一） */
.t-default:hover:not(:disabled) { background: var(--bg3); color: var(--fg); }
.t-danger:hover:not(:disabled) { background: var(--red-bg2); color: var(--red); }

.icon-btn-base.active { background: var(--accent3); color: var(--accent-text); }
.icon-btn-base:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
