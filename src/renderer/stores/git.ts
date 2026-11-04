import { defineStore } from 'pinia'
import { reportError, warnOnly } from '../utils/report-error'
import { ref } from 'vue'
import type { GitBranchInfo, GitChangeInfo, GitCommitFile, GitCommitInfo, GitRepoStatus } from '../../shared/types'

/** 文件差异的读取结果：失败是**一个状态**，不是一个空字符串 */
export type FileDiffResult =
  | { ok: true; diff: string }
  | { ok: false; message: string }

export const useGitStore = defineStore('git', () => {
  const hasGit = ref(false)
  const branch = ref<string | undefined>()
  const changes = ref<GitChangeInfo[]>([])
  /** 按仓库分组的明细（多根项目：项目下可能并列多个 git 仓库） */
  const repos = ref<GitRepoStatus[]>([])
  /** 项目内仓库数超过上限、多余仓库没有展示（主进程标记，界面必须让用户看见） */
  const reposTruncated = ref(false)
/** 仓库扫描的目录预算耗尽：可能还有更深的仓库未被发现 */
const reposScanTruncated = ref(false)
  const ahead = ref(0)
  const behind = ref(0)
  const commits = ref<GitCommitInfo[]>([])
  /**
   * 日志是否已**全部取完**（本次请求返回的条数少于请求上限 = 服务端再没有更多）。
   *
   * 用途：视图据此隐藏「加载更多」——否则取完之后按钮仍在，点了也不会变化，
   * 用户会以为"日志还有更多"而反复点击。
   */
  const logExhausted = ref(false)
  const branches = ref<GitBranchInfo[]>([])
  const authors = ref<string[]>([])
  const isLoading = ref(false)
  /** 正在分析 Git 状态（进入项目时的耗时操作） */
  const isAnalyzing = ref(false)

  // 筛选状态
    /** 筛选被重置的信号（每次 resetLogFilters 自增）：
   *  挂载中的日志视图据此清空本地选择并重新加载，不依赖 projectPath 是否发生“变化” */
  const logFilterResetToken = ref(0)

  /**
   * 刷新筛选项（分支 / 提交者）
   * @param includeAuthors 是否同时刷新提交者（需全量扫描历史，开销大，轮询/聚焦时跳过）
   *
   * 并发策略：同一项目重复请求合并（in-flight 去重）；只应用最新一次请求的结果，
   * 避免切换项目时新请求被丢弃、或旧项目的响应覆盖新项目数据。
   */
  async function loadGitRefs(dir: string, includeAuthors = true): Promise<void> {
    if (refsInFlight.has(dir)) return
    refsInFlight.add(dir)
    const seq = ++refsSeq
    try {
      const [branchList, authorList] = await Promise.all([
        window.deployApi.getGitBranches(dir),
        includeAuthors ? window.deployApi.getGitAuthors(dir) : Promise.resolve(null)
      ])
      if (seq !== refsSeq) return // 已有更新的请求，丢弃本次响应
      branches.value = branchList
      if (authorList) authors.value = authorList
    } catch (error) {
      reportError('加载分支/提交者失败', error)
    } finally {
      refsInFlight.delete(dir)
    }
  }

  /** 重置日志筛选：分支/提交者不跨项目通用，切换/重开项目时必须清空 */
  function resetLogFilters() {
    // 只做"通知视图清空筛选"：真正的筛选值归 uiStore（单一来源），由视图据此重置
    logFilterResetToken.value++
  }

  // 并发保护：in-flight 按目录去重 + 请求序号（只应用最新一次结果）
  const statusInFlight = new Set<string>()
  const refsInFlight = new Set<string>()
  const logInFlight = new Set<string>()
  let statusSeq = 0
  let refsSeq = 0
  let logSeq = 0
  // 在途的非静默请求计数（>0 时界面显示“分析中 / 加载中”）
  let statusPending = 0
  let logPending = 0

  /**
   * 加载 Git 状态
   * @param silent 静默刷新（自动轮询）：不触发状态栏"分析中"提示
   */
  async function loadGitStatus(dir: string, silent = false) {
    if (statusInFlight.has(dir)) return
    statusInFlight.add(dir)
    const seq = ++statusSeq
    if (!silent) { statusPending++; isAnalyzing.value = true }
    try {
      const has = await window.deployApi.checkGitRepo(dir)
      if (seq !== statusSeq) return
      hasGit.value = has
      if (!has) {
        repos.value = []
        reposTruncated.value = false
  reposScanTruncated.value = false
        return
      }

      const [statusView] = await Promise.all([
        window.deployApi.getGitStatus(dir),
        loadGitRefs(dir) // 同一次刷新里一并更新分支/提交者筛选项
      ])
      if (seq !== statusSeq) return

      branch.value = statusView.branch
      changes.value = statusView.changes
      ahead.value = statusView.ahead
      behind.value = statusView.behind
      repos.value = Array.isArray(statusView.repos) ? statusView.repos : []
      reposTruncated.value = statusView.truncated === true
  reposScanTruncated.value = statusView.scanTruncated === true
    } catch (error) {
      reportError('加载 Git 状态失败', error)
    } finally {
      statusInFlight.delete(dir)
      if (!silent) {
        statusPending = Math.max(0, statusPending - 1)
        if (statusPending === 0) isAnalyzing.value = false
      }
    }
  }

  /**
   * 加载提交历史
   * @param silent 静默刷新：不触发列表"加载中"状态
   */
  async function loadGitLog(
    dir: string,
    opts: { branch?: string; author?: string; maxCount?: number; silent?: boolean } = {}
  ) {
    const maxCount = opts.maxCount ?? 50
    const silent = opts.silent ?? false
    if (logInFlight.has(dir)) return
    logInFlight.add(dir)
    const seq = ++logSeq
    if (!silent) { logPending++; isLoading.value = true }
    try {
      // 筛选值由调用方（视图）显式传入：store 不再持有第二份筛选状态，
      // 避免"下拉显示"与"实际查询"各持一份而漂移（此前是 4 份副本 + 3 处手工同步）。
      const list = await window.deployApi.getGitLog(dir, {
        branch: opts.branch || undefined,
        author: opts.author || undefined,
        maxCount
      })
      if (seq !== logSeq) return // 已有更新的请求，丢弃本次响应
      commits.value = list
      logExhausted.value = list.length < maxCount
    } catch (error) {
      // 失败必须可见；**保留已有列表**（「加载更多」失败时清空会被读成「没有提交」）
      if (seq === logSeq) reportError('加载提交历史失败', error)
    } finally {
      logInFlight.delete(dir)
      if (!silent) {
        logPending = Math.max(0, logPending - 1)
        if (logPending === 0) isLoading.value = false
      }
    }
  }

  /**
   * 读文件差异。
   *
   * 结果必须可区分「没有变更」与「读取失败」：曾经 catch 后返回 ''，空串又被界面
   * 渲染成「文件无变更」—— 真实失败被读成了「这文件没改动」，用户与排查者都会被误导。
   */
  async function getFileDiff(dir: string, filePath: string): Promise<FileDiffResult> {
    try {
      const diff = await window.deployApi.getGitDiff(dir, filePath)
      return { ok: true, diff: typeof diff === 'string' ? diff : '' }
    } catch (error) {
      // 失败由调用方就地呈现（失败态 + 重试）；这里只留痕，不再额外弹 toast 避免双重提示
      warnOnly('加载文件差异失败', error)
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Git 日志已展开提交的文件列表缓存（hash → 文件）。
   * 放 store 而不是组件：视图切走会卸载，局部 ref 会丢，切回来就只剾“展开态”、
   * 还得再异步拉一次文件 → 看起来就是在动态展开。缓存与之同存才能首帧即展开。
   */
  const commitFiles = ref<Record<string, GitCommitFile[]>>({})

  function setCommitFiles(next: Record<string, GitCommitFile[]>): void {
    commitFiles.value = next
  }

  function clearCommitFiles(): void {
    commitFiles.value = {}
  }

  return {
    hasGit,
    branch,
    changes,
    repos,
    reposTruncated,
  reposScanTruncated,
    ahead,
    behind,
    commits,
    logExhausted,
    branches,
    authors,
    isLoading,
    isAnalyzing,
    logFilterResetToken,
    loadGitStatus,
    loadGitLog,
    loadGitRefs,
    resetLogFilters,
    commitFiles,
    setCommitFiles,
    clearCommitFiles,
    getFileDiff
  }
})
