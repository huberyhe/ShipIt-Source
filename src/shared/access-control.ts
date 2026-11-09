/**
 * 访问权限分级（单一事实源）。
 *
 * - public：CLI / MCP 可用（公开端点，现有 10 条）
 * - desktop：仅桌面宿主可用（管理端点：回环 + 宿主 token）
 * - ui：仅桌面 UI 交互，**不得**映射为任何 HTTP 路由（对话框、窗口、托盘、菜单）
 *
 * 本文件只声明边界；实际注册位置见 `src/server/routes.ts`。
 * 任何新增路由都必须先在这里归类，并由 `access-control.spec.ts` 守卫。
 */

export type AccessLevel = 'public' | 'desktop' | 'ui'

/** 仅桌面 UI 可用的 IPC 通道（与 IpcChannels 的值一一对应，不得有 HTTP 对应物） */
export const UI_ONLY_IPC_CHANNELS = [
  'project:open', // 打开一个新项目：文件对话框 + 新建窗口
  'dialog:open-file',
  'settings:open',
  'app:action',
  'window:get-state',
  'window:close-self',
  'window:list',
  'window:limit-hint',
  'window:limit-hint-take'
] as const

/** HTTP 上仅允许桌面宿主调用的路径（配置、文件、直连部署、服务管理、窗口镜像） */
export const DESKTOP_ONLY_PATH_PREFIXES = [
  '/server/',
  '/config',
  '/files/',
  '/deploy/direct',
  '/deploy/cancel',
  '/projects/view',
  '/projects/recent',
  '/targets/',
  '/mappings/',
  '/plan/preview',
  '/test-connection/draft',
  '/events',
  '/shutdown'
] as const

export function isDesktopOnlyPath (path: string): boolean {
  return DESKTOP_ONLY_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))
}

/** UI-only 通道不允许出现的路径片段（防止有人把“打开项目”做成 HTTP 接口） */
export const UI_ONLY_PATH_MARKERS = ['/open', '/window', '/dialog', '/settings', '/tray'] as const

export function looksLikeUiOnlyPath (path: string): boolean {
  return UI_ONLY_PATH_MARKERS.some((marker) => path.includes(marker))
}
