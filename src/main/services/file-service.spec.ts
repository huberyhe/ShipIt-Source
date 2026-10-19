import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileService } from './file-service'

/**
 * P2 回归：上传遍历必须包含构建产物目录（dist/build/target/vendor…），
 * 否则 `--dir .` 会静默漏掉最常发布的 `dist/`；同时仍要跳过 .git 与 node_modules。
 */

let root = ''
let svc: FileService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shipit-files-'))
  mkdirSync(join(root, 'dist'), { recursive: true })
  mkdirSync(join(root, 'build'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'dist', 'a.js'), 'x', 'utf-8')
  writeFileSync(join(root, 'build', 'b.js'), 'x', 'utf-8')
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x', 'utf-8')
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: x', 'utf-8')
  writeFileSync(join(root, 'README.md'), 'x', 'utf-8')
  svc = new FileService()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const toRelative = (files: string[]): string[] =>
  files.map((f) => f.slice(root.length + 1).replace(/\\/g, '/')).sort()

describe('file-service 上传遍历（P2 回归）', () => {
  it('collectFilesForUpload 包含 dist/build，跳过 .git 与 node_modules', async () => {
    const files = toRelative(await svc.collectFilesForUpload(root))

    expect(files).toContain('dist/a.js')
    expect(files).toContain('build/b.js')
    expect(files).toContain('README.md')
    expect(files.some((f) => f.startsWith('.git/'))).toBe(false)
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
  })

  it('P2-9 传入 maxFiles 时遍历中提前收手（不会把整棵目录收完再报错）', async () => {
    const files = await svc.collectFilesForUpload(root, 2)
    expect(files.length).toBeLessThanOrEqual(3) // 上限 + 1（多要一个用于判定超限）
    expect(files.length).toBeGreaterThan(2)
  })

  it('对照：浏览用的 collectAllFiles 仍会跳过 dist/build（因此上传不能复用它）', async () => {
    const files = toRelative(await svc.collectAllFiles(root))

    expect(files).toContain('README.md')
    expect(files).not.toContain('dist/a.js')
    expect(files).not.toContain('build/b.js')
  })

  it('目录不存在时抛错（不静默返回空集合，否则会被误报成「目录内没有文件」）', async () => {
    await expect(svc.collectFilesForUpload(join(root, 'no-such-dir'))).rejects.toThrow()
  })

  it('空目录返回空集合（不抛错）', async () => {
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    expect(await svc.collectFilesForUpload(empty)).toEqual([])
  })
})
