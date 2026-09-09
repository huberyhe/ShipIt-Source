<script setup lang="ts">
import { computed, ref } from 'vue'
import { Wrench, File } from 'lucide-vue-next'
import { useDeployStore } from '../../stores/deploy'
import { useProjectStore } from '../../stores/project'
import BaseDialog from '../common/BaseDialog.vue'

const deployStore = useDeployStore()
const projectStore = useProjectStore()

const confirmFiles = computed(() => deployStore.confirmFiles)
const validFiles = computed(() => confirmFiles.value.filter(f => f.remotePath !== null))
const targetName = computed(() => {
  const t = deployStore.targets.find(t => t.id === deployStore.confirmTargetId)
  return t?.name || '未知目标'
})

const showAll = ref(false)
const previewLimit = 30
const displayedFiles = computed(() => showAll.value ? validFiles.value : validFiles.value.slice(0, previewLimit))

async function handleDeploy() {
  if (!projectStore.projectPath) return
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
    @close="handleCancel"
  >
    <div class="summary">
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
      <button class="cancel-btn" aria-label="取消上传" @click="handleCancel">取消</button>
      <button class="deploy-btn" aria-label="确认上传" :disabled="validFiles.length === 0" @click="handleDeploy">
        上传 {{ validFiles.length }} 个文件
      </button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.summary { padding: 8px 16px; font-size: 12px; color: var(--fg2); }
.show-more { color: var(--accent); cursor: pointer; background: transparent; padding: 0; }
.show-more:hover { color: var(--accent2); }
.file-list { border-top: 1px solid var(--border); }
.file-item { display: flex; align-items: center; gap: 8px; padding: 5px 16px; font-size: 12px; color: var(--fg); border-bottom: 1px solid var(--bg3); }
.file-icon { color: var(--fg2); flex-shrink: 0; }
.file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cancel-btn { padding: 6px 16px; background: var(--bg4); color: var(--fg); border: 1px solid var(--border2); border-radius: 4px; font-size: 12px; }
.cancel-btn:hover { background: var(--bg5); color: var(--fg3); }
.deploy-btn { padding: 6px 16px; background: var(--accent); color: var(--on-accent); border-radius: 4px; font-size: 12px; }
.deploy-btn:hover { background: var(--accent2); }
.deploy-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
