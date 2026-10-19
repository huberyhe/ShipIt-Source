import simpleGit, { SimpleGit, StatusResult } from 'simple-git'
import { join } from 'path'
import { toSlashes } from '../../shared/paths'
import { isSafeGitRev } from '../../shared/git-rev'
import type { GitChangeInfo, GitCommitInfo, GitStatusView, GitBranchInfo } from '../../shared/types'
import { parseBranches } from './branch-parse'

export type { GitChangeInfo, GitCommitInfo, GitStatusView, GitBranchInfo }

/**
 * git 不可用（未安装 / dubious ownership / 超时等），**区别于"目录不是仓库"**。
 *
 * 前者应报环境类错误（`BACKEND_UNAVAILABLE`），后者才是 `NOT_A_REPO`；
 * 此前两者都被压成 `false`，把"git 执行失败"报成"不是仓库"，把排障引向错误方向。
 */
export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitUnavailableError'
  }
}

/** 缓存上限：多项目 + 反复开关的场景下避免无限增长（超限时按插入顺序淘汰最旧一项） */
const GIT_CACHE_LIMIT = 32

export class GitService {
  private gitCache: Map<string, SimpleGit> = new Map()

  private getGit(dir: string, secondary = false): SimpleGit {
    const key = secondary ? `${dir}\u0000secondary` : dir
    const hit = this.gitCache.get(key)
    if (hit) {
      // LRU：命中即移到末尾（Map 保序），淘汰时丢最旧的
      this.gitCache.delete(key)
      this.gitCache.set(key, hit)
      return hit
    }
    const created = simpleGit(dir)
    this.gitCache.set(key, created)
    if (this.gitCache.size > GIT_CACHE_LIMIT) {
      const oldest = this.gitCache.keys().next().value
      if (oldest !== undefined) this.gitCache.delete(oldest)
    }
    return created
  }

  /**
   * 释放某个目录的缓存与派生缓存（项目窗口关闭时调用，避免长会话无限增长）。
   * 同时清掉 prefixCache，避免目录被移动/重建后拿到陈旧前缀。
   */
  dispose(dir: string): void {
    this.gitCache.delete(dir)
    this.gitCache.delete(`${dir}\u0000secondary`)
    this.prefixCache.delete(dir)
  }

  async isGitRepo(dir: string): Promise<boolean> {
    try {
      await this.getGit(dir).raw('rev-parse', '--git-dir')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 只有"确实不是仓库"才回答 false；其余（git 缺失 / 权限 / 超时）如实上抛，
      // 让调用方报环境类错误而不是 NOT_A_REPO。
      if (/not a git repository|does not exist|are you sure/i.test(message)) return false
      throw new GitUnavailableError(message)
    }
  }

  async getBranches(dir: string): Promise<GitBranchInfo[]> {
    try {
      const git = this.getGit(dir)
      // 按分支最近一次提交时间倒序（与提交者列表口径一致：最近有提交的分支在前）
      // 解析逻辑见 branch-parse.ts（纯函数，带单测）
      const result = await git.raw([
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes'
      ])
      return parseBranches(result)
    } catch {
      return []
    }
  }
  async getAuthors(dir: string): Promise<string[]> {
    try {
      const git = this.getGit(dir)
      const result = await git.raw('log', '--all', '--format=%an')
      const authors = result
        .split('\n')
        .map(a => a.trim())
        .filter(a => a.length > 0)
      // git log 已按提交时间倒序输出：Set 去重后保持首次出现顺序，即“最近提交的作者在前”
      return [...new Set(authors)]
    } catch {
      return []
    }
  }

  async getStatusView(dir: string): Promise<GitStatusView> {
    try {
      // status 与 branch 相互独立：simple-git 会在同一实例内串行排队，
      // 因此并行时各用一个实例，避免多等一次 git 进程启动（Windows 下单次启动约数百毫秒）。
      const [status, branchInfo] = await Promise.all([this.getGit(dir).status(), this.getGit(dir, true).branch()])
      // git 输出的 paths 以**仓库根**为基准（--porcelain 既不受 status.relativePaths 影响，status 也没有 --relative）。
      // 不换算的话，「项目根是仓库子目录」时下游会把它们当项目相对路径拼接 → 拼出不存在的路径，
      // 真实变更被全部丢弃（plan 返回空、deploy 报没有可上传文件）。
      const prefix = await this.projectPrefix(dir)

      const changes: GitChangeInfo[] = []

      for (const file of status.files) {
        const rel = this.toProjectRelative(file.path, prefix)
        if (rel === null) continue // 项目目录之外的变更与上传无关
        const changeInfo = this.classifyChange({ ...file, path: rel }, status)
        if (changeInfo) {
          changes.push(changeInfo)
        }
      }

      return {
        hasGit: true,
        branch: branchInfo.current,
        changes,
        ahead: status.ahead,
        behind: status.behind
      }
    } catch {
      return {
        hasGit: false,
        changes: [],
        ahead: 0,
        behind: 0
      }
    }
  }

  async getLogView(
    dir: string,
    options?: { branch?: string; author?: string; maxCount?: number }
  ): Promise<GitCommitInfo[]> {
    // 校验放在 try 之外：非法参数必须**上抛**给调用方（HTTP 层转 USAGE），
    // 不能被下面"读取失败即返回空列表"的 catch 吞掉 —— 否则注入尝试会伪装成"没有提交"。
    if (options?.branch && options.branch !== '__all__' && !isSafeGitRev(options.branch)) {
      throw new Error(`非法的分支名：${options.branch}`)
    }
    if (options?.author && /[\r\n\u0000]/.test(options.author)) {
      throw new Error('非法的提交者筛选值')
    }
    try {
      const git = this.getGit(dir)
      // 使用自定义格式: hash|author|email|date|message
      let args = ['--format=%H|%an|%ae|%ai|%s', '--max-count=' + (options?.maxCount ?? 50)]
      if (options?.author) args.push('--author=' + options.author)
      // 分支筛选三态：'__all__' = 全部分支；具体分支名 = 该分支；未指定 = 当前分支（HEAD）
      if (options?.branch === '__all__') args.push('--all')
      else if (options?.branch) args.push(options.branch)

      const result = await git.raw(['log', ...args])
      const lines = result.trim().split('\n').filter(l => l.length > 0)

      return lines.map(line => {
        const parts = line.split('|')
        return {
          hash: parts[0]?.slice(0, 7) || '',
          author: parts[1] || '',
          email: parts[2] || '',
          date: parts[3] || '',
          message: parts[4] || ''
        }
      })
    } catch {
      return []
    }
  }

  async getCommitFiles(dir: string, hash: string): Promise<Array<{ path: string; status: string }>> {
    // 同样裸拼进 argv（`git show <hash>`）：非法值必须上抛，不能退化成"没有文件"
    if (!isSafeGitRev(hash)) throw new Error(`非法的提交 ID：${hash}`)
    try {
      const git = this.getGit(dir)
      // --relative：以 cwd（项目根）为基准输出路径；同时天然只列出项目目录内的文件
      const result = await git.raw(['show', '--name-status', '--format=', '--relative', hash])
      return result.trim().split('\n').filter(l => l.trim()).map(line => {
        const parts = line.split('\t')
        const path = toSlashes(parts[1] || line)
        return { status: parts[0] || '?', path }
      }).filter(entry => entry.path.length > 0 && !entry.path.startsWith('..'))
    } catch {
      return []
    }
  }

  async getFileDiff(dir: string, filePath: string): Promise<string> {
    try {
      const git = this.getGit(dir)
      // 先用 git diff HEAD 检出所有未提交差异
      const result = await git.raw(['diff', 'HEAD', '--', filePath])
      if (result.trim()) return result

      // 如果 diff 为空，可能是未跟踪的新文件，直接读取内容展示
      try {
        const { promises: fsp } = await import('fs')
        const fullPath = join(dir, filePath)
        const content = await fsp.readFile(fullPath, 'utf-8')
        // 格式化为 diff 风格的输出（全部新增）
        const lines = content.split('\n')
        const formatted = [
          `diff --git a/${filePath} b/${filePath}`,
          `new file mode 100644`,
          `--- /dev/null`,
          `+++ b/${filePath}`,
          ...lines.map(l => `+${l}`)
        ].join('\n')
        return formatted
      } catch {
        return ''
      }
    } catch {
      return ''
    }
  }

  /** 项目目录相对仓库根的前缀缓存（避免每次状态查询都多跑一次 git） */
  private prefixCache = new Map<string, string | null>()

  /**
   * `git rev-parse --show-prefix`：git 自己给出「cwd 相对仓库根」的前缀（如 `app/`，cwd 即仓库根时为 ''）。
   *
   * 之所以不用 `--show-toplevel` + 本地路径比较：Windows 下 mkdtemp/短名（`HEYUNC~1`）与 git 输出的
   * 长名（`heyuncheng`）不一致，字符串比较会整体失配，把项目内的文件误判成「项目外」而丢弃。
   */
  private async projectPrefix(dir: string): Promise<string | null> {
    const cached = this.prefixCache.get(dir)
    if (cached !== undefined) return cached
    let prefix: string | null = null
    try {
      prefix = (await this.getGit(dir, true).raw(['rev-parse', '--show-prefix'])).trim()
    } catch {
      prefix = null
    }
    this.prefixCache.set(dir, prefix)
    return prefix
  }

  /**
   * git 输出的（仓库根相对）路径 → 项目根相对路径。
   * 项目目录之外返回 null（调用方丢弃）；拿不到前缀时保留原样（不猜）。
   */
  private toProjectRelative(gitPath: string, prefix: string | null): string | null {
    const slashed = toSlashes(gitPath)
    if (prefix === null) return slashed
    if (prefix === '') return slashed
    const head = prefix.endsWith('/') ? prefix : `${prefix}/`
    if (!slashed.startsWith(head)) return null
    const rel = slashed.slice(head.length)
    return rel.length > 0 ? rel : null
  }

  private classifyChange(file: any, _status: StatusResult): GitChangeInfo | null {
    const index = file.index || ' '
    const working = file.working_dir || ' '

    let fileStatus: GitChangeInfo['status'] | null = null

    // 暂存区有变更
    if (index !== ' ') {
      if (index === 'A') fileStatus = 'added'
      else if (index === 'D') fileStatus = 'deleted'
      else if (index === 'R') fileStatus = 'renamed'
      else fileStatus = 'modified'
    }

    // 工作区有变更
    if (working !== ' ') {
      if (working === 'A' || working === '?') fileStatus = 'untracked'
      else if (working === 'D') fileStatus = fileStatus || 'deleted'
      else fileStatus = fileStatus || 'modified'
    }

    if (!fileStatus) return null

    return {
      path: file.path,
      relativePath: file.path,
      status: fileStatus,
      oldPath: undefined
    }
  }
}
