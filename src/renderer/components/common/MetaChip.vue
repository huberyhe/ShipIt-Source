<script setup lang="ts">
/**
 * 只读小标记：分支名 / 协议 / 来源 / 「跳过」 / 本地·远端路径片段。
 *
 * 边界：**这不是按钮**——没有 hover / focus-visible / disabled，也不承载点击语义。
 * 需要点击的标记请用 `BaseButton`（带文字）或 `IconButton`（纯图标），
 * 不要把本组件加上 `@click` 后当按钮用（读屏仍会读成普通文本，键盘也到不了）。
 *
 * 为什么抽这一个：同一套「11px + 4px 圆角 + 同族色成对（`--x` / `--x-bg`）」的标记
 * 在 5 个文件里各写了一份 —— LogPanel 的来源/项目/跳过/远端路径、GitChangeTreeNode 的仓库分支、
 * MappingEditor 与 TargetEditor 的本地/远端路径、BaseDialog 的标题徽标。
 * 每份都自己挑颜色档位，改一处主题就得追五处（同族色互撞、11px 用 --red 不过 AA 都是这么来的）。
 *
 * 颜色只做**强调**，语义必须由文字本身承担（DESIGN §7 红线 7）：
 * 「跳过」不能只给一个灰点，「读取失败」不能只染红。
 */
withDefaults(
  defineProps<{
    /**
     * 语义色档：
     * - `neutral` 中性（无状态信息，如项目名、备注）
     * - `accent` 强调（分支、协议这类"标识"）
     * - `green` 新增 / 本地路径 / 成功
     * - `blue` 未跟踪 / 远端路径 / 进行中
     * - `yellow` 提醒 / 跳过 / 已取消
     * - `red` 失败 / 已删除
     */
    tone?: 'neutral' | 'accent' | 'green' | 'blue' | 'yellow' | 'red'
    /**
     * - `soft`：同族底色（列表中一眼能扫到，默认）
     * - `outline`：透明底 + 同族描边（贴在浅底/行内时不让色块糊成一片）
     */
    appearance?: 'soft' | 'outline'
    /** `square` = 4px（正文内标记）；`pill` = 999px（仓库分支这类胶囊） */
    shape?: 'square' | 'pill'
    /** 等宽：路径、协议、哈希这类需要字符对齐的内容 */
    mono?: boolean
    /** 悬浮提示；不传则不输出 `title`（避免空 title 出现一个空 tooltip） */
    title?: string
  }>(),
  { tone: 'neutral', appearance: 'soft', shape: 'square', mono: false, title: '' }
)
</script>

<template>
  <span
    class="meta-chip"
    :class="[`tone-${tone}`, `a-${appearance}`, `sh-${shape}`, { mono }]"
    :title="title || undefined"
  >
    <!-- 文本单独一层：父级限宽时省略号只作用在文字上，圆角/内边距不被裁掉 -->
    <span class="chip-text"><slot /></span>
  </span>
</template>

<style scoped>
.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  max-width: 100%;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  /* 每档只声明"底色 / 实色文字 / 描边文字 / 描边线"，具体形态由 a-* 组合 */
  --chip-bg: var(--bg4);
  --chip-fg: var(--fg);
  --chip-outline-fg: var(--fg2);
  --chip-outline-line: var(--border);
}
.chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 形态 */
.a-soft { background: var(--chip-bg); color: var(--chip-fg); }
.a-outline {
  background: transparent;
  color: var(--chip-outline-fg);
  border-color: var(--chip-outline-line);
}
.sh-pill { padding: 0 6px; border-radius: 999px; }
.mono { font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace; }

/* 色档：全部走主题 token，深浅两套主题下同名 token 自动换值 */
.tone-neutral { --chip-bg: var(--bg4); --chip-fg: var(--fg); --chip-outline-fg: var(--fg2); --chip-outline-line: var(--border); }
/* accent 实底而非 accent3 淡底：深色下 --accent-text 压 --accent3 只有 3.94:1（11px 不过 AA），
   而 --on-accent 压 --accent 在两套主题下分别是 6.40 / 4.53。描边档仍用淡底做边界。 */
.tone-accent {
  --chip-bg: var(--accent);
  --chip-fg: var(--on-accent);
  --chip-outline-fg: var(--accent-text);
  --chip-outline-line: var(--accent3);
}
/* 绿/蓝直接作 11px 文字在浅色主题下偏亮，但它们只出现在同族浅底上（成对使用，是既有约定） */
.tone-green { --chip-bg: var(--green-bg); --chip-fg: var(--green); --chip-outline-fg: var(--green); --chip-outline-line: var(--green-bg); }
.tone-blue { --chip-bg: var(--blue-bg); --chip-fg: var(--blue); --chip-outline-fg: var(--blue); --chip-outline-line: var(--blue-bg); }
/* 11px 下 --yellow / --red 达不到 AA，必须换成 *-text 变体（DESIGN §2） */
.tone-yellow { --chip-bg: var(--yellow-bg); --chip-fg: var(--yellow-text); --chip-outline-fg: var(--yellow-text); --chip-outline-line: var(--yellow-bg); }
.tone-red { --chip-bg: var(--red-bg2); --chip-fg: var(--red-text); --chip-outline-fg: var(--red-text); --chip-outline-line: var(--red-bg2); }
</style>
