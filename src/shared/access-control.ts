/**
 * 访问权限分级（单一事实源）。
 *
 * - public：CLI / MCP 可用（公开端点，现有 10 条）
 * - desktop：仅桌面宿主可用（管理端点：回环 + 宿主 token）
 * - ui：仅桌面 UI 交互，**不得**映射为任何 HTTP 路由（对话框、窗口、托盘、菜单）
 *
 * 本文件是**静态守卫 + 文档**，不参与运行时校验：
 * - 运行时的真实隔离由 `src/server/runtime.ts` 决定给哪个 listener 注册哪批路由（
 *   公开端点根本注册不到管理路由，`runtime.spec` / `admin-routes.spec` 有断言）；
 * - 这里的作用是让「新增路由必须归类」可被 `access-control.spec.ts` 检查，
 *   并防止把 UI-only 能力做成 HTTP 接口。
 * 若将来要在请求入口再加一层方法级鉴权，本文件就是白名单来源。
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
  // Git 明细：同前缀下还有公开的 /git/status、/git/log、/git/branches，
  // 因此不能用 '/git/' 前缀，只能逐条列举（反向断言会盯住漏项）
  '/git/check-repo',
  '/git/authors',
  '/git/diff',
  '/git/commit-files',
  '/git/status-full',
  '/git/log-full',
  '/git/branches-full',
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
