<script setup lang="ts">
import { statusClassOf, statusShort } from '../../utils/change-status'

/**
 * 变更状态标记（M / A / D / R / ?）。
 *
 * 只负责「状态 → 字母 + 语义色类」这一件事：颜色来自全局 `.status-*`（App.vue），
 * 不再由每个列表各写一份（此前变更树只覆盖 4 种、日志视图多一条 renamed，
 * 结果重命名的文件在变更树里不染色）。
 */
withDefaults(
  defineProps<{
    /** 单词（modified）或 git 字母（M）都接受，未知取值原样显示且不染色 */
    status: string
    /** 宽度：变更树 16px、日志详情 18px */
    width?: number
  }>(),
  { width: 16 }
)
</script>

<template>
  <span
    class="status-letter"
    :class="statusClassOf(status)"
    :style="{ width: width + 'px' }"
    :title="statusShort(status)"
  >{{ statusShort(status) }}</span>
</template>

<style scoped>
.status-letter {
  display: inline-block;
  text-align: center;
  font-size: 11px;
  font-weight: bold;
  flex-shrink: 0;
}
</style>
