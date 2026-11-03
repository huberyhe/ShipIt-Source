<script setup lang="ts">
/**
 * 键位提示：`chip` 是带边框的键帽（快捷键弹窗用），`hint` 是无边框的淡字提示（对话框角、菜单右侧用）。
 *
 * 抽出来之前同一批快捷键在 4 个地方各写一份：弹窗里的 `<kbd>`、对话框的 `.close-hint` 文案、
 * 按钮文案里的 “(Esc)”、菜单右侧的原始字符串，形态与宽度都不一致。
 */
withDefaults(
  defineProps<{
    keys: string | string[]
    variant?: 'chip' | 'hint'
    /**
     * `muted`（默认）：用 `--fg2`，坐在普通底色上。
     * `inherit`：跟随所在按钮/容器自己的前景色 —— 放在**实色主按钮**里时用它，
     * 否则 `--fg2` 压在 accent 底上过不了 AA（审计 contrast/aa 会报）。
     */
    tone?: 'muted' | 'inherit'
  }>(),
  { variant: 'chip', tone: 'muted' }
)
</script>

<template>
  <span class="kbd-group">
    <kbd
      v-for="k in (Array.isArray(keys) ? keys : [keys])"
      :key="k"
      :class="[variant, tone === 'inherit' ? 'tone-inherit' : '']"
    >{{ k }}</kbd>
  </span>
</template>

<style scoped>
.kbd-group { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
kbd {
  font-family: inherit;
  line-height: 1.4;
  white-space: nowrap;
}
kbd.chip {
  padding: 4px 8px;
  background: var(--bg5); color: var(--fg);
  border: 1px solid var(--border2); border-bottom-width: 2px;
  border-radius: 4px;
  font-size: 11px;
}
kbd.hint {
  padding: 0;
  color: var(--fg2);
  font-size: 11px;
  border: 0;
  background: transparent;
}
/* 放在按钮里：颜色跟按钮走（主按钮白字、次按钮正文色），既贴住控件又保住对比度 */
kbd.tone-inherit { color: inherit; }
kbd.chip.tone-inherit {
  background: transparent;
  border-color: color-mix(in srgb, currentColor 45%, transparent);
}
</style>
