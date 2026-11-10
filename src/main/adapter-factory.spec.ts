import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdapter } from './adapter-factory'
import type { ServerHost } from './server-host'

const ENTRY = join(process.cwd(), 'dist-server/index.js')
const hosts: ServerHost[] = []
const dirs: string[] = []

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

describe('main/adapter-factory', () => {
  it('启动真实后端并返回 remote 适配器', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shipit-factory-'))
    dirs.push(dir)
    const configPath = join(dir, 'deploy-config.json')
    writeFileSync(configPath, JSON.stringify({
      server: { enabled: false, port: 0, bind: 'local', tokenMode: 'custom', token: '0123456789abcdef' }
    }))

    const { adapter, host } = await createAdapter({
      host: { entry: ENTRY, configPath, appVersion: '9.9.9', dataDir: dir, useNodeFork: true }
    })
    hosts.push(host)

    const status = (await adapter.serverStatus()) as Record<string, unknown>
    expect(status.instanceId).toBe(host.instanceId)
    expect(status.published).toBe(false)
  })
})
