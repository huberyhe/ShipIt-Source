import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AppConfig, DeployTarget, DirectoryMapping } from '../../shared/types'

export type { AppConfig, DeployTarget, DirectoryMapping }

export class ConfigStore {
  private configPath: string
  private data: AppConfig

  constructor() {
    this.configPath = join(app.getPath('userData'), 'deploy-config.json')
    this.data = {
      recentProjects: [],
      deploymentTargets: []
    }
  }

  async load(): Promise<AppConfig> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8')
      this.data = JSON.parse(content)
    } catch {
      // 文件不存在或解析失败，使用默认配置
    }
    return this.data
  }

  async save(): Promise<void> {
    await fs.writeFile(this.configPath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  /** 整体替换配置（用于前端完整保存） */
  replace(config: AppConfig): void {
    this.data = config
  }

  // Target management
  async addTarget(target: DeployTarget): Promise<void> {
    await this.load() // 先加载最新数据
    if (!target.id) {
      target.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    }
    if (!target.mappings) {
      target.mappings = []
    }
    this.data.deploymentTargets.push(target)
    await this.save()
  }

  async updateTarget(id: string, updates: Partial<DeployTarget>): Promise<void> {
    await this.load()
    const idx = this.data.deploymentTargets.findIndex(t => t.id === id)
    if (idx >= 0) {
      this.data.deploymentTargets[idx] = { ...this.data.deploymentTargets[idx], ...updates }
      await this.save()
    }
  }

  async removeTarget(id: string): Promise<void> {
    await this.load()
    this.data.deploymentTargets = this.data.deploymentTargets.filter(t => t.id !== id)
    if (this.data.currentTargetId === id) {
      this.data.currentTargetId = undefined
    }
    await this.save()
  }

  // Mapping management
  async addMapping(targetId: string, mapping: DirectoryMapping): Promise<void> {
    const target = this.data.deploymentTargets.find(t => t.id === targetId)
    if (target) {
      if (!mapping.id) {
        mapping.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      }
      target.mappings.push(mapping)
      await this.save()
    }
  }

  async updateMapping(targetId: string, mappingId: string, updates: Partial<DirectoryMapping>): Promise<void> {
    const target = this.data.deploymentTargets.find(t => t.id === targetId)
    if (target) {
      const idx = target.mappings.findIndex(m => m.id === mappingId)
      if (idx >= 0) {
        target.mappings[idx] = { ...target.mappings[idx], ...updates }
        await this.save()
      }
    }
  }

  async removeMapping(targetId: string, mappingId: string): Promise<void> {
    const target = this.data.deploymentTargets.find(t => t.id === targetId)
    if (target) {
      target.mappings = target.mappings.filter(m => m.id !== mappingId)
      await this.save()
    }
  }

  // Recent projects
  async addRecentProject(projectPath: string): Promise<void> {
    if (!this.data.recentProjects.includes(projectPath)) {
      this.data.recentProjects.unshift(projectPath)
      this.data.recentProjects = this.data.recentProjects.slice(0, 10)
      await this.save()
    }
  }
}
