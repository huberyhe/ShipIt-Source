import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpClient } from '../shared/http-client'
import { createEventHub } from './events'
import { buildAdminHandlers } from './route-handlers'
import { createRuntime, type Runtime } from './runtime'

const TOKEN = '0123456789abcdef'
const dirs: string[] = []
const runtimes: Runtime[] = []

function setup (enabled = false) {
  const dir = mkdtempSync(join(tmpdir(), 'shipit-admin-'))
  dirs.push(dir)
  const configPath = join(dir, 'deploy-config.json')
  writeFileSync(configPath, JSON.stringify({
    server: { enabled, port: 0, bind: 'local', tokenMode: 'custom', token: TOKEN }
  }))
  const rt = createRuntime({ configPath, appVersion: '9.9.9', dataDir: dir })
  const hub = createEventHub()
  rt.onEvent((event, data) => hub.emit(event, data))
  rt.setExtraHandlers(buildAdminHandlers(rt, hub))
  runtimes.push(rt)
  return { rt, hub }
}

function admin (rt: Runtime) {
  return createHttpClient({
    endpoint: {
      host: '127.0.0.1',
      port: rt.adminPort()!,
      token: rt.adminToken(),
      fingerprint: rt.adminFingerprint()!,
      protocolVersion: 1
    },
    client: 'cli'
  })
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.shutdown('force', 0).catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('server/admin routes', () => {
  it('目标写入：secrets 生效但响应只返回 hasPassword', async () => {
    const { rt } = setup()
    await rt.startAdminListener()

    const add = await admin(rt).post('/targets/add', {
      target: { name: 'dev', protocol: 'local', host: '/tmp', mappings: [] },
      secrets: { password: { op: 'set', value: 'p@ss' } }
    })
    expect(add.ok && add.envelope.ok).toBe(true)

    const detail = await admin(rt).get('/targets/detail', { name: 'dev' })
    expect(detail.ok).toBe(true)
    if (!detail.ok || !detail.envelope.ok) throw new Error('detail 应成功')
    const view = detail.envelope.data as Record<string, unknown>
    expect(view.hasPassword).toBe(true)
    expect(view.password).toBeUndefined()

    // 只改名称：keep 不应清掉密码
    const list = await admin(rt).get('/config')
    if (!list.ok || !list.envelope.ok) throw new Error('config 应成功')
    const target = (list.envelope.data as any).deploymentTargets[0]
    await admin(rt).post('/targets/update', {
      id: target.id,
      updates: { name: 'dev2' },
      secrets: { password: { op: 'keep' } }
    })
    const detail2 = await admin(rt).get('/targets/detail', { name: 'dev2' })
    if (!detail2.ok || !detail2.envelope.ok) throw new Error('detail2 应成功')
    expect((detail2.envelope.data as any).hasPassword).toBe(true)

    // 显式清除
    await admin(rt).post('/targets/update', {
      id: target.id,
      updates: {},
      secrets: { password: { op: 'clear' } }
    })
    const detail3 = await admin(rt).get('/targets/detail', { name: 'dev2' })
    if (!detail3.ok || !detail3.envelope.ok) throw new Error('detail3 应成功')
    expect((detail3.envelope.data as any).hasPassword).toBe(false)
  })

  it('配置写入会广播 config.changed；公开端点访问管理路由 404', async () => {
    const { rt, hub } = setup(true)
    const events: string[] = []
    hub.attach(
      { on: () => undefined } as any,
      { writeHead: () => undefined, write: (chunk: string) => { const m = /^event: (.+)$/m.exec(chunk); if (m) events.push(m[1]) } } as any
    )

    await rt.startAdminListener()
    await rt.syncPublicListener()

    const save = await admin(rt).post('/config', { config: { theme: 'dark' } })
    expect(save.ok && save.envelope.ok).toBe(true)
    expect(events).toContain('config.changed')

    const pub = createHttpClient({
      endpoint: {
        host: '127.0.0.1',
        port: rt.publicPort()!,
        token: TOKEN,
        fingerprint: rt.publicFingerprint()!,
        protocolVersion: 1
      },
      client: 'cli'
    })
    const forbidden = await pub.post('/targets/add', {})
    expect(forbidden.ok).toBe(true)
    if (forbidden.ok) expect(forbidden.envelope.ok).toBe(false)
  })
})
