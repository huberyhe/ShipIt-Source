/**
 * P1-5 作用域与「项目内」判定必须看**真实路径**。
 *
 * 词法判断（normalize + 前缀比较）在下面这类场景直接失效：
 * `allowedRoots` 内放一个 junction/symlink → 外部目录，词法上仍在允许范围内，
 * 局域网令牌持有者就能枚举/上传任意位置。这里用真实文件系统链接覆盖（不可建时自动跳过）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileService } from './file-service'
import { ProjectContext } from './project-context'
import { isInsideProject } from './selection'

function tryLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

let root = ''
let allowed = ''
let outside = ''
let escapeLink = ''
let insideLink = ''
let linked = false

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shipit-scope-'))
  allowed = join(root, 'allowed')
  outside = join(root, 'outside')
  mkdirSync(allowed, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'top-secret', 'utf-8')
  mkdirSync(join(allowed, 'sub'), { recursive: true })
  writeFileSync(join(allowed, 'sub', 'ok.txt'), 'ok', 'utf-8')

  escapeLink = join(allowed, 'escape')
  insideLink = join(allowed, 'inside')
  linked = tryLink(outside, escapeLink)
  if (linked) tryLink(join(allowed, 'sub'), insideLink)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('P1-5 作用域按真实路径判定', () => {
  it('allowedRoots 内的链接指向外部 → PROJECT_OUT_OF_SCOPE（不可建链接时跳过）', () => {
    if (!linked) return
    const ctx = new ProjectContext(process.platform)
    const r = ctx.resolve({ project: escapeLink }, { enforce: true, allowedRoots: [allowed], openedProjects: [] })

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PROJECT_OUT_OF_SCOPE')
  })

  it('链接指向允许范围内部时仍然可用（不误杀正常用法）', () => {
    if (!linked) return
    const ctx = new ProjectContext(process.platform)
    const r = ctx.resolve({ project: insideLink }, { enforce: true, allowedRoots: [allowed], openedProjects: [] })
    expect(r.ok).toBe(true)
  })

  it('isInsideProject 拒绝“词法在项目内、真实路径在项目外”的路径', () => {
    if (!linked) return
    expect(isInsideProject(allowed, join(allowed, 'sub', 'ok.txt'))).toBe(true)
    expect(isInsideProject(allowed, escapeLink)).toBe(false)
  })

  it('上传遍历不跟随目录链接：外部文件不会被收进上传集合', async () => {
    if (!linked) return
    const files = await new FileService().collectFilesForUpload(allowed)
    expect(files.some((path) => path.includes('secret.txt'))).toBe(false)
    // 链接被跳过，真实文件照常收集
    expect(files.some((path) => path.endsWith('ok.txt'))).toBe(true)
  })
})
