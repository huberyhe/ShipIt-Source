<script setup lang="ts">
import { ref, watch } from 'vue'
import { FileCode } from 'lucide-vue-next'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import BaseDialog from '../common/BaseDialog.vue'

const props = defineProps<{ filePath: string }>()
const emit = defineEmits<{ close: [] }>()

const gitStore = useGitStore()
const projectStore = useProjectStore()
const diffContent = ref('')
const isLoading = ref(false)

async function loadDiff() {
  if (!projectStore.projectPath) return
  isLoading.value = true
  try {
    diffContent.value = await gitStore.getFileDiff(projectStore.projectPath, props.filePath)
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
