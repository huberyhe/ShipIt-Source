import simpleGit, { SimpleGit, StatusResult } from 'simple-git'
import type { GitCommitFile } from '../../shared/types'
import { promises as fsp, type Dirent } from 'fs'
import { basename, join } from 'path'
import { toSlashes } from '../../shared/paths'
import { isSafeGitRev } from '../../shared/git-rev'
import type { GitChangeInfo, GitCommitInfo, GitStatusView, GitBranchInfo, GitRepoStatus } from '../../shared/types'
import { IGNORE_DIRS } from './ignore-dirs'
import { parseBranches } from './branch-parse'

export type { GitChangeInfo, GitCommitInfo, GitStatusView, GitBranchInfo, GitRepoStatus }

/**
 * 仓库发现时额外跳过的目录：**复用**浏览用的 `IGNORE_DIRS`（node_modules / dist / vendor /
 * .next / build / .idea …），这里只补它没有收录的两个本仓构建产物。
 * 不要另写一份完整清单 —— 两份清单必然会漂移。
 */
const REPO_SCAN_SKIP = new Set([...IGNORE_DIRS, 'dist-electron', 'release'])

/** 单个项目最多展示多少个仓库（超出记 `truncated: true`，不静默丢弃） */
const MAX_REPOS_PER_PROJECT = 12
/**
 * 仓库探测的**目录访问预算**（不是深度上限）。
 *
 * 真实项目会把仓库埋得很深（例：`manage/console/controllers/temp`，深度 4），
 * IDEA 的多根列表里它同样是一个根。固定深度会让这类仓库彻底不可见，
 * 而无限递归又会在大目录树上失控 —— 因此用“最多看多少个目录”来限流，
 * 超出时在返回值里报告 `scanTruncated`，而不是静默当没有。
 */
const REPO_SCAN_MAX_DIRS = 2000
/** 同时读取状态的仓库上限：每个仓库都要起 git 进程，全并行会拖慢整个视图 */
const REPO_STATUS_CONCURRENCY = 4

export interface GitServiceOptions {
  /** 仓库数量上限（默认 12；测试用它验证 truncated） */
  maxRepos?: number
  /** 仓库探测的目录访问预算（默认 2000；测试用它验证 scanTruncated） */
  maxScanDirs?: number
}

/** 单个仓库的读取结果：ahead/behind 只有根仓库对外暴露，先在这里带出来 */
interface RepoReadResult {
  repo: GitRepoStatus
  ahead: number
  behind: number
}

/** 有界并发执行（结果顺序与入参一致） */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/** `inner` 是否在 `outer` 目录下（按路径段比较，`a` 不匹配 `ab`；`''` = 项目根） */
function isUnder(inner: string, outer: string): boolean {
  if (inner === outer) return false
  if (outer === '') return inner !== ''
  return inner.startsWith(`${outer}/`)
}

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

  constructor(private readonly options: GitServiceOptions = {}) {}

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

  /**
   * 项目里是否有仓库（项目根本身，或深度 ≤ 2 的子目录带了 `.git`）。
   *
   * 与 `isGitRepo` 的分工：后者只回答「这个目录是不是仓库」（CLI 判定 `NOT_A_REPO` 的口径，不能放宽）；
   * 多根项目里**项目根本身可以不是仓库**（如 `项目/前端`、`项目/后端` 各自一个），
   * 渲染层要用这个更宽的判定才能把 Git 视图打开。git 不可用时仍如实上抛。
   */
  async hasAnyRepository(dir: string): Promise<boolean> {
    if (await this.isGitRepo(dir)) return true
    return (await this.findSubRepos(dir)).repos.length > 0
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

  /**
   * 项目 → 若干仓库：一个项目目录下可能并列多个 git 仓库（如 `项目/前端`、`项目/后端`），
   * 此前只看项目根那一个，子仓库的变更完全不可见（IDEA 的多根项目观感）。
   *
   * 返回的旧字段（`hasGit` / `branch` / `changes` / `ahead` / `behind`）语义不变：
   * - `changes` = 所有仓库变更的并集（去重）——CLI/MCP 与上传链路依赖它；
   * - `branch` = 根仓库（项目根自己就是仓库时）的分支；
   * - `hasGit` = 至少发现一个仓库。
   */
  async getStatusView(dir: string): Promise<GitStatusView> {
    // 根仓库仍用 rev-parse 判定（不能用 `<dir>/.git`）：项目根常常是仓库的子目录，
    // 只认 `.git` 存在会把这种情况误判成「不是仓库」。
    let rootIsRepo = false
    try {
      rootIsRepo = await this.isGitRepo(dir)
    } catch {
      // git 本身不可用（未安装 / dubious ownership / 超时）：与改动前一致，报「没有可用的 git」，
      // 不能落成「发现了仓库但全都读失败」（那会把环境问题说成仓库问题）。
      return { hasGit: false, changes: [], ahead: 0, behind: 0 }
    }

    const { repos: subRepos, scanTruncated } = await this.findSubRepos(dir)
    const candidates = rootIsRepo ? [dir, ...subRepos] : subRepos
    const maxRepos = this.options.maxRepos ?? MAX_REPOS_PER_PROJECT
    const truncated = candidates.length > maxRepos
    // 根仓库排在首位（展示时它就是「项目本身」），其余按路径字典序（findSubRepos 已排序），
    // 保证截断时分到哪些仓库是稳定的、可预期的。
    const picked = candidates.slice(0, maxRepos)

    // 每个仓库的「项目相对目录」：根仓库为 ''（它覆盖整个项目），内层仓库为项目下的相对路径。
    const relPrefixes = picked.map((repoPath) => this.relativeToProject(dir, repoPath))
    const results = await mapWithConcurrency(picked, REPO_STATUS_CONCURRENCY, (repoPath, index) =>
      this.readRepoStatus(repoPath, relPrefixes[index])
    )

    // 去重规则：内层仓库的文件不得同时算进外层仓库（git 对外层只给一个未跟踪目录条目，
    // 如 `前端/`；不过滤会让同一个文件在两处各出现一次）。
    //
    // 但只有**读取成功**的内层仓库才参与去重：失败的仓库给不出它自己的文件，
    // 若仍按它的前缀把外层那条 `前端/` 丢掉，这棵树就两边都不见了 ——
    // 桌面只看得到仓库上的 error，而 CLI/MCP 走 `changes`，会静默少传一整棵树。
    // 前缀必须归一化（去掉尾斜杠）：`relativeToProject` 可能给出 `frontend/`，
    // 而 git 的未跟踪目录条目是 `frontend`，字符串对不上就会漏过滤。
    const norm = (value: string): string => value.replace(/\/+$/, '')
    const okInnerPrefixes = relPrefixes
      .map((prefix, index) => ({ prefix: norm(prefix), index }))
      .filter((item) => item.prefix !== '' && !results[item.index].repo.error)
      .map((item) => item.prefix)
    const innerDirsOf = (self: string): string[] => okInnerPrefixes.filter((other) => isUnder(other, norm(self)))


    // 先就地清洗每个仓库的 changes（单个仓库视图也要干净），再取并集
    results.forEach((result, index) => {
      const innerDirs = innerDirsOf(relPrefixes[index])
      if (innerDirs.length === 0) return
      result.repo.changes = result.repo.changes.filter((change) => {
        const key = change.relativePath.replace(/\/+$/, '')
        return !innerDirs.some((inner) => key === inner || key.startsWith(`${inner}/`))
      })
    })

    const rootResult = results.find((result) => result.repo.repoPath === dir)
    const changes: GitChangeInfo[] = []
    const seen = new Set<string>()
    for (const result of results) {
      for (const change of result.repo.changes) {
        if (seen.has(change.relativePath)) continue
        seen.add(change.relativePath)
        changes.push(change)
      }
    }

    return {
      hasGit: results.length > 0,
      branch: rootResult?.repo.branch,
      changes,
      ahead: rootResult?.ahead ?? 0,
      behind: rootResult?.behind ?? 0,
      repos: results.map((result) => result.repo),
      ...(truncated ? { truncated: true } : {}),
      ...(scanTruncated ? { scanTruncated: true } : {})
    }
  }

  /**
   * 扫描 `dir` 下的所有子仓库（不设固定深度，按**目录访问预算**限流）。
   *
   * 为什么不用固定深度：真实项目的仓库会埋得很深
   * （如 `manage/console/controllers/temp`），固定 2 层会让它们彻底隐形，
   * 与 IDEA 的多根列表对不上。
   *
   * 成本控制：每层只做**一次 readdir**（`.git` 直接作为目录项就看到了，不再逐个 stat），
   * 跳过 `REPO_SCAN_SKIP`（复用 `IGNORE_DIRS`）、点目录与符号链接；
   * 预算耗尽时置 `scanTruncated`，由调用方告知用户“没扫完”而不是当作“没仓库”。
   */
  private async findSubRepos(dir: string): Promise<{ repos: string[]; scanTruncated: boolean }> {
    const found: string[] = []
    const budget = this.options.maxScanDirs ?? REPO_SCAN_MAX_DIRS
    let visited = 0
    let scanTruncated = false

    const walk = async (current: string, isRoot: boolean): Promise<void> => {
      if (scanTruncated) return
      if (visited >= budget) {
        scanTruncated = true
        return
      }
      visited++
      let entries: Dirent[]
      try {
        entries = await fsp.readdir(current, { withFileTypes: true })
      } catch {
        return // 读不到就跳过（不让单个不可读目录毁掉整个视图）
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      // 当前目录自己是不是仓库：`.git` 是目录或 worktree/子模块用的文件都算
      if (!isRoot && entries.some((e) => e.name === '.git')) found.push(current)
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        // 符号链接可能成环；点目录（.idea/.cache/.venv…）不是仓库，跳过还能大幅减少扫描量
        if (entry.name.startsWith('.')) continue
        if (REPO_SCAN_SKIP.has(entry.name)) continue
        await walk(join(current, entry.name), false)
      }
    }

    await walk(dir, true)
    return { repos: found, scanTruncated }
  }

  /** 项目相对目录（`/` 归一；仓库就是项目根时返回 ''） */
  private relativeToProject(projectRoot: string, repoPath: string): string {
    const root = toSlashes(projectRoot).replace(/\/+$/, '')
    const repo = toSlashes(repoPath).replace(/\/+$/, '')
    if (repo === root) return ''
    if (!repo.startsWith(`${root}/`)) return repo
    return repo.slice(root.length + 1)
  }

  /**
   * 读单个仓库的 status + branch（失败只标在这个仓库上，其它仓库照常返回）。
   *
   * 路径口径：git 输出以**仓库根**为基准（--porcelain 不受 status.relativePaths 影响），
   * 先按 `--show-prefix` 换算成仓库内相对路径，再拼上仓库在项目里的相对目录 → 项目相对。
   */
  private async readRepoStatus(
    repoPath: string,
    relPrefix: string
  ): Promise<RepoReadResult> {
    const repoName = basename(toSlashes(repoPath).replace(/\/+$/, '')) || repoPath
    try {
      // status 与 branch 相互独立：simple-git 会在同一实例内串行排队，
      // 因此并行时各用一个实例（Windows 下单次 git 进程启动约数百毫秒）。
      const [status, branchInfo] = await Promise.all([
        this.getGit(repoPath).status(),
        this.getGit(repoPath, true).branch().catch(() => null) // 空仓库/游离 HEAD：没有分支不算失败
      ])
      const prefix = await this.projectPrefix(repoPath)

      const changes: GitChangeInfo[] = []
      for (const file of status.files) {
        const relToRepo = this.toProjectRelative(file.path, prefix)
        if (relToRepo === null) continue // 项目目录之外的变更与上传无关
        const rel = relPrefix === '' ? relToRepo : `${relPrefix}/${relToRepo}`
        // 内层仓库去重移到聚合处（只对“读取成功的内层仓库”生效，见 getStatusView）
        const changeInfo = this.classifyChange({ ...file, path: rel }, status)
        if (changeInfo) changes.push(changeInfo)
      }

      return {
        repo: {
          repoPath,
          repoName,
          branch: branchInfo?.current || undefined,
          changes
        },
        ahead: status.ahead,
        behind: status.behind
      }
    } catch (error) {
      return {
        repo: {
          repoPath,
          repoName,
          changes: [],
          error: error instanceof Error ? error.message : String(error)
        },
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

  /**
   * 某次提交涉及的文件。
   *
   * `--name-status` 的状态列可能是 `M` / `A` / `D`，也可能是重命名/复制的
   * `R094` / `C075`：后者是「字母 + 相似度百分比」，且会产生**三列**
   * `<状态>\t<旧路径>\t<新路径>`。
   * 这里统一把 status 归一成单字母（下游 statusShort 才能映射成标签 + 颜色），
   * 重命名/复制取**新路径**作为 path，旧路径与相似度单独带出供界面展示。
   */
  async getCommitFiles(dir: string, hash: string): Promise<GitCommitFile[]> {
    // 同样裸拼进 argv（`git show <hash>`）：非法值必须上抛，不能退化成"没有文件"
    if (!isSafeGitRev(hash)) throw new Error(`非法的提交 ID：${hash}`)
    try {
      const git = this.getGit(dir)
      // --relative：以 cwd（项目根）为基准输出路径；同时天然只列出项目目录内的文件
      const result = await git.raw(['show', '--name-status', '--format=', '--relative', hash])
      return result.trim().split('\n').filter(l => l.trim()).map(line => {
        const parts = line.split('\t')
        const rawStatus = (parts[0] || '?').trim()
        const letter = rawStatus.charAt(0).toUpperCase() || '?'
        const score = rawStatus.length > 1 ? Number(rawStatus.slice(1)) : undefined
        if ((letter === 'R' || letter === 'C') && parts.length >= 3) {
          return {
            status: letter,
            path: toSlashes(parts[2]),
            oldPath: toSlashes(parts[1]),
            score: Number.isFinite(score) ? score : undefined
          }
        }
        return { status: letter, path: toSlashes(parts[1] || line) }
      }).filter(entry => entry.path.length > 0 && !entry.path.startsWith('..'))
    } catch {
      return []
    }
  }

  /**
   * 定位「这个文件属于哪个仓库、在仓库内的相对路径」。
   *
   * 项目根常常不是仓库（多仓库项目 / 项目根是某个仓库的子目录），此时在项目根跑 git 会整体失败。
   * 这里先认根仓库，再退到**包含该文件的最内层子仓库**（与 `getStatusView` 的可见范围一致）。
   * 找不到任何仓库时原样返回，让后续 git 调用如实报错——绝不把「读不出来」说成「没有差异」。
   */
  private async resolveDiffTarget(
    dir: string,
    filePath: string
  ): Promise<{ repoDir: string; pathInRepo: string }> {
    const rel = toSlashes(filePath)
    // 先找“拥有这个文件的内层仓库”，**不管项目根本身是不是仓库**。
    // 此前根是仓库就直接返回：多仓库项目里 `frontend/app.ts` 在父仓库中是未跟踪目录，
    // `git diff HEAD -- frontend/app.ts` 恒为空，随后被格式化成“全新增”—— 差异视图全错。
    let scan: { repos: string[]; scanTruncated: boolean } | null = null
    try {
      scan = await this.findSubRepos(dir)
    } catch {
      scan = null
    }
    const owner = (scan?.repos ?? [])
      .map((repoPath) => ({ repoDir: repoPath, prefix: this.relativeToProject(dir, repoPath).replace(/\/+$/, '') }))
      .filter((candidate) => candidate.prefix !== '' && isUnder(rel, candidate.prefix))
      // 最内层仓库优先：外层仓库可能把内层目录当成一个未跟踪条目，文件真正归属内层
      .sort((a, b) => b.prefix.length - a.prefix.length)[0]
    if (owner) return { repoDir: owner.repoDir, pathInRepo: rel.slice(owner.prefix.length + 1) }
    return { repoDir: dir, pathInRepo: filePath }
  }

  async getFileDiff(dir: string, filePath: string): Promise<string> {
    // 路径必须是项目内相对路径：下游会 `join(repoDir, pathInRepo)` 读文件，
    // 不拒 `../` 与绝对路径就等于给管理端点开了一次任意读。
    const lexical = toSlashes(filePath)
    if (!lexical || lexical.split('/').includes('..') || /^([A-Za-z]:)?\//.test(lexical)) {
      throw new Error(`非法的文件路径：${filePath}`)
    }
    const target = await this.resolveDiffTarget(dir, filePath)
    const git = this.getGit(target.repoDir)
    let result: string
    try {
      // 先用 git diff HEAD 检出所有未提交差异
      result = await git.raw(['diff', 'HEAD', '--', target.pathInRepo])
    } catch (error) {
      // 读失败必须上抛：渲染层据此显示「差异加载失败 + 重试」，
      // 否则空字符串会被当成「文件无变更」——最坏的一种误导。
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`读取文件差异失败：${message}`)
    }
    if (result.trim()) return result

    // 空 diff 但退出码 0：文件是未跟踪的新文件 → 直接把内容渲染成「全新增」。
    // 读不到（文件已删除/被忽略）：这才是真的没有可视差异，返回空。
    try {
      const { promises: fsp } = await import('fs')
      const fullPath = join(target.repoDir, target.pathInRepo)
      const content = await fsp.readFile(fullPath, 'utf-8')
      // 格式化为 diff 风格的输出（全部新增）
      const lines = content.split('\n')
      const formatted = [
        `diff --git a/${target.pathInRepo} b/${target.pathInRepo}`,
        `new file mode 100644`,
        `--- /dev/null`,
        `+++ b/${target.pathInRepo}`,
        ...lines.map(l => `+${l}`)
      ].join('\n')
      return formatted
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
