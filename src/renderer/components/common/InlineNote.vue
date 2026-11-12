<script setup lang="ts">
import { computed } from 'vue'
import { AlertCircle, Check, Info, X } from 'lucide-vue-next'

/**
 * 行内状态提示：**图标 + 文字 + role** 一条，承接 DESIGN §7 红线 7
 * （「用颜色单独表达状态」会被打回）。
 *
 * 边界：
 * - 只管「一条提示长什么样、怎么播报」；**同一时刻只显示哪一条**由调用方决定
 *   （TargetEditor 的「最后写者胜」是业务时序，不在这里实现）。
 * - 不自动消失、不带关闭按钮：一次性结果用 `ToastHost`，常驻说明用 `FormField` 的 hint。
 * - 不是按钮，没有 hover / focus；要带「重试」这类动作，用默认插槽塞 `BaseButton`。
 *
 * 为什么抽这一个：`TargetEditor` 的页脚提示与列表内测试结果、`GitChangeTreeNode` 的「读取失败」、
 * `GitLogView` 的「已删除文件不会上传」，四处都在各自拼 `图标 + 文字 + 语义色`，
 * 其中只有两处记得加 role、两处各写了一份 `@keyframes spin`。
 * 把「什么颜色配什么 role、进行中用转圈」收进一个组件，才不会漏。
 */
const props = withDefaults(
  defineProps<{
    /** 语义：`error` 用 `role="alert"` 立即播报，其余用 `role="status"` 温和播报 */
    tone?: 'info' | 'success' | 'warning' | 'error' | 'pending'
    /** 文案；省略时取默认插槽（需要加粗/路径片段等富文本时用插槽） */
    text?: string
    /** `sm` = 11px（行内、列表里）；`md` = 12px（对话框页脚、区块说明） */
    size?: 'sm' | 'md'
    /** 同族底色：用于紧贴列表项的结果标记（如「测试中 / 连接成功」） */
    filled?: boolean
    /** 单行省略（父级需给宽度上限）；全文自动进 `title` */
    truncate?: boolean
    /** 悬浮提示；缺省时 `truncate` 才用 `text` 兜底 */
    title?: string
    /** `false` = 纯视觉、不打断读屏（用于重复出现、非状态变化的信息） */
    announce?: boolean
  }>(),
  {
    tone: 'info',
    text: '',
    size: 'sm',
    filled: false,
    truncate: false,
    title: '',
    announce: true
  }
)

/** 进行中不引第三个图标：同一个 spinner 在两处各写了一份 keyframes，这里收成一份 */
const ICONS = { info: Info, success: Check, warning: AlertCircle, error: X } as const

const isPending = computed(() => props.tone === 'pending')
const icon = computed(() => (isPending.value ? Info : ICONS[props.tone as keyof typeof ICONS] ?? Info))
/** 只有明确要播报时才输出 role：静态说明挂上 role="status" 会让读屏把它当成"刚刚发生" */
const role = computed(() => (props.announce ? (props.tone === 'error' ? 'alert' : 'status') : undefined))
const resolvedTitle = computed(() => props.title || (props.truncate ? props.text : '') || undefined)
</script>

<template>
  <span
    class="inline-note"
    :class="[`tone-${tone}`, `s-${size}`, { filled, truncate }]"
    :role="role"
    :title="resolvedTitle"
  >
    <!-- 图标是装饰：含义由文字承担，读屏不重复念一遍 -->
    <span v-if="isPending" class="note-spinner" aria-hidden="true"></span>
    <component :is="icon" v-else :size="size === 'sm' ? 12 : 14" class="note-icon" aria-hidden="true" />
    <span class="note-text"><slot>{{ text }}</slot></span>
  </span>
</template>

<style scoped>
.inline-note {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  font-size: 11px;
  line-height: 16px;
  /* 中性档的默认前景；各 tone 覆盖颜色，不动布局 */
  color: var(--fg2);
}
.s-md { font-size: 12px; line-height: 20px; }
/* 实色底与 MetaChip 的 soft 档同一形状：1px 上下内边距 + 4px 圆角 */
.filled { padding: 1px 8px; border-radius: 4px; }

.note-icon { flex-shrink: 0; display: block; }
.note-text { min-width: 0; }
.truncate .note-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 语义色：文字与图标同色（color 继承给 svg 的 currentColor） */
.tone-info { color: var(--fg2); }
.tone-success { color: var(--green); }
.tone-warning { color: var(--yellow-text); }
.tone-error { color: var(--red-text); }
.tone-pending { color: var(--blue); }

.filled.tone-info { background: var(--bg4); color: var(--fg); }
.filled.tone-success { background: var(--green-bg); }
.filled.tone-warning { background: var(--yellow-bg); }
.filled.tone-error { background: var(--red-bg2); }
.filled.tone-pending { background: var(--blue-bg); }

/* 进行中：2px 圆环 + 透明缺口，0.8s 匀速（与状态栏同一节奏） */
.note-spinner {
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: note-spin 0.8s linear infinite;
}
@keyframes note-spin {
  to { transform: rotate(360deg); }
}
/* 尊重系统「减少动效」：停转但保留形状与弱化透明度，仍能看出"在等" */
@media (prefers-reduced-motion: reduce) {
  .note-spinner {
    animation: none;
    border-top-color: currentColor;
    opacity: 0.45;
  }
}
</style>
