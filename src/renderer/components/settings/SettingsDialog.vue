<script setup lang="ts">
import TargetEditor from './TargetEditor.vue'
import BaseDialog from '../common/BaseDialog.vue'

defineProps<{ title?: string }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <BaseDialog :title="title || '设置 - 上传目标管理'" width="700px" @close="emit('close')">
    <div class="settings-body">
      <TargetEditor />
    </div>
  </BaseDialog>
</template>

<style scoped>
.settings-body { padding: 16px; }
</style>
