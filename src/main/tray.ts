/**
 * 托盘常驻与关窗生命周期。
 *
 * INV-7：关窗不等于退出——窗口关闭只隐藏，进程继续提供本地服务；仅托盘「退出」结束进程。
 * 多项目多窗口：托盘是唯一常驻入口，菜单里列出各项目窗口（点击聚焦），
 * 超过内联上限的收进「更多窗口…」（决策 D-5 / Miller 7±2）。
 *
 * 本模块把纯逻辑（关窗判定、菜单模板、窗口列表收纳）与 Electron 依赖分离：
 * Electron 只在 `createTray` 内部按需加载，便于在 vitest（无 Electron 运行时）中测试。
 */
import type { MenuItemConstructorOptions, Tray as ElectronTray } from 'electron'
import { TRAY_INLINE_WINDOW_LIMIT, trayWindowLabels, trayWindowMenu, type WindowEntry } from './window-manager'

export interface TrayActions {
  /** 托盘**单击**：聚焦最近聚焦的窗口（决策 D-4） */
  openWindow(): void
  /** 菜单项「打开主窗口」：始终针对主窗口（与单击语义不同，勿混用） */
  openMainWindow(): void
  /** 状态项点击：打开全局设置的「本地服务」页（托盘里最显眼的入口） */
  openServerSettings(): void
  /** 菜单项「设置」：直接进入全局设置页面（不经过主窗口） */
  openSettings(): void
  /** 聚焦指定窗口（窗口列表点击） */
  focusWindow(id: number): void
  /** 唯一退出入口 */
  quit(): void
  /** 状态文本按需生成（不做定时轮询） */
  statusText(): string
  /** 当前窗口列表（含主窗口；菜单里只展示项目窗口） */
  entries(): WindowEntry[]
  /** 最近聚焦的窗口 id（用于菜单勾选态） */
  focusedWindowId(): number | null
}

/** 托盘可交互能力（便于在无 Electron 运行时下测试事件绑定） */
export interface TrayLike {
  on(event: string, listener: () => void): void
  setContextMenu(menu: unknown): void
  setToolTip(text: string): void
  destroy(): void
}

/**
 * 绑定托盘交互：
 * - 单击图标 → 聚焦最近聚焦的窗口（右键仍是菜单，由 setContextMenu 提供）
 */
export function bindTrayEvents(tray: TrayLike, actions: TrayActions): void {
  tray.on('click', () => actions.openWindow())
}

export interface TrayHandle {
  /** 托盘不可用（无图形环境或创建失败）时为 null */
  tray: ElectronTray | null
  available: boolean
  /** 重新构建菜单（状态变化时调用） */
  refresh(): void
  destroy(): void
}

/**
 * 关窗是否应结束进程。
 * 托盘可用时不退出（INV-7）；托盘不可用时必须退出，否则会留下无界面且无法操作的进程。
 */
export function shouldQuitOnWindowClose(opts: { trayAvailable: boolean }): boolean {
  return !opts.trayAvailable
}

/**
 * 托盘菜单模板：状态（只读）+ 项目窗口列表 + 打开主窗口 + 退出。
 * 窗口数超过内联上限时，余下收进「更多窗口…」子菜单。
 */
export function trayMenuTemplate(actions: TrayActions, inlineLimit: number = TRAY_INLINE_WINDOW_LIMIT): MenuItemConstructorOptions[] {
  const focusedId = actions.focusedWindowId()
  const entries = actions.entries()
  const { inline, overflow } = trayWindowMenu(entries, inlineLimit)
  // 菜单里只显示项目名；窗口标题（任务栏）仍是「项目名 — ShipIt」
  const labels = trayWindowLabels(entries)

  const windowItem = (entry: WindowEntry): MenuItemConstructorOptions => ({
    label: labels.get(entry.id) ?? entry.title,
    type: 'checkbox',
    checked: entry.id === focusedId,
    click: (): void => actions.focusWindow(entry.id)
  })

  const items: MenuItemConstructorOptions[] = [
    // 状态项可点：直接进服务配置（不额外加提示文案，保持状态行简洁）
    { label: actions.statusText(), click: (): void => actions.openServerSettings() },
    { type: 'separator' }
  ]

  if (inline.length > 0) {
    items.push(...inline.map(windowItem))
    if (overflow.length > 0) {
      items.push({ label: '更多窗口…', submenu: overflow.map(windowItem) })
    }
    items.push({ type: 'separator' })
  }

  items.push({ label: '打开主窗口', click: (): void => actions.openMainWindow() })
  items.push({ label: '设置', click: (): void => actions.openSettings() })
  items.push({ type: 'separator' })
  items.push({ label: '退出 ShipIt', click: (): void => actions.quit() })
  return items
}

/**
 * 创建托盘。依赖 Electron 运行时，创建失败时返回不可用句柄，
 * 由调用方按 `shouldQuitOnWindowClose` 决定关窗行为。
 */
export function createTray(actions: TrayActions, iconPath: string): TrayHandle {
  type ElectronModule = {
    Tray: new (path: string) => ElectronTray
    Menu: { buildFromTemplate(t: MenuItemConstructorOptions[]): ElectronTray['popUpContextMenu'] extends never ? never : unknown }
  }
  let electron: ElectronModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    electron = require('electron') as ElectronModule
  } catch {
    return { tray: null, available: false, refresh: () => undefined, destroy: () => undefined }
  }

  let tray: ElectronTray
  try {
    tray = new electron.Tray(iconPath)
  } catch {
    return { tray: null, available: false, refresh: () => undefined, destroy: () => undefined }
  }

  // 单击托盘图标打开主窗口（右键仍是菜单）
  bindTrayEvents(tray as unknown as TrayLike, actions)

  // 必须持有最近一次构建的菜单引用：局部变量被回收后，Windows 上可能回落到上一次设置的菜单，
  // 表现为「服务已启动但托盘菜单仍显示未开启」。
  let currentMenu: unknown = null
  const refresh = (): void => {
    currentMenu = electron.Menu.buildFromTemplate(trayMenuTemplate(actions))
    tray.setContextMenu(currentMenu as never)
    tray.setToolTip(actions.statusText())
  }
  refresh()

  return {
    tray,
    available: true,
    refresh,
    destroy: (): void => tray.destroy()
  }
}
