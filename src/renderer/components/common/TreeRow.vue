<script setup lang="ts">
import RowActions from './RowActions.vue'
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
 *
 * 选中与焦点的视觉语言：
 * - 选中 = 蓝色底色 + 白字，**无边框**
 * - 焦点 = **上下边框（另一种颜色）+ 无底色**；已选中的行不再重复画边框
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
    :class="[rowClass, { selected, 'has-row-actions': !!$slots.actions }]"
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
    <RowActions v-if="$slots.actions">
      <slot name="actions" />
    </RowActions>
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
/* 选中 = 强调底色（浅色主题浅蓝、深色主题实色）、不加边框
   （放在 :hover 之后：同特异度，后写者生效） */
.tree-row-base.selected { background: var(--row-selected-bg); color: var(--row-selected-fg); }
/* 选中行悬停不再改底色：--accent2 更亮会让白字掉到 3.5:1，
   color-mix 又会被计算样式序列化成 color(srgb ...)，工具链读不到；
   选中态本身已是强信号，悬停只保留指针反馈 */
/* 焦点 = 上下边框（inset 阴影：不占布局、不引起行高跳动）+ 无底色；
   已选中的行靠蓝底表达，不再叠边框。
   用 :focus 而不是 :focus-visible：行是 tabindex=-1、只能由键盘/代码聚焦，
   而 :focus-visible 的模态判定在程序聚焦时不可靠（会出现“键盘导航却看不到焦点”）。 */
.tree-row-base:focus {
  outline: none;
  box-shadow: inset 0 1px 0 var(--fg2), inset 0 -1px 0 var(--fg2);
}
.tree-row-base.selected:focus {
  box-shadow: none;
}
</style>
