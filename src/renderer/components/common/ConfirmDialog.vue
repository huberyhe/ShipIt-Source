<script setup lang="ts">
/**
 * 确认对话框：复用 BaseDialog 的焦点/遮罩/Esc/Enter 语义，只补「取消 + 确认」页脚。
 *
 * 两个删除确认（目标 / 映射）此前是逐字复制的 BaseDialog 包装；抽成组件后
 * 按钮样式、危险配色、待处理态只保留一份。
 *
 * 边界：不执行业务动作（只 emit），不决定文案；正文走默认 slot。
 */
import BaseDialog from './BaseDialog.vue'
import BaseButton from './BaseButton.vue'

withDefaults(
  defineProps<{
    title: string
    /** 纯文本正文；需要富文本时用默认 slot 覆盖 */
    message?: string
    confirmText?: string
    cancelText?: string
    /** 危险动作（删除类）：确认按钮用红色，hover 同时换前景色 */
    danger?: boolean
    /** 执行中：确认按钮置 loading（禁用交互，不接管文案） */
    pending?: boolean
    width?: string
    confirmOnEnter?: boolean
  }>(),
  {
    message: '',
    confirmText: '确定',
    cancelText: '取消',
    danger: false,
    pending: false,
    width: '400px',
    confirmOnEnter: false
  }
)

defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <BaseDialog
    :title="title"
    :width="width"
    :confirm-on-enter="confirmOnEnter"
    @confirm="$emit('confirm')"
    @close="$emit('cancel')"
  >
    <p class="confirm-text"><slot>{{ message }}</slot></p>
    <template #footer>
      <BaseButton variant="secondary" size="md" class="cancel-btn" @click="$emit('cancel')">
        {{ cancelText }}
      </BaseButton>
      <BaseButton
        :variant="danger ? 'danger' : 'primary'"
        size="md"
        :loading="pending"
        class="confirm-btn"
        @click="$emit('confirm')"
      >
        {{ confirmText }}
      </BaseButton>
    </template>
  </BaseDialog>
</template>

<style scoped>
.confirm-text { font-size: 13px; color: var(--fg); line-height: 1.6; padding: 8px 16px; }
</style>
