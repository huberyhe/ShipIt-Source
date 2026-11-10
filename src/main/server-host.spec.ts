import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRevisionBridge, createServerHost, type ServerHost } from './server-host'

const ENTRY = join(process.cwd(), 'dist-server/index.js')
const hosts: ServerHost[] = []
const dirs: string[] = []

function setup (enabled = false): ServerHost {
  const dir = mkdtempSync(join(tmpdir(), 'shipit-host-'))
  dirs.push(dir)
  const configPath = join(dir, 'deploy-config.json')
  writeFileSync(configPath, JSON.stringify({
    server: { enabled, port: 0, bind: 'local', tokenMode: 'custom', token: '0123456789abcdef' }
  }))
  const host = createServerHost({ entry: ENTRY, configPath, appVersion: '9.9.9', dataDir: dir, useNodeFork: true })
  hosts.push(host)
  return host
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

describe('main/server-host', () => {
  it('启动后拿到实例与管理端点，可调用 /status', async () => {
    const host = setup()
    const ready = await host.start()
    expect(ready.instanceId).toHaveLength(16)
    expect(host.instanceId).toBe(ready.instanceId)

    const status = await host.get('/status')
    expect(status.ok).toBe(true)
    if (!status.ok || !status.envelope.ok) throw new Error('status 应成功')
    const data = status.envelope.data as Record<string, unknown>
    expect(data.published).toBe(false)
    expect(data.instanceId).toBe(ready.instanceId)
  })

  it('后端被杀后请求返回 BACKEND_UNAVAILABLE（不假成功）', async () => {
    const host = setup()
    await host.start()
    host.child!.kill()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const result = await host.get('/status')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('BACKEND_UNAVAILABLE')
  })

  it('prepareStop 空闲时返回 drained', async () => {
    const host = setup()
    await host.start()
    const result = await host.prepareStop(1000)
    expect(result.ok).toBe(true)
  })

  it('直连上传的 deploy.progress 实时到达（增量事件不参与 revision 门控）', async () => {
    const host = setup()
    await host.start()

    // 本地目录目标：无需网络，上传可控且快速
    const projectDir = mkdtempSync(join(tmpdir(), 'shipit-proj-'))
    const dstDir = mkdtempSync(join(tmpdir(), 'shipit-dst-'))
    dirs.push(projectDir, dstDir)
    writeFileSync(join(projectDir, 'a.txt'), 'hello')

    const target = {
      id: 't1',
      name: '本地',
      protocol: 'local',
      host: dstDir,
      port: 0,
      username: 'local',
      mappings: [{ id: 'm1', localPrefix: 'a.txt', remotePath: 'a.txt' }]
    }
    // /deploy/direct 按 name 解析目标，所以先写进配置
    expect((await host.post('/targets/add', { target })).ok).toBe(true)

    const plan = await host.post('/plan/preview', { files: ['a.txt'], projectRoot: projectDir, target })
    expect(plan.ok).toBe(true)
    if (!plan.ok || !plan.envelope.ok) throw new Error('plan 应成功')
    const tasks = (plan.envelope.data as { tasks: unknown[] }).tasks
    expect(tasks.length).toBeGreaterThan(0)

    const events: Array<{ windowId?: number; current: number; total: number; file: string }> = []
    const off = host.on('deploy.progress', (data) => events.push(data as (typeof events)[number]))
    const res = await host.post('/deploy/direct', { windowId: 12345, tasks, targetName: '本地' }, 60_000)
    off()

    expect(res.ok).toBe(true)
    // 修复前：deploy.progress 没有 revision，被当成“旧快照”全部丢弃 → 进度条不动
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].windowId).toBe(12345)
    expect(events[events.length - 1].current).toBe(events[events.length - 1].total)
  })

  it('主动停止后不再自动重启（R1）', async () => {
    const host = setup()
    await host.start()
    const firstPid = host.child!.pid

    // prepareStop 属主动停止：后端退出是预期，不能被当成崩溃再 spawn 一个
    await host.prepareStop(1000)
    await new Promise((resolve) => setTimeout(resolve, 1500))

    expect(host.child!.pid).toBe(firstPid)
    expect(host.child!.exitCode).not.toBeNull()
  })

  it('revision 转换：旧实例事件丢弃，新实例从当前计数继续单调', () => {
    const bridge = createRevisionBridge()
    bridge.setInstance('i1')
    expect(bridge.translate('i1', 1)).toEqual({ accepted: true, revision: 1 })
    expect(bridge.translate('i1', 2)).toEqual({ accepted: true, revision: 2 })

    bridge.setInstance('i2')
    expect(bridge.translate('i1', 3)).toEqual({ accepted: false, revision: 2 })
    expect(bridge.translate('i2', 1)).toEqual({ accepted: true, revision: 3 })
    expect(bridge.snapshot()).toEqual({ instanceId: 'i2', revision: 3 })
  })
})
