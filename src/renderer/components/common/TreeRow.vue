<script setup lang="ts">
/**
 * 通用树行：只负责行布局、缩进、hover/active/selected/focus 态与「悬浮才显示的操作区」。
 *
 * 边界：
 * - 不持展开/选中状态（由调用方传入 `selected` / `ariaExpanded`）；
 * - 不做递归，不决定点击后的行为（`@click` / `@contextmenu` / `@keydown` 原样透传到根元素）；
 * - 行内容全部通过 slot 提供，本组件不认识「目录/文件/变更状态」。
 *
 * 操作按钮统一包在 `.row-actions` 里：显隐由本组件负责，键盘聚焦时也会出现
 * （此前两个树各写一份 `:hover` + `:has(:focus-visible)`）。
 */
withDefaults(
  defineProps<{
    /** 保留调用方原有类名（如 ftn-row / tree-row），ui-audit 依赖它们定位 */
    rowClass?: string | string[]
    selected?: boolean
    /** 左内边距（px）：由调用方按 depth 计算（不要在这里写死缩进规则） */
    indent: number
    role?: string
    ariaExpanded?: boolean
    tabindex?: number
  }>(),
  { selected: false, role: undefined, ariaExpanded: undefined, tabindex: undefined }
)
</script>

<template>
  <div
    class="tree-row-base"
    :class="[rowClass, { selected }]"
    :style="{ paddingLeft: indent + 'px' }"
    :role="role"
    :aria-expanded="ariaExpanded"
    :tabindex="tabindex"
  >
    <slot name="before" />
    <slot name="toggle" />
    <slot name="icon" />
    <slot name="label" />
    <slot name="meta" />
    <slot name="actions" />
  </div>
</template>

<style scoped>
.tree-row-base {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 8px; font-size: 13px; color: var(--fg);
  cursor: pointer;
  transition: background 0.15s ease;
}
.tree-row-base:hover { background: var(--bg2); }
.tree-row-base:active { background: var(--bg4); }
/* 放在 :hover 之后：同特异度，后写者生效（选中态不会被 hover 盖掉） */
.tree-row-base.selected { background: var(--accent3); }
.tree-row-base:focus-visible { outline: 2px solid var(--status-bar); outline-offset: -2px; }

/* 悬浮/键盘聚焦时才显示的操作按钮（slot 内容用 :deep 才能命中） */
.tree-row-base :deep(.row-actions) { opacity: 0; transition: opacity 0.15s ease; }
.tree-row-base:hover :deep(.row-actions),
.tree-row-base:has(:focus-visible) :deep(.row-actions) { opacity: 1; }
</style>
