import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isUnderPath, normalizePath, ProjectContext, samePath } from './project-context'

/** 建目录链接：Windows 用 junction（不需管理员），其他平台用普通 symlink */
function tryLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

describe('project-context（策略 D′ / INV-10：项目根必填）', () => {
  it('P3 回归 normalizePath 保留根语义（不把 C:\\ 削成 C:、不把 // 削成空）', () => {
    expect(normalizePath('C:\\')).toBe('C:/')
    expect(normalizePath('C:\\work\\app\\')).toBe('C:/work/app')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('//')).toBe('//')
    expect(normalizePath('//server/share/')).toBe('//server/share')
  })

  it('D′ 回归 未指定项目 → USAGE（退出码 4），而不是回退到桌面焦点项目', () => {
    const ctx = new ProjectContext('win32')
    ctx.setCurrent('D:/work/app') // 桌面焦点在别的项目，也不允许隐式使用
    const r = ctx.resolve({})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('USAGE')
    expect(r.error.hint).toContain('projects list')
  })

  it('D′ 回归 空串／纯空白同样视为未指定', () => {
    const ctx = new ProjectContext('win32')
    for (const bad of ['', '   ', null, undefined]) {
      const r = ctx.resolve({ project: bad as string | null | undefined })
      expect(r.ok).toBe(false)
    }
  })

  it('D′ 指定项目即可执行，且不做任何"与桌面一致"判定', () => {
    const ctx = new ProjectContext('win32')
    ctx.setCurrent('D:/work/app')
    const r = ctx.resolve({ project: 'D:/work/other' })
    expect(r).toEqual({ ok: true, project: { projectRoot: 'D:/work/other' } })
  })

  it('D′ 桌面未打开项目时，显式指定的项目仍可用（CI / 无界面场景）', () => {
    const ctx = new ProjectContext('win32')
    expect(ctx.getCurrent()).toBeNull()
    const r = ctx.resolve({ project: 'D:/ci/repo' })
    expect(r).toEqual({ ok: true, project: { projectRoot: 'D:/ci/repo' } })
  })

  it('P3 回归 显式项目不会被当成「未指定」而回退（C:\\ 这类根要原样保留）', () => {
    const ctx = new ProjectContext('win32')
    ctx.setCurrent('D:/work/app')
    const r = ctx.resolve({ project: 'C:\\' })
    expect(r).toEqual({ ok: true, project: { projectRoot: 'C:/' } })
  })

  it('setCurrent 仅用于展示：不影响 resolve 结果', () => {
    const ctx = new ProjectContext('win32')
    ctx.setCurrent('D:\\work\\app\\')
    expect(ctx.getCurrent()).toBe('D:/work/app')
    ctx.setCurrent(null)
    expect(ctx.getCurrent()).toBeNull()
    expect(ctx.resolve({ project: 'd:/WORK/app' })).toEqual({ ok: true, project: { projectRoot: 'd:/WORK/app' } })
  })

  it('D-25 作用域：本机（enforce=false）不限路径', () => {
    const ctx = new ProjectContext('win32')
    const scope = { enforce: false, allowedRoots: [], openedProjects: [] }
    expect(ctx.resolve({ project: 'D:/anywhere/x' }, scope)).toEqual({
      ok: true,
      project: { projectRoot: 'D:/anywhere/x' }
    })
  })

  it('D-25 作用域：局域网下已打开项目始终允许', () => {
    const ctx = new ProjectContext('win32')
    const scope = { enforce: true, allowedRoots: [], openedProjects: ['D:/Work/app'] }
    expect(ctx.resolve({ project: 'd:/work/APP' }, scope).ok).toBe(true)
  })

  it('D-25 作用域：局域网下 allowedRoots 之内允许（含自身与子目录）', () => {
    const ctx = new ProjectContext('win32')
    const scope = { enforce: true, allowedRoots: ['D:/Work'], openedProjects: [] }
    expect(ctx.resolve({ project: 'D:/Work' }, scope).ok).toBe(true)
    expect(ctx.resolve({ project: 'D:/Work/app/sub' }, scope).ok).toBe(true)
    expect(ctx.resolve({ project: 'd:/work/APP' }, scope).ok).toBe(true)
  })

  it('D-25 作用域：按路径段比较 —— D:/Work 不能匹配 D:/Work2', () => {
    const ctx = new ProjectContext('win32')
    const scope = { enforce: true, allowedRoots: ['D:/Work'], openedProjects: [] }
    const r = ctx.resolve({ project: 'D:/Work2/app' }, scope)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PROJECT_OUT_OF_SCOPE')
  })

  it('D-25 作用域：越界返回 PROJECT_OUT_OF_SCOPE 并说明当前允许范围', () => {
    const ctx = new ProjectContext('win32')
    const scope = { enforce: true, allowedRoots: ['D:/Work'], openedProjects: ['D:/Other/p'] }
    const r = ctx.resolve({ project: 'E:/secrets' }, scope)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PROJECT_OUT_OF_SCOPE')
    expect(r.error.hint).toContain('D:/Work')
  })

  it('D-25 isUnderPath：段边界与大小写（Windows）', () => {
    expect(isUnderPath('D:/Work', 'D:/Work/a', 'win32')).toBe(true)
    expect(isUnderPath('D:/Work', 'D:/Work2/a', 'win32')).toBe(false)
    expect(isUnderPath('D:/Work', 'd:/work/a/b', 'win32')).toBe(true)
    expect(isUnderPath('D:/Work/', 'D:/Work/a', 'win32')).toBe(true)
    expect(isUnderPath('/srv/app', '/srv/app', 'linux')).toBe(true)
    expect(isUnderPath('/srv/app', '/srv/application', 'linux')).toBe(false)
    expect(isUnderPath('/srv/App', '/srv/app', 'linux')).toBe(false)
    expect(isUnderPath('C:/', 'C:/anywhere', 'win32')).toBe(true)
  })

  it('DFX-PORT-001 路径归一化：分隔符与末尾斜杠', () => {
    expect(normalizePath('D:\\a\\b\\')).toBe('D:/a/b')
    expect(normalizePath('/home/me/app/')).toBe('/home/me/app')
    expect(normalizePath('/')).toBe('/')
    expect(samePath('/a/b', '/a/b/', 'linux')).toBe(true)
    expect(samePath('/A/b', '/a/B', 'linux')).toBe(false)
    expect(samePath('D:/A/b', 'd:/a/B', 'win32')).toBe(true)
  })
})
