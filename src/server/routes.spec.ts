import { describe, expect, it } from 'vitest'
import { ROUTES } from '../main/services/local-server'
import { ADMIN_ROUTES, PUBLIC_ROUTES } from './routes'

describe('server/routes', () => {
  it('公开端点 = 现有 10 条（CON-1：一字不改）', () => {
    expect(PUBLIC_ROUTES).toEqual(ROUTES)
    expect(PUBLIC_ROUTES).toHaveLength(10)
  })

  it('管理端点 = 公开 10 条 + 35 条桌面专属（含 3 条 -full 视图）', () => {
    expect(ADMIN_ROUTES).toHaveLength(45)
    for (const route of PUBLIC_ROUTES) {
      expect(ADMIN_ROUTES).toContainEqual(route)
    }
  })

  it('不使用 /internal 前缀（F5：避免命名分裂）', () => {
    expect(ADMIN_ROUTES.every((route) => !route.path.startsWith('/internal'))).toBe(true)
  })

  it('method + path 唯一（避免重复注册）', () => {
    const keys = ADMIN_ROUTES.map((route) => `${route.method} ${route.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('SSE 与 shutdown 只在管理端点，且 SSE 标记为 raw', () => {
    expect(PUBLIC_ROUTES.some((route) => route.path === '/events')).toBe(false)
    expect(PUBLIC_ROUTES.some((route) => route.path === '/shutdown')).toBe(false)
    expect(ADMIN_ROUTES.find((route) => route.path === '/events')?.raw).toBe(true)
  })

  it('公开端点不含配置写入、文件与桌面直连', () => {
    const forbidden = ['/config', '/targets/add', '/files/tree', '/deploy/direct', '/plan/preview', '/test-connection/draft']
    expect(PUBLIC_ROUTES.some((route) => forbidden.includes(route.path))).toBe(false)
  })

  it('草稿测试与正式连接测试是两条不同路由', () => {
    expect(PUBLIC_ROUTES.some((route) => route.path === '/test-connection')).toBe(true)
    expect(ADMIN_ROUTES.some((route) => route.path === '/test-connection/draft')).toBe(true)
  })
})
