import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { GitChangeInfo, GitCommitInfo } from '../../shared/types'

export const useGitStore = defineStore('git', () => {
  const hasGit = ref(false)
  const branch = ref<string | undefined>()
  const changes = ref<GitChangeInfo[]>([])
  const ahead = ref(0)
  const behind = ref(0)
  const commits = ref<GitCommitInfo[]>([])
  const branches = ref<string[]>([])
  const authors = ref<string[]>([])
  const isLoading = ref(false)
  /** 正在分析 Git 状态（进入项目时的耗时操作） */
  const isAnalyzing = ref(false)

  // 筛选状态
  const logBranchFilter = ref<string>('')
  const logAuthorFilter = ref<string>('')

  // 并发保护：自动刷新与手动刷新不重叠
  let statusRunning = false
  let logRunning = false

  /**
   * 加载 Git 状态
   * @param silent 静默刷新（自动轮询）：不触发状态栏"分析中"提示
   */
  async function loadGitStatus(dir: string, silent = false) {
    if (statusRunning) return
    statusRunning = true
    if (!silent) isAnalyzing.value = true
    try {
      hasGit.value = await window.deployApi.checkGitRepo(dir)
      if (!hasGit.value) return

      const [statusView, branchList, authorList] = await Promise.all([
        window.deployApi.getGitStatus(dir),
        window.deployApi.getGitBranches(dir),
        window.deployApi.getGitAuthors(dir)
      ])

      branch.value = statusView.branch
      changes.value = statusView.changes
      ahead.value = statusView.ahead
      behind.value = statusView.behind
      branches.value = branchList
      authors.value = authorList
    } catch {
      // ignore
    } finally {
      statusRunning = false
      if (!silent) isAnalyzing.value = false
    }
  }

  /**
   * 加载提交历史
   * @param silent 静默刷新：不触发列表"加载中"状态
   */
  async function loadGitLog(dir: string, maxCount: number = 50, silent = false) {
    if (logRunning) return
    logRunning = true
    if (!silent) isLoading.value = true
    try {
      commits.value = await window.deployApi.getGitLog(dir, {
        branch: logBranchFilter.value || undefined,
        author: logAuthorFilter.value || undefined,
        maxCount
      })
    } finally {
      logRunning = false
      if (!silent) isLoading.value = false
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
    loadGitStatus,
    loadGitLog,
    getFileDiff
  }
})
