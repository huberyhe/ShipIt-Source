import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalServer, type LocalServer } from '../main/services/local-server'
import { defaultServerConfig } from '../main/services/server-config'
import { okEnvelope } from './cli-contract'
import { createHttpClient } from './http-client'

const servers: LocalServer[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('http-client 逐请求超时（F3）', () => {
  it('postWithTimeout 覆盖默认值；普通 post 仍等默认超时', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shipit-timeout-'))
    dirs.push(dir)
    const token = '0123456789abcdef'

    const server = createLocalServer({
      config: { ...defaultServerConfig(), enabled: true, port: 0, tokenMode: 'custom', token },
      dataDir: dir,
      handlers: {
        plan: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300))
          return okEnvelope({})
        }
      }
    })
    servers.push(server)

    const started = await server.start()
    if (!started.listening) throw new Error('测试服务端启动失败')

    const client = createHttpClient({
      endpoint: {
        host: '127.0.0.1',
        port: started.port,
        token,
        fingerprint: started.fingerprint,
        protocolVersion: 1
      },
      client: 'cli'
    })

    const timedOut = await client.postWithTimeout('/plan', {}, 60)
    expect(timedOut.ok).toBe(false)
    if (!timedOut.ok) expect(timedOut.error.message).toContain('超时')

    const normal = await client.post('/plan', {})
    expect(normal.ok).toBe(true)
  })
})
