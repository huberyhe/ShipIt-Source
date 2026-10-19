import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from './config-store'
import type { DeployTarget } from '../../shared/types'

/**
 * 回归背景（P2）：
 * `deploy-config.json` 是**共享文件** —— 除本 store 的 recentProjects / deploymentTargets 外，
 * 服务端配置模块还会把 `server` 块写进同一个文件。
 * 曾经的实现里 `save()` 直接写本 store 的快照、且 4 个映射/最近项目变更方法都不先 `load()`，
 * 结果：保存目录映射或最近项目会把 `server`（含令牌与监听配置）整块抹掉，甚至丢掉其它既有字段。
 */

const SERVER = { enabled: true, bind: 'local', port: 47820, token: 'tok-0123456789abcdef' }

let dir: string
let file: string
let store: ConfigStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipit-config-'))
  file = join(dir, 'deploy-config.json')
  store = new ConfigStore(file)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>

const seed = (data: unknown): void => {
  writeFileSync(file, JSON.stringify(data), 'utf-8')
}

const target = (id = 't1'): DeployTarget => ({
  id,
  name: 'dev',
  protocol: 'local',
  host: 'D:/dev',
  port: 0,
  username: 'local',
  mappings: []
})

describe('config-store', () => {
  it('新增目标不会抹掉同一文件里的服务端配置块（P2 回归）', async () => {
    seed({ server: SERVER, recentProjects: ['D:/p1'], deploymentTargets: [] })

    await store.addTarget(target())

    const saved = onDisk()
    expect(saved.server).toEqual(SERVER)
    expect(saved.recentProjects).toEqual(['D:/p1'])
    expect(saved.deploymentTargets).toHaveLength(1)
  })

  it('新增最近项目不会抹掉服务端配置块与既有目标（P2 回归）', async () => {
    seed({ server: SERVER, deploymentTargets: [target()] })

    // 修复前：该方法不 load()，用的是构造时的空快照 → server 与 deploymentTargets 一起被抹掉
    await store.addRecentProject('D:/work/app')

    const saved = onDisk()
    expect(saved.server).toEqual(SERVER)
    expect(saved.deploymentTargets).toHaveLength(1)
    expect(saved.recentProjects).toEqual(['D:/work/app'])
  })

  it('不先 load 直接加目录映射，也能写进既有的目标（P2 回归）', async () => {
    seed({ server: SERVER, deploymentTargets: [target()] })

    await store.addMapping('t1', { id: 'm1', localPrefix: 'dist/', remotePath: '/opt/dist' })

    const saved = onDisk()
    expect(saved.server).toEqual(SERVER)
    const targets = saved.deploymentTargets as DeployTarget[]
    expect(targets[0].mappings).toHaveLength(1)
    expect(targets[0].mappings[0]).toMatchObject({ localPrefix: 'dist/', remotePath: '/opt/dist' })
  })

  it('渲染层整配置保存不会抹掉磁盘上的服务端配置块（P2 回归）', async () => {
    seed({ server: SERVER })

    // 渲染层快照可能不含 server（例如在服务端配置写入之前读取的）
    store.replace({ recentProjects: ['D:/p2'], deploymentTargets: [] })
    await store.save()

    const saved = onDisk()
    expect(saved.server).toEqual(SERVER)
    expect(saved.recentProjects).toEqual(['D:/p2'])
  })

  it('缺字段的部分配置不崩：load 补齐数组、后续变更可用', async () => {
    seed({ server: SERVER })

    const cfg = await store.load()
    expect(cfg.recentProjects).toEqual([])
    expect(cfg.deploymentTargets).toEqual([])

    await store.addRecentProject('D:/y')
    expect(onDisk().server).toEqual(SERVER)
  })

  it('文件不存在时返回默认配置，并能落盘创建', async () => {
    const cfg = await store.load()
    expect(cfg).toMatchObject({ recentProjects: [], deploymentTargets: [] })

    await store.addTarget(target('t9'))
    expect((onDisk().deploymentTargets as DeployTarget[])[0].id).toBe('t9')
  })

  it('删除当前目标时同步清空 currentTargetId', async () => {
    seed({ currentTargetId: 't1', deploymentTargets: [target('t1')] })

    await store.removeTarget('t1')

    const saved = onDisk()
    expect(saved.currentTargetId).toBeUndefined()
    expect(saved.deploymentTargets).toEqual([])
  })

  it('映射更新与删除只动目标内部，不丢其它字段', async () => {
    seed({ server: SERVER, deploymentTargets: [{ ...target(), mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/opt/dist' }] }] })

    await store.updateMapping('t1', 'm1', { remotePath: '/srv/dist' })
    let targets = onDisk().deploymentTargets as DeployTarget[]
    expect(targets[0].mappings[0].remotePath).toBe('/srv/dist')

    await store.removeMapping('t1', 'm1')
    targets = onDisk().deploymentTargets as DeployTarget[]
    expect(targets[0].mappings).toEqual([])
    expect(onDisk().server).toEqual(SERVER)
  })
})

describe('按项目记忆的界面状态（多窗口视图状态持久化）', () => {
  it('保存后可读回；只覆盖传入字段（合并语义）', async () => {
    await store.saveProjectViewState('D:/work/app', { activeView: 'gitlog' })
    await store.saveProjectViewState('D:/work/app', { logPanelExpanded: true, gitLogBranch: 'main' })
    const state = await store.getProjectViewState('D:/work/app')
    expect(state).toEqual({ activeView: 'gitlog', logPanelExpanded: true, gitLogBranch: 'main' })
  })

  it('路径大小写与分隔符差异视为同一项目（键归一化）', async () => {
    await store.saveProjectViewState('D:\\Work\\App\\', { activeView: 'gitchanges' })
    expect(await store.getProjectViewState('d:/work/app')).toEqual({ activeView: 'gitchanges' })
  })

  it('未知项目返回 null；保存视图状态不会抹掉 server 块', async () => {
    expect(await store.getProjectViewState('D:/nope')).toBeNull()
    writeFileSync(file, JSON.stringify({ server: SERVER, recentProjects: [] }), 'utf-8')
    await store.saveProjectViewState('D:/work/app', { activeView: 'filetree' })
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk.server).toEqual(SERVER)
    expect(onDisk.projectViewState['d:/work/app']).toEqual({ activeView: 'filetree' })
  })
})

describe('P1-3 并发写不丢更新 / 不回滚他人字段（共享配置文件）', () => {
  it('切主题时不得把别的写者刚更新的 server 块回滚', async () => {
    // ① A 窗口读到快照（此时 server.enabled = true）
    writeFileSync(file, JSON.stringify({ server: SERVER, recentProjects: [] }), 'utf-8')
    await store.load()

    // ② 另一个写者（server-config）把 server 块更新成 enabled=false
    const updated = { ...SERVER, enabled: false, port: 47821 }
    writeFileSync(file, JSON.stringify({ server: updated, recentProjects: [] }), 'utf-8')

    // ③ A 窗口改主题并保存（用的是 ①② 之间读到的旧快照）
    store.replace({ recentProjects: [], deploymentTargets: [], theme: 'light' })
    await store.save()

    // 断言：server 块保持"别人刚写的值"，没有被 A 的旧快照覆盖
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as { server: { enabled: boolean; port: number }; theme?: string }
    expect(onDisk.server.enabled).toBe(false)
    expect(onDisk.server.port).toBe(47821)
    // 而 A 自己的改动必须落盘
    expect(onDisk.theme).toBe('light')
  })

  it('replace() 只接受本 store 独占的键：渲染层送来 server 块也不会写盘', async () => {
    writeFileSync(file, JSON.stringify({ server: SERVER, recentProjects: [] }), 'utf-8')
    await store.load()
    store.replace({
      recentProjects: ['D:/a'],
      deploymentTargets: [],
      // 渲染层若是旧版本/被构造过，可能带上 server：必须被忽略
      server: { enabled: false, bind: 'local', port: 1, tokenMode: 'custom', token: 'x'.repeat(16) }
    } as never)
    await store.save()

    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as { server?: unknown; recentProjects?: string[] }
    expect(onDisk.server).toEqual(SERVER)
    expect(onDisk.recentProjects).toEqual(['D:/a'])
  })

  it('load() 不把 server 块留在内存快照里（避免它有机会被回写）', async () => {
    writeFileSync(file, JSON.stringify({ server: SERVER, recentProjects: [] }), 'utf-8')
    const loaded = await store.load()
    expect((loaded as unknown as Record<string, unknown>).server).toBeUndefined()
  })
})

describe('P1-3 写入串行化（同一文件的两个写者不交错）', () => {
  it('ConfigStore 与 server-config 并发写：两边改动都保住（共享写锁生效）', async () => {
    writeFileSync(file, JSON.stringify({ server: SERVER, recentProjects: [] }), 'utf-8')
    await store.load()

    // 同时发起：A 写主题/最近项目，B 改服务端端口（真实场景：两个窗口几乎同时点保存）
    const { saveServerConfig } = await import('./server-config')
    await Promise.all([
      (async () => {
        store.replace({ recentProjects: ['D:/a'], deploymentTargets: [], theme: 'dark' })
        await store.save()
      })(),
      saveServerConfig(file, { port: 47821 })
    ])

    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as {
      server: { port: number; enabled: boolean }
      theme?: string
      recentProjects: string[]
    }
    // B 的改动在
    expect(onDisk.server.port).toBe(47821)
    expect(onDisk.server.enabled).toBe(true)
    // A 的改动也在（没有被 B 的整份读改写覆盖）
    expect(onDisk.theme).toBe('dark')
    expect(onDisk.recentProjects).toEqual(['D:/a'])
  })
})

describe('currentTargetId 单字段保存（patchOwned）', () => {
  it('未先 load 也能安全保存单字段：不得把 targets/recentProjects 写成空', async () => {
    // 磁盘上已有内容；store 是"新建且未 load"的（模拟渲染层只发一个字段的场景）
    writeFileSync(file, JSON.stringify({ server: SERVER, recentProjects: ['D:/a'], deploymentTargets: [{ id: 't1', name: 'x' }] }), 'utf-8')
    const fresh = new ConfigStore(file)
    await fresh.patchOwned({ currentTargetId: 't1' })

    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as {
      currentTargetId?: string
      recentProjects: string[]
      deploymentTargets: unknown[]
      server: unknown
    }
    expect(onDisk.currentTargetId).toBe('t1')
    expect(onDisk.recentProjects).toEqual(['D:/a'])
    expect(onDisk.deploymentTargets).toEqual([{ id: 't1', name: 'x' }])
    expect(onDisk.server).toEqual(SERVER)
  })

  it('P2-7 并发编辑不丢更新：两个同时 addTarget 都要落盘', async () => {
    seed({ server: SERVER, deploymentTargets: [] })

    // 修复前：load() 与 save() 之间不在锁里，后写者用自己那份旧快照覆盖前者
    await Promise.all([store.addTarget(target('t1')), store.addTarget(target('t2'))])

    const saved = onDisk() as { deploymentTargets: Array<{ id: string }>; server: unknown }
    expect(saved.deploymentTargets.map((t) => t.id).sort()).toEqual(['t1', 't2'])
    expect(saved.server).toEqual(SERVER)
  })

  it('P2-7 并发写不同项目的界面状态：两者都保留', async () => {
    seed({ server: SERVER, deploymentTargets: [] })

    await Promise.all([
      store.saveProjectViewState('D:/a', { view: 'filetree' } as never),
      store.saveProjectViewState('D:/b', { view: 'gitlog' } as never)
    ])

    const saved = onDisk() as { projectViewState?: Record<string, { view?: string }> }
    const keys = Object.keys(saved.projectViewState ?? {}).map((k) => k.toLowerCase())
    expect(keys).toHaveLength(2)
  })

  it('patchOwned 不触碰未传入的独占键', async () => {
    writeFileSync(file, JSON.stringify({ theme: 'dark', recentProjects: ['D:/a'] }), 'utf-8')
    const fresh = new ConfigStore(file)
    await fresh.patchOwned({ currentTargetId: 't9' })
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as { theme?: string }
    expect(onDisk.theme).toBe('dark')
  })
})
