<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { formatRefreshAge, formatStamp } from '../../utils/refresh-time'

/**
 * 表头「刷新时间」：正文给相对时长（刚刚 → N分钟前 → N小时前），title 给精确时刻。
 *
 * 为什么做成组件：三个视图都要这一格，而文案必须自己随时间走（1分钟前会变 2分钟前）。
 * 各写一份就是三份定时器 + 三份边界判断，漂移只是时间问题。
 *
 * 为什么不是固定 1s 定时器：1 分钟内只需秒级精度（跨过 60s 就换文案），之后 30s 一次足够；
 * 固定 1s 会让视图每秒重渲染一次，纯属白烧。
 *
 * `at` 必须是**数据真正落到 state 的时刻**（store 里记录），不是"点了刷新按钮的时刻"；
 * 失败时保持旧值，否则一次失败的刷新会把这批旧数据标成「刚刚刷新」。
 */
const props = withDefaults(defineProps<{ at: Date | null; hint?: string }>(), { hint: '' })

const now = ref(Date.now())
let timer: ReturnType<typeof setTimeout> | null = null

const label = computed(() => (props.at ? formatRefreshAge(props.at, new Date(now.value)) : ''))
const title = computed(() => {
  if (!props.at) return ''
  const stamp = `这份数据抓取于 ${formatStamp(props.at)}`
  return props.hint ? `${stamp}（${props.hint}）` : stamp
})

function stop(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function schedule(): void {
  stop()
  const at = props.at
  if (!at) return
  const elapsed = Math.max(0, Date.now() - at.getTime())
  timer = setTimeout(() => {
    now.value = Date.now()
    schedule()
  }, elapsed < 60_000 ? 1_000 : 30_000)
}

// 换了一批数据（含切项目后置空）立刻重算，并重置走时节奏
watch(
  () => props.at,
  () => {
    now.value = Date.now()
    schedule()
  },
  { immediate: true }
)

onUnmounted(stop)
</script>

<template>
  <span v-if="label" class="refresh-stamp" :title="title">{{ label }}</span>
</template>

<style scoped>
/* 等宽数字 + 不换行：文案长度变化时自身宽度稳定，不会把右侧按钮推来推去 */
.refresh-stamp {
  color: var(--fg2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
