import { describe, expect, it } from 'vitest'
import { IpcChannels } from '../shared/ipc-channels'
import {
  DESKTOP_ONLY_PATH_PREFIXES,
  UI_ONLY_IPC_CHANNELS,
  isDesktopOnlyPath,
  looksLikeUiOnlyPath
} from '../shared/access-control'
import { ADMIN_ROUTES, PUBLIC_ROUTES } from './routes'

const keysOf = (routes: readonly { method: string; path: string }[]): string[] =>
  routes.map((route) => `${route.method} ${route.path}`)

describe('权限边界（公开 / 桌面 / UI-only）', () => {
  it('公开端点不含任何桌面管理能力', () => {
    const leaked = PUBLIC_ROUTES.filter((route) => isDesktopOnlyPath(route.path))
    expect(leaked).toEqual([])
  })

  it('配置本地服务只在管理端点（CLI/MCP 无法调用）', () => {
    const admin = keysOf(ADMIN_ROUTES)
    expect(admin).toContain('GET /server/config')
    expect(admin).toContain('POST /server/config')
    expect(admin).toContain('POST /server/token')
    expect(admin).toContain('POST /server/export')

    const publicKeys = keysOf(PUBLIC_ROUTES)
    expect(publicKeys.some((key) => key.includes('/server/'))).toBe(false)
  })

  it('打开新项目是 UI-only：通道存在，且没有任何 HTTP 路由承载它', () => {
    const channelValues = new Set(Object.values(IpcChannels))
    for (const channel of UI_ONLY_IPC_CHANNELS) {
      expect(channelValues.has(channel)).toBe(true)
    }

    const allPaths = ADMIN_ROUTES.map((route) => route.path)
    expect(allPaths.some((path) => looksLikeUiOnlyPath(path))).toBe(false)
  })

  it('桌面专属前缀都有实际路由（声明不悬空）', () => {
    const allPaths = ADMIN_ROUTES.map((route) => route.path)
    // /events、/shutdown 等完整路径直接比对；前缀型允许以子路径存在
    for (const prefix of DESKTOP_ONLY_PATH_PREFIXES) {
      const hit = allPaths.some((path) => path === prefix || path.startsWith(prefix))
      expect(hit, `desktop-only 前缀没有对应路由：${prefix}`).toBe(true)
    }
  })

  it('每条管理路由都被桌面专属前缀覆盖（反向断言，防漏项）', () => {
    // /projects 与方法相关：GET 属公开（列已打开项目窗口），POST 属桌面（新建/打开）。
    // 路径前缀无法表达方法差异，这里显式例外；新增「同路径多方法」的路由时请同步维护这张表。
    // 只看「真正新增的桌面专属路由」：ADMIN_ROUTES = PUBLIC_ROUTES + 桌面专属，
    // 公开那部分本来就不该被桌面前缀覆盖。
    const METHOD_EXCEPTIONS = new Set(['POST /projects'])
    const publicKeys = new Set(keysOf(PUBLIC_ROUTES))
    const uncovered = ADMIN_ROUTES.filter((route) => !publicKeys.has(`${route.method} ${route.path}`)).filter(
      (route) => !isDesktopOnlyPath(route.path) && !METHOD_EXCEPTIONS.has(`${route.method} ${route.path}`)
    )
    expect(uncovered.map((route) => `${route.method} ${route.path}`)).toEqual([])
  })

  it('桌面专属路由不与公开路由重叠（管理端点 = 公开 + 桌面专属）', () => {
    const publicKeys = new Set(keysOf(PUBLIC_ROUTES))
    const desktopOnly = ADMIN_ROUTES.filter((route) => isDesktopOnlyPath(route.path))
    const overlaps = keysOf(desktopOnly).filter((key) => publicKeys.has(key))
    expect(overlaps).toEqual([])
  })
})
