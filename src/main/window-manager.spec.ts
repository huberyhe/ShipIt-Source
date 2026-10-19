import { describe, expect, it } from 'vitest'
import {
  PROJECT_WINDOW_LIMIT,
  decideOpenTarget,
  closeActionFor,
  trayWindowLabels,
  TRAY_INLINE_WINDOW_LIMIT,
  findWindowForProject,
  normalizeProjectPath,
  parseWindowArgs,
  pickWindowToFocus,
  projectNameOf,
  shouldPromptWindowLimit,
  trayWindowMenu,
  windowArguments,
  windowTitle,
  type WindowEntry
} from './window-manager'

const entry = (id: number, role: 'main' | 'project', projectPath: string | null): WindowEntry => ({
  id,
  role,
  projectPath,
  title: windowTitle(role, projectPath)
})

describe('window-manager', () => {
  it('项目路径归一化：大小写与末尾分隔符不敏感（Windows）', () => {
    expect(normalizeProjectPath('D:\\Work\\App\\')).toBe(normalizeProjectPath('d:/work/app'))
    expect(normalizeProjectPath('D:/work/app///')).toBe('d:/work/app')
  })

  it('项目名取路径最后一段（两种分隔符都支持）', () => {
    expect(projectNameOf('D:\\ExtWorkspace\\git_gui')).toBe('git_gui')
    expect(projectNameOf('D:/ExtWorkspace/git_gui/')).toBe('git_gui')
  })

  it('窗口标题：主窗口固定，项目窗口带项目名', () => {
    expect(windowTitle('main', null)).toBe('ShipIt')
    expect(windowTitle('project', 'D:/work/app')).toBe('app — ShipIt')
  })

  it('同项目禁止多开：命中已有窗口则返回其 id（含大小写/分隔符差异）', () => {
    const windows = [entry(1, 'main', null), entry(2, 'project', 'D:/work/app'), entry(3, 'project', 'D:/work/other')]
    expect(findWindowForProject(windows, 'd:\\WORK\\APP')).toBe(2)
    expect(findWindowForProject(windows, 'D:/work/app/')).toBe(2)
    expect(findWindowForProject(windows, 'D:/work/new')).toBeNull()
  })

  it(`窗口上限：达到 ${PROJECT_WINDOW_LIMIT} 个即提示（不阻止）`, () => {
    expect(shouldPromptWindowLimit(PROJECT_WINDOW_LIMIT - 1)).toBe(false)
    expect(shouldPromptWindowLimit(PROJECT_WINDOW_LIMIT)).toBe(true)
    expect(shouldPromptWindowLimit(PROJECT_WINDOW_LIMIT + 3)).toBe(true)
  })

  it(`托盘窗口列表：最多内联 ${TRAY_INLINE_WINDOW_LIMIT} 个，其余收纳；主窗口不进入列表`, () => {
    const windows = [entry(1, 'main', null)]
    for (let i = 0; i < 8; i++) windows.push(entry(10 + i, 'project', `D:/work/p${i}`))
    const menu = trayWindowMenu(windows)
    expect(menu.inline).toHaveLength(TRAY_INLINE_WINDOW_LIMIT)
    expect(menu.overflow).toHaveLength(3)
    expect(menu.inline[0].title).toBe('p0 — ShipIt')
    expect([...menu.inline, ...menu.overflow].every((w) => w.role === 'project')).toBe(true)
  })

  it('托盘列表：主窗口若绑定了项目也要收录（防"窗口开着但列表里没有"）', () => {
    const windows = [
      entry(1, 'main', 'D:/work/app'),
      entry(2, 'project', 'D:/work/api'),
      entry(3, 'main', null)
    ]
    const menu = trayWindowMenu(windows)
    expect(menu.inline.map((w) => w.id)).toEqual([1, 2])
    expect(menu.inline[0].title).toBe('app — ShipIt')
  })

  it('打开项目的窗口决策：已有同项目 → 聚焦；主窗口发起 → 就地打开；项目窗口发起 → 新窗口', () => {
    const windows = [entry(1, 'main', null), entry(2, 'project', 'D:/work/app')]
    // 已有同项目（含大小写/分隔符差异）
    expect(decideOpenTarget(windows, 1, 'd:/WORK/app/')).toEqual({ kind: 'focus', windowId: 2 })
    // 主窗口发起 → 就地打开（用当前窗口，不新开）
    expect(decideOpenTarget(windows, 1, 'D:/work/other')).toEqual({ kind: 'here' })
    // 项目窗口发起 → 新窗口（不抢占已有项目的窗口）
    expect(decideOpenTarget(windows, 2, 'D:/work/other')).toEqual({ kind: 'new-window' })
    // 未知调用方 → 新窗口
    expect(decideOpenTarget(windows, null, 'D:/work/other')).toEqual({ kind: 'new-window' })
  })

  it('托盘菜单标签只用项目名（任务栏标题才需要「— ShipIt」）', () => {
    const windows = [entry(1, 'main', null), entry(2, 'project', 'D:/work/app'), entry(3, 'project', 'D:/work/api')]
    const labels = trayWindowLabels(windows)
    expect(labels.get(2)).toBe('app')
    expect(labels.get(3)).toBe('api')
    expect(labels.has(1)).toBe(false) // 主窗口不在列表里
    expect([...labels.values()].some((l) => l.includes('ShipIt'))).toBe(false)
  })

  it('同名项目用父目录消歧，避免菜单出现两个一样的项', () => {
    const windows = [entry(1, 'project', 'D:/a/src'), entry(2, 'project', 'D:/b/src'), entry(3, 'project', 'D:/c/lib')]
    const labels = trayWindowLabels(windows)
    expect(labels.get(1)).toBe('a/src')
    expect(labels.get(2)).toBe('b/src')
    expect(labels.get(3)).toBe('lib') // 未重名，保持只用末段
  })

  it('关窗语义：项目窗口真正关闭（关窗=关项目）；主窗口有托盘时只隐藏；退出流程放行', () => {
    expect(closeActionFor({ role: 'project', trayAvailable: true, isQuitting: false })).toBe('close')
    expect(closeActionFor({ role: 'project', trayAvailable: false, isQuitting: false })).toBe('close')
    expect(closeActionFor({ role: 'main', trayAvailable: true, isQuitting: false })).toBe('hide')
    expect(closeActionFor({ role: 'main', trayAvailable: false, isQuitting: false })).toBe('quit')
    expect(closeActionFor({ role: 'project', trayAvailable: true, isQuitting: true })).toBe('quit')
  })

  it('托盘列表不收录"未绑定项目的窗口"（避免出现看起来像主窗口的空项）', () => {
    const windows = [
      entry(1, 'main', null),
      entry(2, 'project', 'D:/work/app'),
      entry(3, 'project', null) // 项目已关闭 / 打开失败回退
    ]
    const menu = trayWindowMenu(windows)
    expect(menu.inline.map((w) => w.id)).toEqual([2])
    const labels = trayWindowLabels(windows)
    expect([...labels.keys()]).toEqual([2])
  })

  it('聚焦策略：优先最近聚焦的窗口；否则最后打开的项目窗口；再否则主窗口', () => {
    const windows = [entry(1, 'main', null), entry(2, 'project', 'D:/a'), entry(3, 'project', 'D:/b')]
    expect(pickWindowToFocus(windows, 1)).toBe(1)
    expect(pickWindowToFocus(windows, null)).toBe(3)
    expect(pickWindowToFocus([entry(1, 'main', null)], null)).toBe(1)
    expect(pickWindowToFocus([], null)).toBeNull()
    expect(pickWindowToFocus(windows, 999)).toBe(3) // 已关闭的 id 回落到最后项目窗口
  })

  it('窗口参数：角色与项目路径可往返解析（路径含空格/中文）', () => {
    const path = 'D:/工作 区/my app'
    const args = windowArguments('project', path)
    const parsed = parseWindowArgs(args)
    expect(parsed.role).toBe('project')
    expect(parsed.projectPath).toBe(path)

    const mainArgs = windowArguments('main', null)
    expect(parseWindowArgs(mainArgs)).toMatchObject({ role: 'main', projectPath: null })
  })

  it('启动参数里的绝对路径被识别为待打开项目（双击/命令行传参）', () => {
    const parsed = parseWindowArgs(['ShipIt.exe', 'D:\\work\\demo'])
    expect(parsed.startupProject).toBe('D:\\work\\demo')
    expect(parseWindowArgs(['ShipIt.exe', '--shipit-role=main']).startupProject).toBeNull()
  })

  it('argv[0] 是可执行文件自身路径时不被当作项目（避免“打开 electron.exe 作为项目”）', () => {
    const exe = 'D:' + String.fromCharCode(92) + 'app' + String.fromCharCode(92) + 'electron.exe'
    const parsed = parseWindowArgs([exe, '.', '--shipit-role=main'])
    expect(parsed.startupProject).toBeNull()
    expect(parsed.role).toBe('main')
  })
})
