import { app } from 'electron'
import { join } from 'path'
import type { AppConfig, DeployTarget, DirectoryMapping, ProjectViewState } from '../../shared/types'
import { normalizeProjectPath } from '../window-manager'
import { readJsonObject, withConfigWriteLock, writeJsonAtomic } from './config-file'

export type { AppConfig, DeployTarget, DirectoryMapping }

/** 本 store 独占的配置键：以内存为准（包括被清空成 undefined 的情况） */
const OWNED_KEYS = ['recentProjects', 'deploymentTargets', 'currentTargetId', 'theme', 'projectViewState'] as const satisfies ReadonlyArray<keyof AppConfig>

export class ConfigStore {
  private configPath: string
  private data: AppConfig

  constructor(configPath?: string) {
    this.configPath = configPath ?? join(app.getPath('userData'), 'deploy-config.json')
    this.data = {
      recentProjects: [],
      deploymentTargets: []
    }
  }

  /** 当前使用的配置文件路径（供服务端配置读写复用同一文件） */
  get path(): string {
    return this.configPath
  }

  /**
   * 读取磁盘现状（同一文件里还存放着由服务端配置模块写入的 `server` 块）。
   * 文件不存在或解析失败时返回空对象，不回退成抛错。
   */
  private async readOnDisk(): Promise<Partial<AppConfig>> {
    return (await readJsonObject(this.configPath)) as Partial<AppConfig>
  }

  async load(): Promise<AppConfig> {
    const onDisk = await this.readOnDisk()
    // 缺字段的部分配置（旧版本 / 手工编辑）补默认值，避免后续 `.filter` / `.push` 崩
    this.data = { recentProjects: [], deploymentTargets: [], ...onDisk }
    // **不留存 `server` 块**：它不是本 store 的字段。持有别人的快照会让 save() 有机会把
    // 过期的 server 配置回写（"配置说关闭、服务在监听"的分裂脑就是这么来的）。
    delete (this.data as unknown as Record<string, unknown>).server
    return this.data
  }

  /**
   * 落盘。
   *
   * 这里**以磁盘现状为基底**、只覆盖本 store 持有的键：同一个配置文件里还有
   * 服务端配置模块写入的 `server` 块，若直接写 `this.data`（本 store 的快照），
   * 保存目录映射 / 最近项目时会把 `server` 块整块抹掉（令牌与监听配置随之丢失）。
   */
  async save(): Promise<void> {
    // 整段（读盘 → 合并 → 写盘）放进**共享写入锁**：另一写者（server-config）可能正在写同一文件，
    // 只有把 read-modify-write 串起来才不会丢更新。
    await withConfigWriteLock(async () => {
      const onDisk = await this.readOnDisk()
      const merged: Record<string, unknown> = { ...onDisk }
      // 独占键先删：否则磁盘上的旧值会“活”下来（如删目标后 currentTargetId 仍指向已删目标）
      for (const key of OWNED_KEYS) delete merged[key]
      // **只写 OWNED_KEYS**：此前遍历 `Object.entries(this.data)` 会把内存里的任何键都写回磁盘，
      // 其中可能包含从磁盘读到的、且已被别的写者更新过的 `server` 块 → 静默回滚他人的配置。
      const owned = this.data as unknown as Record<string, unknown>
      for (const key of OWNED_KEYS) {
        const value = owned[key]
        if (value !== undefined) merged[key] = value
      }
      await writeJsonAtomic(this.configPath, merged)
    })
  }

  /**
   * 只更新**本 store 独占的键**并落盘（用于渲染层的"单字段保存"，如切换当前上传目标）。
   *
   * 为什么不能走 `replace() + save()`：`replace` 基于**内存快照**，而内存里可能只有默认值
   * （例如刚启动、尚未 `load()`）—— 那样保存单个字段会把 targets/recentProjects 一起写成空。
   * 这里在**写锁内**「读盘 → 只合并传入的独占键 → 原子写」，既不丢别人的字段，也不覆盖自己的既有值。
   */
  async patchOwned(partial: Partial<AppConfig>): Promise<void> {
    await withConfigWriteLock(async () => {
      const onDisk = await this.readOnDisk()
      const merged: Record<string, unknown> = { ...onDisk }
      const owned = this.data as unknown as Record<string, unknown>
      for (const key of OWNED_KEYS) {
        if (key in partial) {
          const value = (partial as Record<string, unknown>)[key]
          if (value === undefined) delete merged[key]
          else merged[key] = value
          // 同步内存快照：否则后续 save() 会用旧值把它覆盖回去
          owned[key] = value
        }
      }
      await writeJsonAtomic(this.configPath, merged)
    })
  }

  /**
   * 整体替换配置（用于前端完整保存）。
   *
   * 只接受本 store 独占的键：渲染层即使送来 `server` 块也会被忽略（它不是本 store 的字段，
   * 且渲染层的快照可能已过期 —— 照单全收就会回滚服务端配置）。
   */
  replace(config: Partial<AppConfig>): void {
    const next: Record<string, unknown> = { ...(this.data as unknown as Record<string, unknown>) }
    for (const key of OWNED_KEYS) {
      if (key in config) next[key] = (config as Record<string, unknown>)[key]
    }
    this.data = next as unknown as AppConfig
  }

  /**
   * 写锁内的「读盘 → 改 → 写盘」。
   *
   * 单独 `await load()` 再 `await save()` 时，两段之间不在锁里：两个并发编辑
   * （多窗口改目标、同时写项目界面状态）会各自基于旧快照写回，后写者覆盖前者的更新。
   * mutator 返回 false 表示「没有需要写的变化」（如目标不存在）。
   */
  private async mutateOwned(mutate: (config: AppConfig) => boolean | void): Promise<void> {
    await withConfigWriteLock(async () => {
      const onDisk = await this.readOnDisk()
      const base: AppConfig = { recentProjects: [], deploymentTargets: [], ...onDisk }
      // 与 load() 一致：内存快照不持有别人的 `server` 块
      delete (base as unknown as Record<string, unknown>).server
      if (mutate(base) === false) return

      const merged: Record<string, unknown> = { ...onDisk }
      for (const key of OWNED_KEYS) delete merged[key]
      const owned = base as unknown as Record<string, unknown>
      for (const key of OWNED_KEYS) {
        const value = owned[key]
        if (value !== undefined) merged[key] = value
      }
      await writeJsonAtomic(this.configPath, merged)
      this.data = base
    })
  }

  // Target management
  async addTarget(target: DeployTarget): Promise<void> {
    await this.mutateOwned((config) => {
      if (!target.id) {
        target.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      }
      if (!target.mappings) {
        target.mappings = []
      }
      config.deploymentTargets.push(target)
    })
  }

  async updateTarget(id: string, updates: Partial<DeployTarget>): Promise<void> {
    await this.mutateOwned((config) => {
      const idx = config.deploymentTargets.findIndex(t => t.id === id)
      if (idx < 0) return false
      config.deploymentTargets[idx] = { ...config.deploymentTargets[idx], ...updates }
    })
  }

  async removeTarget(id: string): Promise<void> {
    await this.mutateOwned((config) => {
      config.deploymentTargets = config.deploymentTargets.filter(t => t.id !== id)
      if (config.currentTargetId === id) {
        config.currentTargetId = undefined
      }
    })
  }

  // Mapping management
  async addMapping(targetId: string, mapping: DirectoryMapping): Promise<void> {
    await this.mutateOwned((config) => {
      const target = config.deploymentTargets.find(t => t.id === targetId)
      if (!target) return false
      if (!mapping.id) {
        mapping.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      }
      target.mappings.push(mapping)
    })
  }

  async updateMapping(targetId: string, mappingId: string, updates: Partial<DirectoryMapping>): Promise<void> {
    await this.mutateOwned((config) => {
      const target = config.deploymentTargets.find(t => t.id === targetId)
      if (!target) return false
      const idx = target.mappings.findIndex(m => m.id === mappingId)
      if (idx < 0) return false
      target.mappings[idx] = { ...target.mappings[idx], ...updates }
    })
  }

  async removeMapping(targetId: string, mappingId: string): Promise<void> {
    await this.mutateOwned((config) => {
      const target = config.deploymentTargets.find(t => t.id === targetId)
      if (!target) return false
      target.mappings = target.mappings.filter(m => m.id !== mappingId)
    })
  }

  // Recent projects
  /**
   * 读取某项目记忆的界面状态（多项目多窗口：每窗口一份，重启后恢复）。
   * 键为归一化路径，避免同一项目因大小写/分隔符差异各存一份。
   */
  async getProjectViewState(projectPath: string): Promise<ProjectViewState | null> {
    const config = await this.load()
    const key = normalizeProjectPath(projectPath)
    return config.projectViewState?.[key] ?? null
  }

  /** 合并保存某项目的界面状态（只覆盖传入字段） */
  async saveProjectViewState(projectPath: string, patch: ProjectViewState): Promise<void> {
    const key = normalizeProjectPath(projectPath)
    await this.mutateOwned((config) => {
      const current = config.projectViewState ?? {}
      const merged: ProjectViewState = { ...(current[key] ?? {}) }
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue
        ;(merged as Record<string, unknown>)[field] = value
      }
      config.projectViewState = { ...current, [key]: merged }
    })
  }

  /** 从最近列表移除某条（列表要能被清理：误加的目录/已删除的项目不该永久占位） */
  async removeRecentProject(projectPath: string): Promise<void> {
    await this.mutateOwned((config) => {
      config.recentProjects = (config.recentProjects ?? []).filter((p) => p !== projectPath)
    })
  }

  async addRecentProject(projectPath: string): Promise<void> {
    await this.mutateOwned((config) => {
      // 已存在则移到最前（保证“最近”语义），并去重、限制总数
      config.recentProjects = [projectPath, ...(config.recentProjects ?? []).filter((p) => p !== projectPath)].slice(0, 10)
    })
  }
}
