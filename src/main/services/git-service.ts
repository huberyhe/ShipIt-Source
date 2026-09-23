import simpleGit, { SimpleGit, StatusResult } from 'simple-git'
import { join } from 'path'
import type { GitChangeInfo, GitCommitInfo, GitStatusView, GitBranchInfo } from '../../shared/types'
import { parseBranches } from './branch-parse'

export type { GitChangeInfo, GitCommitInfo, GitStatusView, GitBranchInfo }

export class GitService {
  private gitCache: Map<string, SimpleGit> = new Map()

  private getGit(dir: string): SimpleGit {
    if (!this.gitCache.has(dir)) {
      this.gitCache.set(dir, simpleGit(dir))
    }
    return this.gitCache.get(dir)!
  }

  async isGitRepo(dir: string): Promise<boolean> {
    try {
      await this.getGit(dir).raw('rev-parse', '--git-dir')
      return true
    } catch {
      return false
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
      const git = this.getGit(dir)
      const status = await git.status()
      const branchInfo = await git.branch()

      const changes: GitChangeInfo[] = []

      for (const file of status.files) {
        const changeInfo = this.classifyChange(file, status)
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
    try {
      const git = this.getGit(dir)
      const result = await git.raw(['show', '--name-status', '--format=', hash])
      return result.trim().split('\n').filter(l => l.trim()).map(line => {
        const parts = line.split('\t')
        return { status: parts[0] || '?', path: parts[1] || line }
      })
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
