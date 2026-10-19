/**
 * targets 命令级用例（list / show / ping）（任务 8）。
 *
 * 走真实 TLS 服务端 + 真实处理器：既覆盖 CLI 契约，也覆盖服务端响应与凭据遮蔽。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeployTarget } from '../shared/types'
import { createServerHandlers } from '../main/services/server-handlers'
import { startHarness, type Harness } from './testing/harness'
import { stubServerDeps } from './testing/deps'

const targets: DeployTarget[] = [
  {
    id: 't1',
    name: 'my_dev',
    protocol: 'sftp',
    host: '10.0.0.5',
    port: 22,
    username: 'deployer',
    password: 'super-secret-password',
    privateKeyPath: 'C:/keys/id_rsa',
    passphrase: 'key-passphrase',
    mappings: [
      { id: 'm1', localPrefix: 'dist/', remotePath: '/opt/app/dist', description: '前端产物' },
      { id: 'm2', localPrefix: 'server/', remotePath: '/opt/app/server' }
    ]
  },
  {
    id: 't2',
    name: 'staging',
    protocol: 'local',
    host: 'D:/staging',
    port: 0,
    username: 'local',
    mappings: []
  }
]

let harness: Harness | null = null

async function boot(overrides: { testConnection?: (t: DeployTarget) => Promise<{ success: boolean; error?: string }> } = {}): Promise<Harness> {
  const handlers = createServerHandlers(
    stubServerDeps({
      loadTargets: async () => targets,
      testConnection: overrides.testConnection ?? (async () => ({ success: true }))
    })
  )
  harness = await startHarness(handlers)
  return harness
}

afterEach(async () => {
  if (harness) await harness.stop()
  harness = null
})

describe('targets', () => {
  it('AC-001 targets list 返回摘要且不含凭据字段', async () => {
    const h = await boot()
    const out = await h.run(['targets', 'list', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.ok).toBe(true)
    expect(out.json.data).toHaveLength(2)
    expect(out.json.data[0]).toMatchObject({ name: 'my_dev', protocol: 'sftp', host: '10.0.0.5', port: 22, mappingCount: 2 })
    expect(out.stdout + out.stderr).not.toMatch(/password|privateKey|passphrase|super-secret/i)
  })

  it('AC-001 targets show 返回详情与目录映射，同样不含凭据', async () => {
    const h = await boot()
    const out = await h.run(['targets', 'show', 'my_dev', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.mappings).toEqual([
      { localPrefix: 'dist/', remotePath: '/opt/app/dist', description: '前端产物' },
      { localPrefix: 'server/', remotePath: '/opt/app/server' }
    ])
    expect(out.json.meta).toMatchObject({ target: 'my_dev', origin: 'cli' })
    expect(out.stdout + out.stderr).not.toMatch(/password|privateKey|passphrase/i)
  })

  it('AC-001 人类可读输出不打印凭据', async () => {
    const h = await boot()
    const out = await h.run(['targets', 'list'])
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('my_dev')
    expect(out.stdout).not.toMatch(/super-secret/i)
  })

  it('AC-002 目标不存在返回 NO_TARGET 与退出码 4', async () => {
    const h = await boot()
    const out = await h.run(['targets', 'show', 'nope', '--json'])
    expect(out.exitCode).toBe(4)
    expect(out.json.error.code).toBe('NO_TARGET')
    expect(out.json.error.hint).toContain('targets list')
  })
})

describe('targets ping', () => {
  it('AC-003 可连接返回成功信封', async () => {
    const h = await boot()
    const out = await h.run(['targets', 'ping', 'my_dev', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data).toMatchObject({ reachable: true, protocol: 'sftp', host: '10.0.0.5' })
  })

  it('AC-003 复用既有连接实现：服务端拿到的是配置中的完整目标', async () => {
    const spy = vi.fn(async (_target: DeployTarget) => ({ success: true }))
    const h = await boot({ testConnection: spy })
    await h.run(['targets', 'ping', 'my_dev', '--json'])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatchObject({ name: 'my_dev', password: 'super-secret-password' })
  })

  it('AC-004 连接失败返回 CONNECT_FAILED 与退出码 3', async () => {
    const h = await boot({ testConnection: async () => ({ success: false, error: '认证失败' }) })
    const out = await h.run(['targets', 'ping', 'my_dev', '--json'])
    expect(out.exitCode).toBe(3)
    expect(out.json.error.code).toBe('CONNECT_FAILED')
    expect(out.json.error.message).toContain('认证失败')
  })

  it('AC-002 目标不存在返回 NO_TARGET 且不建立连接', async () => {
    const spy = vi.fn(async () => ({ success: true }))
    const h = await boot({ testConnection: spy })
    const out = await h.run(['targets', 'ping', 'nope', '--json'])
    expect(out.exitCode).toBe(4)
    expect(out.json.error.code).toBe('NO_TARGET')
    expect(spy).not.toHaveBeenCalled()
  })

  it('AC-014 缺少目标名在本地即为用法错误（不发请求）', async () => {
    const h = await boot()
    const out = await h.run(['targets', 'ping', '--json'])
    expect(out.exitCode).toBe(1)
    expect(out.json.error.code).toBe('USAGE')
  })
})