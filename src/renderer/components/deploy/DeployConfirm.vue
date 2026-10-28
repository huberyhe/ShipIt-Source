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

/** 传到哪：目标名之外给出协议 + 地址，否则同名目标/多服务器时无法辨认 */
const targetInfo = computed(() => {
  const t = deployStore.targets.find((x) => x.id === deployStore.confirmTargetId)
  if (!t) return ''
  const addr = t.protocol === 'local' ? t.host : `${t.host}${t.port ? ':' + t.port : ''}`
  return addr ? `${(t.protocol as string).toUpperCase()} ${addr}` : (t.protocol as string).toUpperCase()
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
      <span v-if="targetInfo" class="target-line" :title="targetInfo">传到：<strong>{{ targetInfo }}</strong></span>
      共 {{ validFiles.length }} 个文件将上传
      <button v-if="validFiles.length > previewLimit && !showAll" class="show-more" @click="showAll = true">
        （仅显示前 {{ previewLimit }} 个，点击展开全部）
      </button>
    </div>

    <div class="file-list">
      <!-- 没有列头时两列看着像重复打印：必须写明哪边是项目内路径、哪边是服务器路径 -->
      <div class="file-head">
        <span class="file-path">本地（项目内）</span>
        <span class="file-remote">服务器</span>
      </div>
      <div v-for="file in displayedFiles" :key="file.relativePath" class="file-item">
        <File :size="14" class="file-icon" />
        <span class="file-path" :title="file.relativePath">{{ file.relativePath }}</span>
        <!-- 每行显示落到远端的路径：确认弹窗的职责就是回答「传什么、到哪」 -->
        <span v-if="file.remotePath" class="file-remote" :title="file.remotePath">{{ file.remotePath }}</span>
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
.target-line { margin-right: 8px; color: var(--fg2); }
.target-line strong { color: var(--fg); }
.summary { padding: 8px 16px; font-size: 12px; color: var(--fg2); }
.show-more { color: var(--accent-text); cursor: pointer; background: transparent; padding: 0; }
.show-more:hover { color: var(--accent2); }
.file-list { border-top: 1px solid var(--border); }
.file-head {
  display: flex; gap: 8px; padding: 4px 16px;
  font-size: 11px; color: var(--fg2);
  border-bottom: 1px solid var(--bg3);
}
.file-head .file-path { flex: 1; }
.file-head .file-remote { flex: 0 1 40%; text-align: right; }
.file-item { display: flex; align-items: center; gap: 8px; padding: 4px 16px; font-size: 12px; color: var(--fg); border-bottom: 1px solid var(--bg3); }
.file-icon { color: var(--fg2); flex-shrink: 0; }
.file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-remote { flex: 0 1 40%; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg2); }
</style>
