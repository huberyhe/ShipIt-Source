import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRemoteAdapter } from './ipc-adapter'
import { createServerHost, type ServerHost } from './server-host'

const ENTRY = join(process.cwd(), 'dist-server/index.js')
const hosts: ServerHost[] = []
const dirs: string[] = []

function setup (): { host: ServerHost; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shipit-adapter-e2e-'))
  dirs.push(dir)
  const configPath = join(dir, 'deploy-config.json')
  writeFileSync(configPath, JSON.stringify({
    server: { enabled: false, port: 0, bind: 'local', tokenMode: 'custom', token: '0123456789abcdef' },
    deploymentTargets: [{ id: 't1', name: 'dev', protocol: 'local', host: dir, port: 0, username: '', mappings: [] }]
  }))
  const host = createServerHost({ entry: ENTRY, configPath, appVersion: '9.9.9', dataDir: dir, useNodeFork: true })
  hosts.push(host)
  return { host, dir }
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    try {
      await host.forceStop()
    } catch {
      // 已退出
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('remote adapter over real backend', () => {
  it('经管理端点读取状态与配置（脱敏后的目标）', async () => {
    const { host } = setup()
    await host.start()

    const adapter = createRemoteAdapter({
      get: (path, query) => host.get(path, query),
      post: (path, body) => host.post(path, body)
    })

    const status = (await adapter.serverStatus()) as Record<string, unknown>
    expect(status.instanceId).toBe(host.instanceId)
    expect(status.published).toBe(false)

    const config = (await adapter.configLoad()) as { deploymentTargets: Array<Record<string, unknown>> }
    expect(config.deploymentTargets).toHaveLength(1)
    expect(config.deploymentTargets[0].name).toBe('dev')
    expect(config.deploymentTargets[0].password).toBeUndefined()

    const targets = (await adapter.targetList()) as unknown[]
    expect(targets).toHaveLength(1)
  })
})
