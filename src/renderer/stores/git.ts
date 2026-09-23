import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { GitBranchInfo, GitChangeInfo, GitCommitInfo } from '../../shared/types'

export const useGitStore = defineStore('git', () => {
  const hasGit = ref(false)
  const branch = ref<string | undefined>()
  const changes = ref<GitChangeInfo[]>([])
  const ahead = ref(0)
  const behind = ref(0)
  const commits = ref<GitCommitInfo[]>([])
  const branches = ref<GitBranchInfo[]>([])
  const authors = ref<string[]>([])
  const isLoading = ref(false)
  /** 正在分析 Git 状态（进入项目时的耗时操作） */
  const isAnalyzing = ref(false)

  // 筛选状态
  const logBranchFilter = ref<string>('')
  const logAuthorFilter = ref<string>('')
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
    } catch {
      // ignore
    } finally {
      refsInFlight.delete(dir)
    }
  }

  /** 重置日志筛选：分支/提交者不跨项目通用，切换/重开项目时必须清空 */
  function resetLogFilters() {
    logBranchFilter.value = ''
    logAuthorFilter.value = ''
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
      if (!has) return

      const [statusView] = await Promise.all([
        window.deployApi.getGitStatus(dir),
        loadGitRefs(dir) // 同一次刷新里一并更新分支/提交者筛选项
      ])
      if (seq !== statusSeq) return

      branch.value = statusView.branch
      changes.value = statusView.changes
      ahead.value = statusView.ahead
      behind.value = statusView.behind
    } catch {
      // ignore
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
  async function loadGitLog(dir: string, maxCount: number = 50, silent = false) {
    if (logInFlight.has(dir)) return
    logInFlight.add(dir)
    const seq = ++logSeq
    if (!silent) { logPending++; isLoading.value = true }
    try {
      const list = await window.deployApi.getGitLog(dir, {
        branch: logBranchFilter.value || undefined,
        author: logAuthorFilter.value || undefined,
        maxCount
      })
      if (seq !== logSeq) return // 已有更新的请求，丢弃本次响应
      commits.value = list
    } finally {
      logInFlight.delete(dir)
      if (!silent) {
        logPending = Math.max(0, logPending - 1)
        if (logPending === 0) isLoading.value = false
      }
    }
  }

  async function getFileDiff(dir: string, filePath: string): Promise<string> {
    try {
      return await window.deployApi.getGitDiff(dir, filePath)
    } catch {
      return ''
    }
  }

  return {
    hasGit,
    branch,
    changes,
    ahead,
    behind,
    commits,
    branches,
    authors,
    isLoading,
    isAnalyzing,
    logBranchFilter,
    logAuthorFilter,
    logFilterResetToken,
    loadGitStatus,
    loadGitLog,
    loadGitRefs,
    resetLogFilters,
    getFileDiff
  }
})
