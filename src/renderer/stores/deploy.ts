import { toastError, toastSuccess } from '../utils/toast'
import { defineStore } from 'pinia'
import { reportError } from '../utils/report-error'
import { ref, computed } from 'vue'
import type { DeployTarget, DeployResult } from '../../shared/types'
import { useProjectStore } from './project'
import type { DeployLogEntry } from '../types'

/** 上传日志保留上限（与主进程 MAX_TASK_RECORDS 一致） */
const MAX_DEPLOY_LOGS = 50

/** 上传确认弹窗展示的条目（remotePath 为 null 表示无匹配映射，将跳过） */
export interface UploadPreviewItem {
  localPath: string
  remotePath: string | null
  relativePath: string
  size: number
}

export type { DeployLogEntry } from '../types'

export const useDeployStore = defineStore('deploy', () => {
  const projectStore = useProjectStore()
  const targets = ref<DeployTarget[]>([])
  const currentTargetId = ref<string>('')
  const deployLogs = ref<DeployLogEntry[]>([])
  const isUploading = ref(false)
  const uploadProgress = ref({ current: 0, total: 0, file: '' })
  const lastDeployTime = ref<string>('')

  // Deploy confirm flow
  const showConfirm = ref(false)
  const isPreviewing = ref(false)
  const confirmFiles = ref<UploadPreviewItem[]>([])
  const confirmTargetId = ref<string>('')

  // 预览请求序号：丢弃过期请求的结果
  // （否则先发起的计算后返回时会覆盖新数据，造成“弹窗目标为 B、文件列表却来自 A”的错配）
  let previewSeq = 0

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
      // 保留用户当前选择（若仍存在）：此前每次 loadTargets（含"别的窗口改了配置"触发的重载）
      // 都把选择重置回持久化值或第一个目标 —— 表现为"选过 A，配置一动就跳回 B"，
      // 而下一步就是向错误目标覆盖式上传。
      const stillValid = targets.value.some((t) => t.id === currentTargetId.value)
      if (!stillValid) {
        currentTargetId.value = config.currentTargetId || targets.value[0]?.id || ''
      }
    } catch (error) {
      // 目标列表加载失败不能静默：界面会显示"暂无目标"，用户会去重配（实际是加载失败）
      reportError('加载上传目标失败', error)
    }
  }

  /**
   * 切换当前上传目标并**持久化**。
   *
   * 只提交这一个字段（`patchOwned` 会在写锁内合并），避免整份配置读改写；
   * 持久化后重启仍是同一目标 —— 否则默认回落首个目标，存在"向错误目标上传"的风险。
   */
  async function selectTarget(id: string) {
    currentTargetId.value = id
    try {
      await window.deployApi.saveConfig({ currentTargetId: id })
    } catch {
      // 持久化失败不阻断本次选择（内存里已生效），但下一次重启会回落
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
      toastError('请先在顶部工具栏选择上传目标')
      return
    }
    if (!target.mappings || target.mappings.length === 0) {
      toastError('当前目标没有配置目录映射，请先在设置中添加')
      return
    }

    // 立即弹窗 + 计算中状态（文件多时避免点击后长时间无响应）
    const seq = ++previewSeq
    confirmFiles.value = []
    confirmTargetId.value = target.id
    isPreviewing.value = true
    showConfirm.value = true

    try {
      // 由主进程唯一计算：过滤无映射文件 + 递归目录 + 解析远端路径
      const tasks = await window.deployApi.previewDeployFiles(
        files,
        projectRoot,
        JSON.parse(JSON.stringify(target))
      )

      if (seq !== previewSeq) return // 已有更新的请求：丢弃本次结果

      confirmFiles.value = (tasks || []).map((t: any) => ({
        localPath: t.localPath,
        remotePath: t.remotePath,
        relativePath: t.relativePath,
        size: t.size || 0
      }))
    } catch (e) {
      if (seq !== previewSeq) return // 过期请求的失败不干扰新请求
      // 计算失败：关闭弹窗并向上抛出（调用方统一 toast）
      showConfirm.value = false
      confirmFiles.value = []
      throw e
    } finally {
      // 仅最新请求结束时才清除“计算中”状态
      if (seq === previewSeq) isPreviewing.value = false
    }
  }

  /**
   * 取消确认
   */
  function cancelDeploy() {
    previewSeq++ // 使进行中的预览失效，避免取消后旧结果写回
    showConfirm.value = false
    confirmFiles.value = []
  }

  /**
   * 取消进行中的上传
   */
  async function cancelUpload() {
    try {
      await window.deployApi.cancelDeploy()
    } catch (error) {
      reportError('取消上传失败', error)
    }
    isUploading.value = false
  }

  /**
   * 清空上传日志
   */
  function clearLogs() {
    deployLogs.value = []
  }

  /**
   * 追加一条上传日志并收敛条数（与主进程一致，长会话不无限增长）。
   * 同一 taskId 去重：桌面自身发起的上传已由 executeDeploy 写入。
   */
  function pushLog(entry: DeployLogEntry) {
    if (deployLogs.value.some((log) => log.taskId === entry.taskId)) return
    deployLogs.value.unshift(entry)
    if (deployLogs.value.length > MAX_DEPLOY_LOGS) deployLogs.value.length = MAX_DEPLOY_LOGS
  }

  /** 服务端推送的上传日志（CLI / MCP 触发） */
  function appendLogEntry(entry: DeployLogEntry) {
    pushLog(entry)
  }

  /** 订阅主进程推送（仅内存，不持久化；卸载由应用生命周期决定） */
  function listenServerDeployLogs() {
    window.deployApi.onDeployLogEntry((entry) => appendLogEntry(entry))
  }

  /**
   * 上传进度监听（**只注册一次**）。
   *
   * 此前每次 executeDeploy 都注册一个回调且从不注销：长会话里监听器持续累积
   * （MaxListenersExceededWarning），每次进度回调都会执行所有历史闭包。
   */
  function listenDeployProgress() {
    // 只管桌面自己的上传进度：队列任务的进度不跨进程广播（状态栏已是队列口径，
    // 任务详情走 GET /tasks/:id，避免两类进度共用一条通道相互覆盖）。
    window.deployApi.onDeployProgress((data) => {
      uploadProgress.value = data
    })
  }

  /**
   * 步骤2: 确认后执行上传
   */
  async function executeDeploy(projectRoot: string) {
    if (isPreviewing.value) return // 预览计算未完成：忽略，防止上传空/过期列表
    const target = targets.value.find(t => t.id === confirmTargetId.value)
    if (!target) throw new Error('未找到上传目标')

    showConfirm.value = false
    isUploading.value = true
    uploadProgress.value = { current: 0, total: 0, file: '' }

    try {
      // 直接用弹窗展示的任务列表（与预览一致）
      const tasks = confirmFiles.value
        .filter(f => f.remotePath !== null)
        .map(f => ({ localPath: f.localPath, remotePath: f.remotePath!, relativePath: f.relativePath, size: f.size }))

      if (tasks.length === 0) {
        toastError('没有可上传的文件（所有文件无匹配的目录映射）')
        return
      }

      // 带上项目根：主进程会把结果广播给其他窗口的日志面板（按 taskId 去重，本窗口不会重复）
      const result = await window.deployApi.deployFiles(
        tasks,
        JSON.parse(JSON.stringify(target)),
        projectStore.projectPath ?? undefined
      )
      pushLog({
        ...result,
        origin: 'desktop',
        ...(projectStore.projectPath ? { projectRoot: projectStore.projectPath } : {})
      })
      lastDeployTime.value = new Date(result.timestamp).toLocaleTimeString()
      if (result.cancelled) {
        toastError(`上传已取消（已完成 ${result.succeeded} 个文件）`)
      } else if (result.failed > 0) {
        // 含失败文件不得用绿色成功提示上报（INV-9：失败不能伪装成成功）
        toastError(`上传部分失败: ${result.succeeded} 成功, ${result.failed} 失败`)
      } else {
        toastSuccess(`上传完成: ${result.succeeded} 成功`)
      }
      return result
    } catch (err: any) {
      toastError('上传失败: ' + (err?.message || String(err)))
    } finally {
      isUploading.value = false
      confirmFiles.value = []
    }
  }

  return {
    listenDeployProgress,
    targets,
    currentTargetId,
    selectTarget,
    currentTarget,
    currentMappings,
    lastDeployTime,
    deployLogs,
    isUploading,
    uploadProgress,
    showConfirm,
    isPreviewing,
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
    appendLogEntry,
    listenServerDeployLogs,
    executeDeploy
  }
})
