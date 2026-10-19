import { describe, expect, it, vi } from 'vitest'
import { bindTrayEvents, shouldQuitOnWindowClose, trayMenuTemplate, type TrayActions, type TrayLike } from './tray'
import { windowTitle, type WindowEntry } from './window-manager'

const entry = (id: number, role: 'main' | 'project', projectPath: string | null): WindowEntry => ({
  id,
  role,
  projectPath,
  title: windowTitle(role, projectPath)
})

const actions = (over: Partial<TrayActions> = {}): TrayActions => ({
  openWindow: vi.fn(),
  openMainWindow: vi.fn(),
  openServerSettings: vi.fn(),
  openSettings: vi.fn(),
  focusWindow: vi.fn(),
  quit: vi.fn(),
  statusText: () => '服务未开启',
  entries: () => [entry(1, 'main', null)],
  focusedWindowId: () => null,
  ...over
})

/** 只取标签（忽略分隔线） */
const labels = (items: ReturnType<typeof trayMenuTemplate>): (string | undefined)[] =>
  items.filter((i) => i.type !== 'separator').map((i) => i.label)

describe('tray', () => {
  it('AC-018 关闭窗口后进程不退出（托盘可用时，INV-7）', () => {
    expect(shouldQuitOnWindowClose({ trayAvailable: true })).toBe(false)
  })

  it('AC-018 托盘不可用时关窗即退出，避免出现无界面且无法退出的进程', () => {
    expect(shouldQuitOnWindowClose({ trayAvailable: false })).toBe(true)
  })

  it('基础菜单：状态（可点）+ 打开主窗口 + 设置 + 唯一退出入口', () => {
    const template = trayMenuTemplate(actions())
    expect(labels(template)).toEqual(['服务未开启', '打开主窗口', '设置', '退出 ShipIt'])
    expect(template.filter((i) => i.type === 'separator')).toHaveLength(2)
  })

  it('状态项可点 → 打开服务配置；退出项触发 quit（唯一退出路径）', () => {
    const a = actions()
    const template = trayMenuTemplate(a)
    const status = template.find((i) => i.label === '服务未开启')
    const quit = template.find((i) => i.label === '退出 ShipIt')
    ;(status?.click as () => void)()
    expect(a.openServerSettings).toHaveBeenCalledTimes(1)
    ;(quit?.click as () => void)()
    expect(a.quit).toHaveBeenCalledTimes(1)
  })

  it('菜单项「设置」→ 直接进入全局设置页面', () => {
    const a = actions()
    const item = trayMenuTemplate(a).find((i) => i.label === '设置')
    ;(item?.click as () => void)()
    expect(a.openSettings).toHaveBeenCalledTimes(1)
  })

  it('菜单「打开主窗口」触发 openMainWindow（不是"聚焦最近窗口"），且不触发退出', () => {
    const a = actions()
    const open = trayMenuTemplate(a).find((i) => i.label === '打开主窗口')
    ;(open?.click as () => void)()
    expect(a.openMainWindow).toHaveBeenCalledTimes(1)
    expect(a.openWindow).not.toHaveBeenCalled() // 两个动作必须分开
    expect(a.quit).not.toHaveBeenCalled()
  })

  it('DFX-PERF-005 状态文本按需读取，构建菜单时才调用（不做空闲轮询）', () => {
    const statusText = vi.fn(() => '服务运行中')
    trayMenuTemplate(actions({ statusText }))
    expect(statusText).toHaveBeenCalledTimes(1)
    expect(statusText()).toBe('服务运行中')
  })

  it('多窗口：菜单列出项目窗口，点击聚焦；当前聚焦项打勾', () => {
    const focusWindow = vi.fn()
    const a = actions({
      focusWindow,
      entries: () => [entry(1, 'main', null), entry(2, 'project', 'D:/work/app'), entry(3, 'project', 'D:/work/api')],
      focusedWindowId: () => 3
    })
    const template = trayMenuTemplate(a)
    expect(labels(template)).toEqual(['服务未开启', 'app', 'api', '打开主窗口', '设置', '退出 ShipIt'])
    const appItem = template.find((i) => i.label === 'app')
    const apiItem = template.find((i) => i.label === 'api')
    expect(appItem?.checked).toBe(false)
    expect(apiItem?.checked).toBe(true)
    ;(appItem?.click as () => void)()
    expect(focusWindow).toHaveBeenCalledWith(2)
  })

  it('多窗口：超过内联上限时收纳进「更多窗口…」子菜单', () => {
    const many = [entry(1, 'main', null)]
    for (let i = 0; i < 8; i++) many.push(entry(10 + i, 'project', `D:/work/p${i}`))
    const template = trayMenuTemplate(actions({ entries: () => many }))
    const more = template.find((i) => i.label === '更多窗口…')
    expect(more).toBeTruthy()
    expect((more?.submenu as unknown[]).length).toBe(3)
    // 内联 5 个（p0~p4），其余 3 个（p5~p7）在子菜单里
    const inline = labels(template)
    expect(inline).toContain('p0')
    expect(inline).toContain('p4')
    expect(inline).not.toContain('p5')
    const sub = (more?.submenu as { label?: string }[]).map((i) => i.label)
    expect(sub).toEqual(['p5', 'p6', 'p7'])
  })

  it('单击托盘图标 → 打开主窗口（右键仍是菜单）', () => {
    const listeners: Record<string, () => void> = {}
    const fake: TrayLike = {
      on: (event, listener) => {
        listeners[event] = listener
      },
      setContextMenu: vi.fn(),
      setToolTip: vi.fn(),
      destroy: vi.fn()
    }
    const a = actions()
    bindTrayEvents(fake, a)
    listeners.click()
    expect(a.openWindow).toHaveBeenCalledTimes(1)
    expect(a.openMainWindow).not.toHaveBeenCalled()
  })
})
