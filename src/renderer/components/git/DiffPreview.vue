<script setup lang="ts">
import { ref, watch } from 'vue'
import { FileCode } from 'lucide-vue-next'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import BaseDialog from '../common/BaseDialog.vue'
import BaseButton from '../common/BaseButton.vue'
import EmptyState from '../common/EmptyState.vue'

const props = defineProps<{ filePath: string }>()
const emit = defineEmits<{ close: [] }>()

const gitStore = useGitStore()
const projectStore = useProjectStore()
const diffContent = ref('')
const errorMessage = ref('')
const isLoading = ref(false)

/**
 * 加载差异：三态（加载中 / 失败 / 成功）。
 * 失败必须与「无变更」分开——“读取失败却显示文件无变更”是最坏的一种误导。
 */
async function loadDiff() {
  if (!projectStore.projectPath) return
  isLoading.value = true
  errorMessage.value = ''
  try {
    const result = await gitStore.getFileDiff(projectStore.projectPath, props.filePath)
    if (result.ok) {
      diffContent.value = result.diff
    } else {
      diffContent.value = ''
      errorMessage.value = result.message || '未知错误'
    }
  } finally {
    isLoading.value = false
  }
}

watch(() => props.filePath, loadDiff, { immediate: true })

function lineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'added'
  if (line.startsWith('-') && !line.startsWith('---')) return 'removed'
  if (line.startsWith('@@')) return 'chunk-header'
  if (line.startsWith('diff ')) return 'diff-header'
  return ''
}
</script>

<template>
  <BaseDialog title="差异预览" :icon="FileCode" @close="emit('close')">
    <template #header-extras>
      <span class="diff-file">{{ filePath }}</span>
    </template>

    <div class="diff-content">
      <div v-if="isLoading" class="diff-loading">加载中...</div>
      <!-- 失败态：标题 + 原因 + 重试。原因用正文色（无 opacity）保证两套主题都过 AA -->
      <EmptyState v-else-if="errorMessage" size="block" text="差异加载失败" role="alert">
        <div class="diff-error-msg" :title="errorMessage">{{ errorMessage }}</div>
        <BaseButton variant="secondary" size="sm" class="retry-btn" aria-label="重新加载差异" @click="loadDiff">重试</BaseButton>
      </EmptyState>
      <div v-else-if="!diffContent.trim()" class="diff-empty">文件无变更</div>
      <div v-else class="diff-body">
        <div
          v-for="(line, idx) in diffContent.split('\n')"
          :key="idx"
          class="diff-line"
          :class="lineClass(line)"
        >{{ line }}</div>
      </div>
    </div>
  </BaseDialog>
</template>

<style scoped>
.diff-file { color: var(--blue); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px; }
.diff-content { background: var(--bg); }
.diff-loading, .diff-empty { padding: 32px; text-align: center; color: var(--fg2); }
/* 失败原因：与 EmptyState 文案同列居中，长错误可换行 */
.diff-error-msg { margin-top: 4px; font-size: 12px; color: var(--fg2); word-break: break-word; }
/* 失败态的“重试”跟随 EmptyState 居中，与上方文案同一列 */
.retry-btn { margin-top: 8px; }
.diff-body { padding: 4px 0; }
.diff-line {
  font-family: 'Cascadia Code','Fira Code',Consolas,monospace;
  font-size: 12px; line-height: 1.5; padding: 0 16px; white-space: pre; min-height: 18px;
}
.diff-line.added { background: var(--green-bg); color: var(--green); }
.diff-line.removed { background: var(--red-bg); color: var(--red); }
.diff-line.chunk-header { color: var(--blue); }
.diff-line.diff-header { color: var(--yellow); font-weight: bold; }
</style>
