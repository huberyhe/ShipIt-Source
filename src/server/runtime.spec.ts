import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpClient } from '../shared/http-client'
import { createRuntime, type Runtime } from './runtime'

const TOKEN = '0123456789abcdef'
const dirs: string[] = []
const runtimes: Runtime[] = []

function setup (enabled: boolean): { rt: Runtime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shipit-runtime-'))
  dirs.push(dir)
  const configPath = join(dir, 'deploy-config.json')
  writeFileSync(configPath, JSON.stringify({
    server: { enabled, port: 0, bind: 'local', tokenMode: 'custom', token: TOKEN }
  }))
  const rt = createRuntime({ configPath, appVersion: '9.9.9', dataDir: dir })
  runtimes.push(rt)
  return { rt, dir }
}

function adminClient (rt: Runtime) {
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

describe('server/runtime', () => {
  it('管理端点始终启动；enabled=false 时 published=false 且公开端点不启动', async () => {
    const { rt } = setup(false)
    const started = await rt.startAdminListener()
    expect(started.listening).toBe(true)
    expect(rt.adminPort()).toBeGreaterThan(0)

    const res = await adminClient(rt).get('/status')
    expect(res.ok).toBe(true)
    if (!res.ok || !res.envelope.ok) throw new Error('status 应成功')
    const data = res.envelope.data as Record<string, unknown>
    expect(data.version).toBe('9.9.9')
    expect(data.published).toBe(false)
    expect(data.instanceId).toBe(rt.instanceId)

    await rt.syncPublicListener()
    expect(rt.published()).toBe(false)
    expect(rt.publicPort()).toBeNull()
  })

  it('enabled=true 时公开端点启动；公开端点不暴露管理路由', async () => {
    const { rt } = setup(true)
    await rt.startAdminListener()
    const pub = await rt.syncPublicListener()
    expect(pub.listening).toBe(true)
    expect(rt.published()).toBe(true)

    const pubClient = createHttpClient({
      endpoint: {
        host: '127.0.0.1',
        port: rt.publicPort()!,
        token: TOKEN,
        fingerprint: rt.publicFingerprint()!,
        protocolVersion: 1
      },
      client: 'cli'
    })

    const status = await pubClient.get('/status')
    expect(status.ok).toBe(true)

    const config = await pubClient.post('/config', {})
    expect(config.ok).toBe(true)
    if (config.ok) expect(config.envelope.ok).toBe(false)
  })

  it('force shutdown 停掉两个端点', async () => {
    const { rt } = setup(true)
    await rt.startAdminListener()
    await rt.syncPublicListener()
    await rt.shutdown('force', 0)
    expect(rt.adminPort()).toBeNull()
    expect(rt.publicPort()).toBeNull()
  })
})
