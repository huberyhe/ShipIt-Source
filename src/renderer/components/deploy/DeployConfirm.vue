<script setup lang="ts">
import { computed, ref } from 'vue'
import { Wrench, File } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import BaseDialog from '../common/BaseDialog.vue'
import BaseButton from '../common/BaseButton.vue'

const deployStore = useDeployStore()
const projectStore = useProjectStore()

const confirmFiles = computed(() => deployStore.confirmFiles)
const validFiles = computed(() => confirmFiles.value.filter(f => f.remotePath !== null))
const targetName = computed(() => {
  const t = deployStore.targets.find(t => t.id === deployStore.confirmTargetId)
  return t?.name || '未知目标'
})

/** 项目名：多窗口并存时，确认弹窗必须同时显示项目与目标，避免"传到了另一个项目" */
const projectName = computed(() => {
  const path = projectStore.projectPath
  if (!path) return '(未打开项目)'
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
})

const showAll = ref(false)
const previewLimit = 30
const displayedFiles = computed(() => showAll.value ? validFiles.value : validFiles.value.slice(0, previewLimit))

async function handleDeploy() {
  if (!projectStore.projectPath || deployStore.isPreviewing) return
  await deployStore.executeDeploy(projectStore.projectPath)
}
function handleCancel() { deployStore.cancelDeploy() }
</script>

<template>
  <BaseDialog
    title="确认上传"
    :icon="Wrench"
    :badge="targetName"
    width="min(66.67vw, 1200px)"
    close-on-overlay
    confirm-on-enter
    @confirm="handleDeploy"
    @close="handleCancel"
  >
    <div v-if="deployStore.isPreviewing" class="summary computing">正在计算文件...</div>
    <div v-else class="summary">
      <span class="project-line">项目：<strong>{{ projectName }}</strong></span>
      共 {{ validFiles.length }} 个文件将上传
      <button v-if="validFiles.length > previewLimit && !showAll" class="show-more" @click="showAll = true">
        （仅显示前 {{ previewLimit }} 个，点击展开全部）
      </button>
    </div>

    <div class="file-list">
      <div v-for="file in displayedFiles" :key="file.relativePath" class="file-item">
        <File :size="14" class="file-icon" />
        <span class="file-path" :title="file.relativePath">{{ file.relativePath }}</span>
      </div>
    </div>

    <template #footer>
      <BaseButton variant="secondary" size="sm" class="cancel-btn" aria-label="取消上传" @click="handleCancel">取消 (Esc)</BaseButton>
      <BaseButton variant="primary" size="sm" class="deploy-btn" aria-label="确认上传" :disabled="deployStore.isPreviewing || validFiles.length === 0" @click="handleDeploy">
        {{ deployStore.isPreviewing ? '计算中...' : `上传 ${validFiles.length} 个文件 (Enter)` }}
      </BaseButton>
    </template>
  </BaseDialog>
</template>

<style scoped>
.project-line { margin-right: 8px; color: var(--fg2); }
.project-line strong { color: var(--fg); }
.summary { padding: 8px 16px; font-size: 12px; color: var(--fg2); }
.show-more { color: var(--accent-text); cursor: pointer; background: transparent; padding: 0; }
.show-more:hover { color: var(--accent2); }
.file-list { border-top: 1px solid var(--border); }
.file-item { display: flex; align-items: center; gap: 8px; padding: 4px 16px; font-size: 12px; color: var(--fg); border-bottom: 1px solid var(--bg3); }
.file-icon { color: var(--fg2); flex-shrink: 0; }
.file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
