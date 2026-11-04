import { toastError, toastSuccess } from '../utils/toast'
import { defineStore } from 'pinia'
import { reportError } from '../utils/report-error'
import { ref, computed } from 'vue'
import type { DeployTarget, DeployResult, PlanSkip } from '../../shared/types'
import { useProjectStore } from './project'
import type { DeployLogEntry } from '../types'

/** 上传日志保留上限（与主进程 MAX_TASK_RECORDS 一致） */
const MAX_DEPLOY_LOGS = 50

/** 上传确认弹窗展示的条目：**只含真正会上传的文件**（跳过的走 `UploadPreviewSkip`） */
export interface UploadPreviewItem {
  localPath: string
  remotePath: string
  relativePath: string
  size: number
}

/**
 * 预览时被跳过的条目（不进入上传集合）。
 *
 * `reason` 直接来自主进程（与 `PlanSkip` 同源，与上传筛选用同一趟遍历得出），
 * 渲染层只负责展示 —— 不再按「所选文件 − 可上传文件」求差集猜原因。
 * 仅当旧版/缺字段的预览返回没有 reason 时为 null（UI 用中性文案，仍不编造）。
 */
export interface UploadPreviewSkip {
  relativePath: string
  reason: PlanSkip['reason'] | null
}

/** 跳过原因的人话文案：原因未知时给中性描述，不假报成「无映射」 */
export function skipReasonText(reason: UploadPreviewSkip['reason']): string {
  if (reason === 'missing') return '文件不存在（已删除或未提交）'
  if (reason === 'no-mapping') return '未匹配目录映射'
  if (reason === 'outside-project') return '不在项目目录内'
  return '原因未知'
}

/**
 * 跳过原因汇总（弹窗顶栏 chip / 0 文件说明 / 0 文件 toast 共用一份口径）。
 * 只统计确实出现过的原因，避免把「文件已删除」误报成「无映射」。
 */
export function summarizeSkips(items: UploadPreviewSkip[]): string {
  const noMapping = items.filter((i) => i.reason === 'no-mapping').length
  const missing = items.filter((i) => i.reason === 'missing').length
  const outside = items.filter((i) => i.reason === 'outside-project').length
  const unknown = items.length - noMapping - missing - outside
  const parts: string[] = []
  if (noMapping > 0) parts.push(`${noMapping} 个未匹配目录映射`)
  if (missing > 0) parts.push(`${missing} 个文件不存在（已删除或未提交）`)
  if (outside > 0) parts.push(`${outside} 个不在项目目录内`)
  if (unknown > 0) parts.push(`${unknown} 个原因未知`)
  return parts.join('，')
}

/** 单个预览条目：缺关键字段就丢弃（老版本/截断数据不能让弹窗崩掉） */
function toPreviewItem(raw: unknown): UploadPreviewItem | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.localPath !== 'string' || typeof item.remotePath !== 'string') return null
  if (typeof item.relativePath !== 'string') return null
  return {
    localPath: item.localPath,
    remotePath: item.remotePath,
    relativePath: item.relativePath,
    size: typeof item.size === 'number' ? item.size : 0
  }
}

function toPreviewSkip(raw: unknown): UploadPreviewSkip | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.relativePath !== 'string') return null
  const reason = item.reason === 'missing' || item.reason === 'no-mapping' ? item.reason : null
  return { relativePath: item.relativePath, reason }
}

/**
 * 归一化 `deploy:preview` 的返回。
 *
 * 正常形态是 `UploadPreview`（tasks + skipped）；旧版主进程只回 `UploadTask[]`，
 * 此时按「只上传这些文件」处理，跳过的猜不出来就不报（不再用差集编一个原因）。
 */
function normalizePreview(raw: unknown): { tasks: UploadPreviewItem[]; skipped: UploadPreviewSkip[] } {
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  const rawTasks = Array.isArray(raw) ? raw : payload && Array.isArray(payload.tasks) ? payload.tasks : []
  const rawSkipped = payload && Array.isArray(payload.skipped) ? payload.skipped : []
  return {
    tasks: (rawTasks as unknown[]).map(toPreviewItem).filter((item): item is UploadPreviewItem => item !== null),
    skipped: (rawSkipped as unknown[]).map(toPreviewSkip).filter((item): item is UploadPreviewSkip => item !== null)
  }
}

/** 本次上传的目标摘要（进度卡展示「发到哪」，不持有凭据） */
export interface UploadTargetSummary {
  name: string
  protocol: string
  host: string
  port: number
  mappingCount: number
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
  /** 被跳过的条目：数量与列表必须可见，不能因为「不参与上传」就从界面消失 */
  const confirmSkipped = ref<UploadPreviewSkip[]>([])
  const confirmTargetId = ref<string>('')
  /** 正在上传的目标（进度卡据此显示 项目 → 目标（协议 + 主机）） */
  const uploadTarget = ref<UploadTargetSummary | null>(null)

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

    /** 手动排序：菜单/下拉的顺序 = 持久化数组的顺序，所以直接落盘 */
    async function reorderTargets(ids: string[]) {
    await window.deployApi.reorderTargets(ids)
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
    confirmSkipped.value = []
    confirmTargetId.value = target.id
    isPreviewing.value = true
    showConfirm.value = true

    try {
      // 由主进程唯一计算：过滤无映射文件 + 递归目录 + 解析远端路径，并给出跳过条目的**真实原因**
      const preview = normalizePreview(
        await window.deployApi.previewDeployFiles(files, projectRoot, JSON.parse(JSON.stringify(target)))
      )

      if (seq !== previewSeq) return // 已有更新的请求：丢弃本次结果

      // 弹窗的数量必须等于实际上传数量：这里只放真正会上传的文件
      confirmFiles.value = preview.tasks
      // 跳过项同样由主进程给出（含 relativePath 与真实 reason），渲染层不再做差集猜测。
      // 少了这一部分，界面就会出现「选了 5 个只传 2 个」而无法解释的局面；
      // 全部文件都被跳过时**不关弹窗**：改由弹窗说明原因（关弹窗 + toast 会留下「点了没反应」的印象）。
      confirmSkipped.value = preview.skipped
    } catch (e) {
      if (seq !== previewSeq) return // 过期请求的失败不干扰新请求
      // 计算失败：关闭弹窗并向上抛出（调用方统一 toast）
      showConfirm.value = false
      confirmFiles.value = []
      confirmSkipped.value = []
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
    confirmSkipped.value = []
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
    // 进度卡要说清「发到哪」：项目名/目标名/协议+主机/映射条数（不含任何凭据）
    uploadTarget.value = {
      name: target.name,
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      mappingCount: target.mappings?.length ?? 0
    }
    // 总数直接用待传列表长度：连接/握手阶段也能看到「0 / N」，
    // 而不是 0/0 —— 后者看起来像“什么都没开始/卡住了”
    uploadProgress.value = { current: 0, total: confirmFiles.value.length, file: '' }

    try {
      // 直接用弹窗展示的任务列表（与预览一致）
      const tasks = confirmFiles.value
        .map(f => ({ localPath: f.localPath, remotePath: f.remotePath, relativePath: f.relativePath, size: f.size }))

      if (tasks.length === 0) {
        // 原因取自预览（主进程判定）：可能是无映射，也可能是文件已删除，两者处置完全不同
        const detail = summarizeSkips(confirmSkipped.value)
        toastError(detail ? `没有可上传的文件：${detail}` : '没有可上传的文件')
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
        toastError(`${result.succeeded} 个成功，${result.failed} 个失败 → ${target.name}`)
      } else {
        // 结果提示必须能回答「发到哪」：多目标并存时，光看数字无法确认调度的目标
        toastSuccess(`已上传 ${result.succeeded} 个文件 → ${target.name}`)
      }
      return result
    } catch (err: any) {
      toastError('上传失败: ' + (err?.message || String(err)))
    } finally {
      isUploading.value = false
      confirmFiles.value = []
      confirmSkipped.value = []
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
    confirmSkipped,
    confirmTargetId,
    uploadTarget,
    loadTargets,
    addTarget,
    updateTarget,
    removeTarget,
    reorderTargets,
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
