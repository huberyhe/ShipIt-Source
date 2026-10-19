import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
})
