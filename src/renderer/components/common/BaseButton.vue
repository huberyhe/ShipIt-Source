<script setup lang="ts">
/**
 * 基础按钮：统一主/次/危险按钮的视觉与交互状态。
 *
 * 边界：只负责视觉与原生 button 语义（disabled / loading），不持业务状态、不决定文案。
 * 现有类名（`.save-btn` / `.cancel-btn` / `.add-btn` …）由调用方用 class 透传，
 * `scripts/ui-audit.mjs` 基于类名的选择器因此仍然有效。
 *
 * 危险按钮 hover **必须同时换前景色**：此前 `.danger-btn:hover` 只换背景，
 * 深色下黑字压 `#3a1010`、浅色下白字压 `#ffe0dc`，约 1.3:1，两套主题都读不清。
 */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'danger-ghost'
    size?: 'xs' | 'sm' | 'md' | 'lg'
    disabled?: boolean
    /** 只加 aria-busy 与禁用交互；文案由调用方给（不做"正在保存…"的隐式替换） */
    loading?: boolean
    block?: boolean
    type?: 'button' | 'submit'
  }>(),
  {
    variant: 'secondary',
    size: 'sm',
    disabled: false,
    loading: false,
    block: false,
    type: 'button'
  }
)
</script>

<template>
  <button
    :type="type"
    class="base-btn"
    :class="[`v-${variant}`, `s-${size}`, { block, 'is-loading': loading }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <slot name="icon" />
    <slot />
  </button>
</template>

<style scoped>
.base-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--fg);
  background: transparent;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
.base-btn:active:not(:disabled) { opacity: 0.85; } /* 与全局 button 兜底一致 */
.base-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.base-btn.block { display: flex; width: 100%; }

/* 尺寸：4px 网格 */
.s-xs { padding: 2px 8px; font-size: 11px; }
.s-sm { padding: 4px 12px; font-size: 12px; }
.s-md { padding: 8px 16px; font-size: 12px; }
.s-lg { padding: 10px 20px; font-size: 13px; }

/* 变体：颜色全部走 token，深色模式自动适配 */
.v-primary { background: var(--accent); color: var(--on-accent); }
.v-primary:hover:not(:disabled) { background: var(--accent2); }

.v-secondary { background: var(--bg4); color: var(--fg); border-color: var(--border2); }
.v-secondary:hover:not(:disabled) { background: var(--bg5); color: var(--fg3); }

.v-ghost { background: transparent; color: var(--fg2); }
.v-ghost:hover:not(:disabled) { background: var(--bg3); color: var(--fg); }

.v-outline { background: transparent; color: var(--accent-text); border-color: var(--accent-text); }
.v-outline:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }

.v-danger { background: var(--red); color: var(--on-danger); }
.v-danger:hover:not(:disabled) { background: var(--red-bg2); color: var(--red); border-color: var(--red); }

.v-danger-ghost { background: transparent; color: var(--fg2); }
.v-danger-ghost:hover:not(:disabled) { background: var(--red-bg2); color: var(--red); }

.is-loading { cursor: progress; }
</style>
