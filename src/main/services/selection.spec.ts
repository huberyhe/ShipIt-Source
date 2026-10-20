import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { MAX_SELECTION_FILES, matchMapping, resolveSelection, toPlanSkips, type SelectionDeps } from './selection'
import type { UploadTask } from '../../shared/types'

/**
 * P2 回归：跳过原因必须能区分「文件不存在」与「未命中映射」（此前一律标 no-mapping，排障被带偏）；
 * `--dir` 遇到不可读目录要如实报错，而不是静默变成「目录内没有文件」。
 */

const PROJECT = 'D:/work/app'

const task = (relativePath: string): UploadTask => ({
  localPath: `${PROJECT}/${relativePath}`,
  remotePath: `/opt/app/${relativePath}`,
  relativePath,
  size: 1
})

const deps = (over: Partial<SelectionDeps> = {}): SelectionDeps => ({
  isGitRepo: async () => true,
  listChangedFiles: async () => ['dist/a.js'],
  listCommitFiles: async () => ['dist/a.js'],
  listFilesInDir: async () => [`${PROJECT}/dist/a.js`],
  ...over
})

describe('P1-7 选择器路径不得越出项目根（方案 B 的纵深防御）', () => {
  const ROOT = 'D:/work/app'
  /** 「项目根之外」的绝对路径：必须按当前平台取，否则在 POSIX 上 D:/secret 会被当成相对路径 */
  const OUTSIDE_DIR = process.platform === 'win32' ? 'D:/secret' : '/etc/secret'

  function deps(over: Partial<SelectionDeps> = {}): SelectionDeps {
    return {
      isGitRepo: async () => true,
      listChangedFiles: async () => [],
      listCommitFiles: async () => [],
      listFilesInDir: async () => [],
      ...over
    }
  }

  it('绝对路径的 dir 落在项目根外 → USAGE（此前会被直接遍历并回显）', async () => {
    const r = await resolveSelection({ kind: 'dir', path: OUTSIDE_DIR }, ROOT, deps())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('USAGE')
    expect(r.message).toContain('超出项目根')
  })

  it('用 .. 逃出项目根的 dir → USAGE', async () => {
    const r = await resolveSelection({ kind: 'dir', path: '../secret' }, ROOT, deps())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('USAGE')
  })

  it('前缀相似的兄弟目录不算在项目内（按路径段比较）', async () => {
    const r = await resolveSelection({ kind: 'dir', path: 'D:/work/app2/x' }, ROOT, deps())
    expect(r.ok).toBe(false)
  })

  it('项目根内的 dir 正常放行（相对与绝对都行）', async () => {
    const d = deps({ listFilesInDir: async () => [`${ROOT}/dist/a.js`] })
    expect((await resolveSelection({ kind: 'dir', path: 'dist' }, ROOT, d)).ok).toBe(true)
    expect((await resolveSelection({ kind: 'dir', path: 'D:/work/app/dist' }, ROOT, d)).ok).toBe(true)
  })

  it('files 里混入项目根外的路径 → USAGE 且点名（调用方自己传的，回显无泄露问题）', async () => {
    const r = await resolveSelection({ kind: 'files', paths: ['dist/a.js', `${OUTSIDE_DIR}/id_rsa`] }, ROOT, deps())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('USAGE')
    expect(r.message).toContain('id_rsa')
  })

  it('选择集超过上限 → USAGE（明确报错，不静默截断）', async () => {
    const many = Array.from({ length: MAX_SELECTION_FILES + 1 }, (_, i) => `dist/f${i}.js`)
    const r = await resolveSelection({ kind: 'files', paths: many }, ROOT, deps())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('USAGE')
    expect(r.message).toContain('过多')
  })
})

describe('selection（P2 回归）', () => {
  it('跳过原因区分 missing 与 no-mapping', () => {
    const files = [`${PROJECT}/dist/a.js`, `${PROJECT}/dist/gone.js`, `${PROJECT}/README.md`]
    const tasks = [task('dist/a.js')]

    const skips = toPlanSkips(files, tasks, PROJECT, new Set([`${PROJECT}/dist/gone.js`]))

    expect(skips).toEqual([
      { relativePath: 'dist/gone.js', reason: 'missing' },
      { relativePath: 'README.md', reason: 'no-mapping' }
    ])
  })

  it('未提供 missing 集合时保持既有语义（一律 no-mapping）', () => {
    const skips = toPlanSkips([`${PROJECT}/README.md`], [], PROJECT)
    expect(skips).toEqual([{ relativePath: 'README.md', reason: 'no-mapping' }])
  })

  it('all-changed 的 git 路径按项目根拼接（配合 git --relative 修复）', async () => {
    const r = await resolveSelection({ kind: 'all-changed' }, PROJECT, deps())
    expect(r).toEqual({ ok: true, files: [join(PROJECT, 'dist/a.js')] })
  })

  it('--dir 目录不可读时如实报错（不是「目录内没有文件」）', async () => {
    const r = await resolveSelection(
      { kind: 'dir', path: '.' },
      PROJECT,
      deps({
        listFilesInDir: async () => {
          throw new Error('EACCES: permission denied')
        }
      })
    )

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('EMPTY_SELECTION')
      expect(r.message).toContain('目录不可读')
      expect(r.message).toContain('EACCES')
      expect(r.hint).toBeTruthy()
    }
  })

  it('--dir 目录为空仍按「目录内没有文件」报告', async () => {
    const r = await resolveSelection({ kind: 'dir', path: '.' }, PROJECT, deps({ listFilesInDir: async () => [] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('目录内没有文件')
  })

  it('映射匹配：最长前缀优先（与上传口径一致）', () => {
    const mappings = [
      { id: 'm1', localPrefix: 'dist/', remotePath: '/opt/dist' },
      { id: 'm2', localPrefix: 'dist/assets/', remotePath: '/opt/assets' }
    ]

    expect(matchMapping('dist/assets/app.js', mappings)).toMatchObject({ remotePath: '/opt/assets' })
    expect(matchMapping('dist/app.js', mappings)).toMatchObject({ remotePath: '/opt/dist' })
    expect(matchMapping('src/app.js', mappings)).toBeNull()
  })
})
