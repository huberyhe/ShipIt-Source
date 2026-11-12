import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService } from './git-service'

/**
 * 用真实 git 仓库覆盖「项目根是仓库子目录」这一最容易出错的情形（P2 回归）：
 * git 输出的路径以**仓库根**为基准；若下游把它们当「项目相对路径」拼接，
 * 拼出的路径不存在 → 真实变更被全部丢弃（plan 空、deploy 报没有可上传文件）。
 */

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' })

let repoRoot = ''
let appDir = ''
let svc: GitService

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'shipit-git-'))
  appDir = join(repoRoot, 'app')
  mkdirSync(join(appDir, 'dist'), { recursive: true })
  writeFileSync(join(appDir, 'dist', 'a.js'), 'v1', 'utf-8')
  writeFileSync(join(repoRoot, 'other.txt'), 'x', 'utf-8')
  git(repoRoot, ['init', '-q'])
  git(repoRoot, ['config', 'user.email', 'shipit@test'])
  git(repoRoot, ['config', 'user.name', 'shipit'])
  git(repoRoot, ['add', '-A'])
  git(repoRoot, ['commit', '-qm', 'init'])
  svc = new GitService()
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('git-service 路径基准（P2 回归）', () => {
  it('项目根是仓库子目录时，未提交变更相对项目根而不是仓库根', async () => {
    writeFileSync(join(appDir, 'dist', 'a.js'), 'v2', 'utf-8') // 项目内变更
    writeFileSync(join(repoRoot, 'other.txt'), 'y', 'utf-8') // 仓库内、项目外的变更

    const view = await svc.getStatusView(appDir)

    expect(view.hasGit).toBe(true)
    const paths = view.changes.map((c) => c.relativePath)
    expect(paths).toContain('dist/a.js')
    expect(paths.some((p) => p.startsWith('app/'))).toBe(false) // 不得带仓库根前缀
    expect(paths).not.toContain('other.txt') // 项目之外的变更不混入上传范围
  })

  it('项目根 == 仓库根时路径不变；git show 也按项目根输出', async () => {
    writeFileSync(join(appDir, 'dist', 'a.js'), 'v3', 'utf-8')

    // 仓库根 == 项目根：路径就是仓库相对路径，不做任何前缀变换
    const atRepoRoot = await svc.getStatusView(repoRoot)
    expect(atRepoRoot.changes.map((c) => c.relativePath)).toContain('app/dist/a.js')

    git(repoRoot, ['add', '-A'])
    git(repoRoot, ['commit', '-qm', 'change in app'])
    const commitFiles = await svc.getCommitFiles(appDir, 'HEAD')
    expect(commitFiles.map((f) => f.path)).toEqual(['dist/a.js'])
  })

  it('重命名（R094）归一成单字母状态，并取新路径 + 带出旧路径', async () => {
    // 内容基本不变地挪位置：git 会输出 `R100\t旧路径\t新路径` 三列
    git(repoRoot, ['mv', 'app/dist/a.js', 'app/dist/b.js'])
    git(repoRoot, ['commit', '-qm', 'rename'])

    const files = await svc.getCommitFiles(appDir, 'HEAD')
    expect(files).toHaveLength(1)
    const [renamed] = files
    // 状态必须是单字母 R（下游 statusShort 依赖它映射成标签 + 颜色，'R094' 会穿透成裸文本）
    expect(renamed.status).toBe('R')
    // path = 新路径（上传目标）；旧路径单独带出供界面展示
    expect(renamed.path).toBe('dist/b.js')
    expect(renamed.oldPath).toBe('dist/a.js')
    expect(renamed.score).toBe(100)
  })

  it('普通新增文件仍是单字母 A，且不带 oldPath', async () => {
    writeFileSync(join(appDir, 'dist', 'copy.js'), 'v3', 'utf-8')
    git(repoRoot, ['add', '-A'])
    git(repoRoot, ['commit', '-qm', 'copy'])

    const files = await svc.getCommitFiles(appDir, 'HEAD')
    const added = files.find((f) => f.path === 'dist/copy.js')
    expect(added?.status).toBe('A')
    expect(added?.oldPath).toBeUndefined()
  })
})

/**
 * 多根项目：一个项目目录下可能并列多个 git 仓库（`项目/前端`、`项目/后端`…）。
 * 这里用真实 git 命令造数据，验「发现 / 去重 / 错误隔离 / 并集口径」。
 */
describe('git-service 多仓库（多根项目）', () => {
  let projectDir = ''

  const initRepo = (dir: string): void => {
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.email', 'shipit@test'])
    git(dir, ['config', 'user.name', 'shipit'])
    writeFileSync(join(dir, '.seed.txt'), 'seed', 'utf-8')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'init'])
  }

  const currentBranch = (dir: string): string => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'shipit-multi-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('根是仓库 + 一个子仓库 → repos.length === 2，两个分支各自正确', async () => {
    initRepo(projectDir)
    git(projectDir, ['checkout', '-q', '-b', 'feature/root'])
    writeFileSync(join(projectDir, 'root.txt'), 'a', 'utf-8')

    const sub = join(projectDir, 'frontend')
    initRepo(sub)
    git(sub, ['checkout', '-q', '-b', 'feat/sub'])
    writeFileSync(join(sub, 'app.ts'), 'x', 'utf-8')

    const view = await new GitService().getStatusView(projectDir)

    expect(view.hasGit).toBe(true)
    expect(view.repos?.length).toBe(2)

    const rootRepo = view.repos!.find((repo) => repo.repoPath === projectDir)!
    const subRepo = view.repos!.find((repo) => repo.repoPath === sub)!
    expect(rootRepo.branch).toBe(currentBranch(projectDir))
    expect(subRepo.branch).toBe(currentBranch(sub))
    // 分支各自独立，没有串到别的仓库
    expect(rootRepo.branch).toBe('feature/root')
    expect(subRepo.branch).toBe('feat/sub')
    // 旧字段：branch = 根仓库的分支
    expect(view.branch).toBe('feature/root')
    // 根仓库名用项目目录名，内层仓库用目录名
    expect(rootRepo.repoName).toBe(basename(projectDir))
    expect(subRepo.repoName).toBe('frontend')
  })

  it('内层仓库读失败时不把它的文件从外层变更里抹掉（两边都不见 = 静默少传）', async () => {
    // 根仓库 + `frontend/` 内层仓库；把内层仓库弄成读不出来（.git 损坏）
    initRepo(projectDir)
    const sub = join(projectDir, 'frontend')
    initRepo(sub)
    writeFileSync(join(sub, 'app.ts'), 'x', 'utf-8')
    // 让 `git status` 在该仓库里真的失败：把 .git 目录换成普通文件（目录项仍在，
    // 所以 findSubRepos 会认它是仓库；读 status 时 git 会报 invalid gitfile）
    rmSync(join(sub, '.git'), { recursive: true, force: true })
    writeFileSync(join(sub, '.git'), 'garbage', 'utf-8')

    const view = await new GitService().getStatusView(projectDir)

    const subRepo = view.repos!.find((repo) => repo.repoPath === sub)!
    // 内层确实读失败了
    expect(subRepo.error).toBeTruthy()
    // 关键：外层不能把 `frontend/` 这条未跟踪目录也丢掉 —— 否则这棵树在 changes 里彻底消失
    const rootChanges = view.changes.map((change) => change.relativePath.replace(/\\/g, '/'))
    expect(rootChanges.some((path) => path === 'frontend' || path.startsWith('frontend/'))).toBe(true)
  })

  it('getFileDiff 在多仓库项目里按文件所属仓库读取（项目根不是仓库也能出差异）', async () => {
    // 项目根本身不是仓库，只有 frontend / backend 两个子仓库
    const frontend = join(projectDir, 'frontend')
    initRepo(frontend)
    writeFileSync(join(frontend, 'app.ts'), 'line1\n', 'utf-8')
    git(frontend, ['add', '-A'])
    git(frontend, ['commit', '-qm', 'add app'])
    writeFileSync(join(frontend, 'app.ts'), 'line1\nline2\n', 'utf-8')

    const diff = await new GitService().getFileDiff(projectDir, 'frontend/app.ts')

    // 关键：不是空串（空串会被界面当成「文件无变更」）
    expect(diff).toContain('+line2')
    expect(diff).toContain('diff --git')
  })

  it('项目里没有任何仓库时，getFileDiff 上抛而不是回空串', async () => {
    await expect(new GitService().getFileDiff(projectDir, 'a.ts')).rejects.toThrow(/读取文件差异失败/)
  })

  it('子仓库的变更不会出现在外层仓库（去重），且内层路径仍是项目相对', async () => {
    initRepo(projectDir)
    const sub = join(projectDir, 'frontend')
    initRepo(sub)
    writeFileSync(join(sub, 'app.ts'), 'x', 'utf-8')
    writeFileSync(join(projectDir, 'root.txt'), 'y', 'utf-8')

    const view = await new GitService().getStatusView(projectDir)
    const rootRepo = view.repos!.find((repo) => repo.repoPath === projectDir)!
    const subRepo = view.repos!.find((repo) => repo.repoPath === sub)!

    // git 对外层只会给出一个未跟踪目录条目（`frontend/`）：连同其下文件一并排除
    expect(rootRepo.changes.map((c) => c.relativePath)).toEqual(['root.txt'])
    // 内层仓库的路径必须拼上它在项目里的相对目录（否则上传会拼出不存在的路径）
    expect(subRepo.changes.map((c) => c.relativePath)).toEqual(['frontend/app.ts'])
    // 并集里同一个文件只出现一次
    expect(view.changes.map((c) => c.relativePath).sort()).toEqual(['frontend/app.ts', 'root.txt'])
  })

  it('根不是仓库、只有两个子仓库 → hasGit 为 true、branch 为 undefined', async () => {
    const backend = join(projectDir, 'backend')
    const frontend = join(projectDir, 'frontend')
    initRepo(backend)
    initRepo(frontend)
    writeFileSync(join(backend, 'a.ts'), 'x', 'utf-8')
    writeFileSync(join(frontend, 'b.ts'), 'y', 'utf-8')

    const view = await new GitService().getStatusView(projectDir)

    expect(view.hasGit).toBe(true)
    expect(view.branch).toBeUndefined()
    expect(view.repos?.length).toBe(2)
    expect(view.changes.map((c) => c.relativePath).sort()).toEqual(['backend/a.ts', 'frontend/b.ts'])
  })

  it('某个子仓库读取失败时，其它仓库仍返回（该仓库带 error，整体不失败）', async () => {
    initRepo(projectDir)
    const good = join(projectDir, 'backend')
    initRepo(good)
    const broken = join(projectDir, 'broken')
    mkdirSync(broken, { recursive: true })
    // `.git` 是文件但指向不存在的目录：会被发现成「仓库候选」，但读状态必然失败
    writeFileSync(join(broken, '.git'), 'gitdir: D:/shipit-definitely-not-here\n', 'utf-8')
    writeFileSync(join(good, 'a.ts'), 'x', 'utf-8')

    const view = await new GitService().getStatusView(projectDir)

    expect(view.hasGit).toBe(true)
    expect(view.repos?.length).toBe(3)
    const brokenRepo = view.repos!.find((repo) => repo.repoPath === broken)!
    expect(brokenRepo.error).toBeTruthy()
    expect(brokenRepo.changes).toEqual([])
    const goodRepo = view.repos!.find((repo) => repo.repoPath === good)!
    expect(goodRepo.error).toBeUndefined()
    expect(goodRepo.changes.map((c) => c.relativePath)).toEqual(['backend/a.ts'])
  })

  it('changes 并集与各仓库 changes 之和一致（去重后）', async () => {
    initRepo(projectDir)
    const sub = join(projectDir, 'frontend')
    initRepo(sub)
    writeFileSync(join(sub, 'a.ts'), 'x', 'utf-8')
    writeFileSync(join(sub, 'b.ts'), 'y', 'utf-8')
    writeFileSync(join(projectDir, 'root.txt'), 'z', 'utf-8')

    const view = await new GitService().getStatusView(projectDir)
    const sum = view.repos!.reduce((total, repo) => total + repo.changes.length, 0)
    expect(view.changes.length).toBe(sum)
    expect(new Set(view.changes.map((c) => c.relativePath)).size).toBe(sum)
  })

  it('深层嵌套的仓库也能被发现（IDEA 多根：manage/console/controllers/temp）', async () => {
    // 真实项目里仓库会埋在很深的目录下；固定深度会把它藏起来
    initRepo(join(projectDir, 'a', 'b'))
    initRepo(join(projectDir, 'manage', 'console', 'controllers', 'temp'))

    const view = await new GitService().getStatusView(projectDir)

    expect(view.repos?.map((repo) => repo.repoName).sort()).toEqual(['b', 'temp'])
    // 相对目录能让人分辨同名仓库
    expect(view.repos?.map((repo) => repo.repoPath).some((p) => p.replace(/\\/g, '/').endsWith('manage/console/controllers/temp'))).toBe(true)
  })

  it('目录访问预算耗尽时带 scanTruncated（不把“没扫完”当“没仓库”）', async () => {
    initRepo(join(projectDir, 'deep', 'deeper', 'repo'))

    const shallow = await new GitService({ maxScanDirs: 1 }).getStatusView(projectDir)
    expect(shallow.scanTruncated).toBe(true)

    const full = await new GitService({ maxScanDirs: 2000 }).getStatusView(projectDir)
    expect(full.scanTruncated).toBeUndefined()
    expect(full.repos?.map((repo) => repo.repoName)).toEqual(['repo'])
  })

  it('仓库数超过上限时带 truncated 标记（不静默截断）', async () => {
    initRepo(projectDir)
    initRepo(join(projectDir, 'a'))
    initRepo(join(projectDir, 'b'))

    const limited = await new GitService({ maxRepos: 2 }).getStatusView(projectDir)
    expect(limited.truncated).toBe(true)
    expect(limited.repos?.length).toBe(2)

    const full = await new GitService({ maxRepos: 12 }).getStatusView(projectDir)
    expect(full.truncated).toBeUndefined()
    expect(full.repos?.length).toBe(3)
  })
})
