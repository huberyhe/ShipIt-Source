import { existsSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnServer, type ServerProcess } from './testing/harness'

const processes: ServerProcess[] = []

afterEach(async () => {
  for (const proc of processes.splice(0)) await proc.close().catch(() => undefined)
})

describe('server lifecycle', () => {
  it('ready 含 instanceId 与管理端点；/status 可用', async () => {
    const proc = await spawnServer({ appVersion: '9.9.9' })
    processes.push(proc)

    expect(proc.ready.type).toBe('ready')
    expect(proc.ready.instanceId).toHaveLength(16)
    expect(proc.ready.admin.port).toBeGreaterThan(0)
    expect(proc.ready.admin.token).toHaveLength(32)
    expect(proc.ready.admin.fingerprint).toHaveLength(64)
    expect(proc.ready.version).toBe('9.9.9')

    const status = await proc.client.get('/status')
    expect(status.ok).toBe(true)
    if (!status.ok || !status.envelope.ok) throw new Error('status 应成功')
    const data = status.envelope.data as Record<string, unknown>
    expect(data.instanceId).toBe(proc.ready.instanceId)
    expect(data.published).toBe(false)
  })

  it('enabled=false 时不发布：无 server.json，公开端点不监听', async () => {
    const proc = await spawnServer({ enabled: false })
    processes.push(proc)

    // 等公开端点同步完成（state 消息到达）
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(existsSync(join(proc.dataDir, 'server.json'))).toBe(false)
    const last = proc.states[proc.states.length - 1]
    expect(last?.data?.public?.listening).toBe(false)
  })

  it('父进程消失后 6 秒内自行退出', async () => {
    const proc = await spawnServer({ parentPid: 999_999 })
    processes.push(proc)
    const code = await proc.waitExit(6000)
    expect(code).toBe(0)
  })
})
