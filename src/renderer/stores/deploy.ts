import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DeployTarget, DeployResult } from '../../shared/types'

/** 上传确认弹窗展示的条目（remotePath 为 null 表示无匹配映射，将跳过） */
export interface UploadPreviewItem {
  localPath: string
  remotePath: string | null
  relativePath: string
  size: number
}

/** 上传日志条目，复用 DeployResult 结构 */
export type DeployLogEntry = DeployResult

export const useDeployStore = defineStore('deploy', () => {
  const targets = ref<DeployTarget[]>([])
  const currentTargetId = ref<string>('')
  const deployLogs = ref<DeployLogEntry[]>([])
  const isUploading = ref(false)
  const uploadProgress = ref({ current: 0, total: 0, file: '' })
  const lastDeployTime = ref<string>('')

  // Deploy confirm flow
  const showConfirm = ref(false)
  const confirmFiles = ref<UploadPreviewItem[]>([])
  const confirmTargetId = ref<string>('')

  const currentTarget = computed(() => {
    return targets.value.find(t => t.id === currentTargetId.value) || targets.value[0]
  })

  const currentMappings = computed(() => {
    return currentTarget.value?.mappings || []
  })

  async function loadTargets() {
    try {
      targets.value = await window.deployApi.getTargetList()
      const config = await window.deployApi.loadConfig()
      currentTargetId.value = config.currentTargetId || targets.value[0]?.id || ''
    } catch {
      // ignore
    }
  }

  async function addTarget(target: any) {
    await window.deployApi.addTarget(JSON.parse(JSON.stringify(target)))
    await loadTargets()
  }

  async function updateTarget(id: string, updates: any) {
    await window.deployApi.updateTarget(id, JSON.parse(JSON.stringify(updates)))
    await loadTargets()
  }

  async function removeTarget(id: string) {
    await window.deployApi.removeTarget(id)
    await loadTargets()
  }

  async function addMapping(targetId: string, mapping: any) {
    await window.deployApi.addMapping(targetId, mapping)
    await loadTargets()
  }

  async function updateMapping(targetId: string, mappingId: string, updates: any) {
    await window.deployApi.updateMapping(targetId, mappingId, updates)
    await loadTargets()
  }

  async function removeMapping(targetId: string, mappingId: string) {
    await window.deployApi.removeMapping(targetId, mappingId)
    await loadTargets()
  }

  /**
   * 步骤1: 主进程计算实际上传任务列表（与上传完全一致），弹窗确认
   */
  async function previewDeploy(files: string[], projectRoot: string, targetId?: string) {
    const target = targetId
      ? targets.value.find(t => t.id === targetId)
      : currentTarget.value

    if (!target) {
      window.dispatchEvent(new CustomEvent('toast', { detail: '请先在顶部工具栏选择上传目标' }))
      return
    }
    if (!target.mappings || target.mappings.length === 0) {
      window.dispatchEvent(new CustomEvent('toast', { detail: '当前目标没有配置目录映射，请先在设置中添加' }))
      return
    }

    // 由主进程唯一计算：过滤无映射文件 + 递归目录 + 解析远端路径
    const tasks = await window.deployApi.previewDeployFiles(
      files,
      projectRoot,
      JSON.parse(JSON.stringify(target))
    )

    const previews: UploadPreviewItem[] = (tasks || []).map((t: any) => ({
      localPath: t.localPath,
      remotePath: t.remotePath,
      relativePath: t.relativePath,
      size: t.size || 0
    }))

    confirmFiles.value = previews
    confirmTargetId.value = target.id
    showConfirm.value = true
  }

  /**
   * 取消确认
   */
  function cancelDeploy() {
    showConfirm.value = false
    confirmFiles.value = []
  }

  /**
   * 取消进行中的上传
   */
  async function cancelUpload() {
    try { await window.deployApi.cancelDeploy() } catch {}
    isUploading.value = false
  }

  /**
   * 清空上传日志
   */
  function clearLogs() {
    deployLogs.value = []
  }

  /**
   * 步骤2: 确认后执行上传
   */
  async function executeDeploy(projectRoot: string) {
    const target = targets.value.find(t => t.id === confirmTargetId.value)
    if (!target) throw new Error('未找到上传目标')

    showConfirm.value = false
    isUploading.value = true
    uploadProgress.value = { current: 0, total: 0, file: '' }

    // 设置进度监听
    window.deployApi.onDeployProgress((data) => {
      uploadProgress.value = data
    })

    try {
      // 直接用弹窗展示的任务列表（与预览一致）
      const tasks = confirmFiles.value
        .filter(f => f.remotePath !== null)
        .map(f => ({ localPath: f.localPath, remotePath: f.remotePath!, relativePath: f.relativePath, size: f.size }))

      if (tasks.length === 0) {
        window.dispatchEvent(new CustomEvent('toast', { detail: '没有可上传的文件（所有文件无匹配的目录映射）' }))
        return
      }

      const result = await window.deployApi.deployFiles(tasks, JSON.parse(JSON.stringify(target)))
      deployLogs.value.unshift(result)
      lastDeployTime.value = new Date(result.timestamp).toLocaleTimeString()
      if (result.cancelled) {
        window.dispatchEvent(new CustomEvent('toast', { detail: `上传已取消（已完成 ${result.succeeded} 个文件）` }))
      } else {
        window.dispatchEvent(new CustomEvent('toast-success', { detail: `上传完成: ${result.succeeded} 成功, ${result.failed} 失败` }))
      }
      return result
    } catch (err: any) {
      window.dispatchEvent(new CustomEvent('toast', { detail: '上传失败: ' + (err?.message || String(err)) }))
    } finally {
      isUploading.value = false
      confirmFiles.value = []
    }
  }

  return {
    targets,
    currentTargetId,
    currentTarget,
    currentMappings,
    lastDeployTime,
    deployLogs,
    isUploading,
    uploadProgress,
    showConfirm,
    confirmFiles,
    confirmTargetId,
    loadTargets,
    addTarget,
    updateTarget,
    removeTarget,
    addMapping,
    updateMapping,
    removeMapping,
    previewDeploy,
    cancelDeploy,
    cancelUpload,
    clearLogs,
    executeDeploy
  }
})
