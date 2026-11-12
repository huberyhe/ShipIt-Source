import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRevisionBridge, createServerHost, type ServerHost } from './server-host'
import { deployTargetSignature } from '../shared/deploy-signature'

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
    // 新契约：界面只给「选中的源路径」+「确认时的文件集合」，任务由服务端重算
    const res = await host.post('/deploy/direct', {
      windowId: 12345,
      files: ['a.txt'],
      projectRoot: projectDir,
      targetName: '本地',
      expectFiles: tasks.map((t: any) => t.relativePath)
    }, 60_000)
    off()

    expect(res.ok).toBe(true)
    // SSE 与 HTTP 响应是两条通道，最后一个进度事件可能晚一拍到达
    await new Promise((resolve) => setTimeout(resolve, 200))

    // 修复前：deploy.progress 没有 revision，被当成“旧快照”全部丢弃 → 进度条不动
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].windowId).toBe(12345)
    // 进度按“已完成文件数”报：开始时报 0/1（不再一开拍就 100%）
    expect(events[0].current).toBe(0)
    expect(events[0].total).toBe(1)
  })

  it('/deploy/direct 不再接受客户端指定的 localPath/remotePath；集合漂移按 PLAN_STALE 拒绝', async () => {
    const host = setup()
    await host.start()

    const projectDir = mkdtempSync(join(tmpdir(), 'shipit-proj2-'))
    const dstDir = mkdtempSync(join(tmpdir(), 'shipit-dst2-'))
    dirs.push(projectDir, dstDir)
    writeFileSync(join(projectDir, 'a.txt'), 'hello')

    const target = {
      id: 't2',
      name: '本地2',
      protocol: 'local',
      host: dstDir,
      port: 0,
      username: 'local',
      mappings: [{ id: 'm1', localPrefix: 'a.txt', remotePath: 'a.txt' }]
    }
    expect((await host.post('/targets/add', { target })).ok).toBe(true)

    // 客户端多塞一个 tasks：服务端必须忽略它，只按 files 重算
    const res = await host.post('/deploy/direct', {
      windowId: 1,
      files: ['a.txt'],
      projectRoot: projectDir,
      targetName: '本地2',
      expectFiles: ['a.txt'],
      tasks: [{ localPath: '/etc/passwd', remotePath: 'forged.txt', relativePath: 'forged.txt', size: 1 }]
    }, 60_000)
    expect(res.ok).toBe(true)
    // 伪造的远端路径不得出现（说明 tasks 没被采纳）
    expect(existsSync(join(dstDir, 'forged.txt'))).toBe(false)
    expect(existsSync(join(dstDir, 'a.txt'))).toBe(true)

    // 确认时看到的集合与重算结果不一致 → 拒绝，且不产生新文件
    const stale = await host.post('/deploy/direct', {
      windowId: 1,
      files: ['a.txt'],
      projectRoot: projectDir,
      targetName: '本地2',
      expectFiles: ['a.txt', 'b.txt']
    }, 60_000)
    expect(stale.ok).toBe(true)
    if (stale.ok) {
      expect(stale.envelope.ok).toBe(false)
      if (!stale.envelope.ok) expect(stale.envelope.error.code).toBe('PLAN_STALE')
    }

    // 缺项目根 → 直接拒绝（策略 D′：不接受“跟随焦点”）
    const noRoot = await host.post('/deploy/direct', { windowId: 1, files: ['a.txt'], targetName: '本地2' }, 60_000)
    if (noRoot.ok) {
      expect(noRoot.envelope.ok).toBe(false)
      if (!noRoot.envelope.ok) expect(noRoot.envelope.error.code).toBe('USAGE')
    }
  })

  it('/deploy/direct 目标配置在确认后被改过 → PLAN_STALE（不把文件发到新主机）', async () => {
    const host = setup()
    await host.start()

    const projectDir = mkdtempSync(join(tmpdir(), 'shipit-proj3-'))
    const dstA = mkdtempSync(join(tmpdir(), 'shipit-dstA-'))
    const dstB = mkdtempSync(join(tmpdir(), 'shipit-dstB-'))
    dirs.push(projectDir, dstA, dstB)
    writeFileSync(join(projectDir, 'a.txt'), 'hello')

    const target = {
      id: 't3',
      name: '本地3',
      protocol: 'local',
      host: dstA,
      port: 0,
      username: 'local',
      mappings: [{ id: 'm1', localPrefix: 'a.txt', remotePath: 'a.txt' }]
    }
    expect((await host.post('/targets/add', { target })).ok).toBe(true)
    // 确认时用户看到的那个目标（弹窗展示的草稿快照）
    const signatureAtConfirm = deployTargetSignature(target)

    // 另一个窗口把目标改到了另一个目录并保存
    expect((await host.post('/targets/update', { id: 't3', updates: { host: dstB } })).ok).toBe(true)

    const res = await host.post('/deploy/direct', {
      windowId: 1,
      files: ['a.txt'],
      projectRoot: projectDir,
      targetName: '本地3',
      expectFiles: ['a.txt'],
      targetSignature: signatureAtConfirm
    }, 60_000)

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.envelope.ok).toBe(false)
      if (!res.envelope.ok) expect(res.envelope.error.code).toBe('PLAN_STALE')
    }
    // 两个目标目录都不应有任何新文件（拒绝了就不发）
    expect(existsSync(join(dstB, 'a.txt'))).toBe(false)
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
