/**
 * IPC 适配层：桌面 handler 只依赖这个接口。
 *
 * - embedded：直接调用进程内服务（现状）
 * - remote：调用独立后端的管理端点
 *
 * 两种实现错误语义一致：成功返回数据，失败抛带 code 的 Error。
 * 注意：T9 必须整体切换，不能只转一部分 handler（否则会出现两个执行体）。
 */
import type { ClientResult } from '../shared/http-client'

export interface IpcAdapter {
  filesTree(root: string): Promise<unknown>
  filesExpand(dir: string): Promise<unknown>
  filesCollect(dir: string, maxFiles?: number): Promise<unknown>
  gitCheckRepo(dir: string): Promise<unknown>
  gitBranches(dir: string): Promise<unknown>
  gitAuthors(dir: string): Promise<unknown>
  gitStatus(dir: string): Promise<unknown>
  gitLog(dir: string, options?: unknown): Promise<unknown>
  gitDiff(dir: string, filePath: string): Promise<unknown>
  gitCommitFiles(dir: string, rev: string): Promise<unknown>
  configLoad(): Promise<unknown>
  targetList(): Promise<unknown>
  serverConfig(): Promise<unknown>
  serverStatus(): Promise<unknown>
  // 写入类（T9 批 2）
  configSave(config: unknown): Promise<unknown>
  targetSave(payload: { op: 'add' | 'update' | 'clone'; [key: string]: unknown }): Promise<unknown>
  targetRemove(id: string): Promise<unknown>
  targetReorder(ids: string[]): Promise<unknown>
  mappingAdd(targetId: string, mapping: unknown): Promise<unknown>
  mappingUpdate(targetId: string, mappingId: string, updates: unknown): Promise<unknown>
  mappingRemove(targetId: string, mappingId: string): Promise<unknown>
  serverConfigSave(patch: unknown): Promise<unknown>
  serverTokenRotate(): Promise<unknown>
  serverExport(): Promise<unknown>
  // 部署类（T9 批 3）
  deployPreview(files: string[], projectRoot: string, target: unknown): Promise<unknown>
  deployDirect(payload: { windowId: number; tasks: unknown[]; targetName: string; projectRoot?: string }): Promise<unknown>
  deployCancel(windowId: number): Promise<unknown>
  testConnectionDraft(target: unknown): Promise<unknown>
}

/** 信封解包：失败统一抛带 code 的 Error（与 renderer 现有 catch 口径一致） */
export function unwrapEnvelope (result: ClientResult): unknown {
  if (!result.ok) {
    const error = new Error(result.error.message) as Error & { code?: string }
    error.code = result.error.code
    throw error
  }
  if (!result.envelope.ok) {
    const error = new Error(result.envelope.error.message) as Error & { code?: string }
    error.code = result.envelope.error.code
    throw error
  }
  return result.envelope.data === null ? undefined : result.envelope.data
}

export interface EmbeddedDeps {
  files: {
    buildTree: (root: string) => Promise<unknown>
    expandDirectory: (dir: string) => Promise<unknown>
    collectFilesForUpload: (dir: string, maxFiles?: number) => Promise<unknown>
  }
  git: {
    hasAnyRepository: (dir: string) => Promise<unknown>
    getBranches: (dir: string) => Promise<unknown>
    getAuthors: (dir: string) => Promise<unknown>
    getStatusView: (dir: string) => Promise<unknown>
    getLogView: (dir: string, options?: unknown) => Promise<unknown>
    getFileDiff: (dir: string, filePath: string) => Promise<unknown>
    getCommitFiles: (dir: string, rev: string) => Promise<unknown>
  }
  configStore: {
    load: () => Promise<{ deploymentTargets: unknown[] }>
    patchOwned: (partial: unknown) => Promise<void>
    addTarget: (target: unknown) => Promise<void>
    updateTarget: (id: string, updates: unknown) => Promise<void>
    removeTarget: (id: string) => Promise<void>
    reorderTargets: (ids: string[]) => Promise<void>
    addMapping: (targetId: string, mapping: unknown) => Promise<void>
    updateMapping: (targetId: string, mappingId: string, updates: unknown) => Promise<void>
    removeMapping: (targetId: string, mappingId: string) => Promise<void>
  }
  serverConfig: () => Promise<unknown>
  serverStatus: () => unknown
  serverConfigSave: (patch: unknown) => Promise<unknown>
  serverTokenRotate: () => Promise<unknown>
  serverExport: () => Promise<unknown>
  deployService: {
    buildUploadPlan: (files: string[], projectRoot: string, target: unknown) => Promise<unknown>
    deploy: (
      tasks: unknown[],
      target: unknown,
      onProgress: (current: number, total: number, file: string) => void,
      owner: 'desktop',
      options: { windowId: number }
    ) => Promise<unknown>
    abort: (owner: 'desktop', windowId: number) => void
    testConnection: (target: unknown) => Promise<unknown>
  }
}

export function createEmbeddedAdapter (deps: EmbeddedDeps): IpcAdapter {
  return {
    filesTree: (root) => deps.files.buildTree(root),
    filesExpand: (dir) => deps.files.expandDirectory(dir),
    filesCollect: (dir, maxFiles) => deps.files.collectFilesForUpload(dir, maxFiles),
    gitCheckRepo: (dir) => deps.git.hasAnyRepository(dir),
    gitBranches: (dir) => deps.git.getBranches(dir),
    gitAuthors: (dir) => deps.git.getAuthors(dir),
    gitStatus: (dir) => deps.git.getStatusView(dir),
    gitLog: (dir, options) => deps.git.getLogView(dir, options),
    gitDiff: (dir, filePath) => deps.git.getFileDiff(dir, filePath),
    gitCommitFiles: (dir, rev) => deps.git.getCommitFiles(dir, rev),
    configLoad: () => deps.configStore.load(),
    targetList: async () => (await deps.configStore.load()).deploymentTargets,
    serverConfig: () => deps.serverConfig(),
    serverStatus: async () => deps.serverStatus(),
    configSave: async (config) => {
      await deps.configStore.patchOwned(config)
      return deps.configStore.load()
    },
    targetSave: async (payload) => {
      if (payload.op === 'add') await deps.configStore.addTarget(payload.target)
      else if (payload.op === 'clone') await deps.configStore.addTarget(payload.target)
      else await deps.configStore.updateTarget(String(payload.id), payload.updates)
      return null
    },
    targetRemove: async (id) => {
      await deps.configStore.removeTarget(id)
      return null
    },
    targetReorder: async (ids) => {
      await deps.configStore.reorderTargets(ids)
      return null
    },
    mappingAdd: async (targetId, mapping) => {
      await deps.configStore.addMapping(targetId, mapping)
      return null
    },
    mappingUpdate: async (targetId, mappingId, updates) => {
      await deps.configStore.updateMapping(targetId, mappingId, updates)
      return null
    },
    mappingRemove: async (targetId, mappingId) => {
      await deps.configStore.removeMapping(targetId, mappingId)
      return null
    },
    serverConfigSave: (patch) => deps.serverConfigSave(patch),
    serverTokenRotate: () => deps.serverTokenRotate(),
    serverExport: () => deps.serverExport(),
    deployPreview: (files, projectRoot, target) => deps.deployService.buildUploadPlan(files, projectRoot, target),
    deployDirect: async (payload) => {
      const target = (await deps.configStore.load()).deploymentTargets.find(
        (item) => (item as { name?: string }).name === payload.targetName
      )
      if (!target) {
        const error = new Error(`目标不存在：${payload.targetName}`) as Error & { code?: string }
        error.code = 'NO_TARGET'
        throw error
      }
      return deps.deployService.deploy(payload.tasks, target, () => undefined, 'desktop', { windowId: payload.windowId })
    },
    deployCancel: async (windowId) => {
      deps.deployService.abort('desktop', windowId)
      return null
    },
    testConnectionDraft: (target) => deps.deployService.testConnection(target)
  }
}

export interface RemoteHost {
  get(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<ClientResult>
  post(path: string, body?: unknown): Promise<ClientResult>
}

export function createRemoteAdapter (host: RemoteHost): IpcAdapter {
  return {
    filesTree: async (root) => unwrapEnvelope(await host.post('/files/tree', { root })),
    filesExpand: async (dir) => unwrapEnvelope(await host.post('/files/expand', { dir })),
    filesCollect: async (dir, maxFiles) => unwrapEnvelope(await host.post('/files/collect', { dir, maxFiles })),
    gitCheckRepo: async (dir) => unwrapEnvelope(await host.get('/git/check-repo', { project: dir })),
    gitBranches: async (dir) => unwrapEnvelope(await host.get('/git/branches', { project: dir })),
    gitAuthors: async (dir) => unwrapEnvelope(await host.get('/git/authors', { project: dir })),
    gitStatus: async (dir) => unwrapEnvelope(await host.get('/git/status', { project: dir })),
    gitLog: async (dir, options) =>
      unwrapEnvelope(await host.get('/git/log', { project: dir, ...(options as Record<string, string> | undefined) })),
    gitDiff: async (dir, filePath) => unwrapEnvelope(await host.get('/git/diff', { project: dir, filePath })),
    gitCommitFiles: async (dir, rev) => unwrapEnvelope(await host.get('/git/commit-files', { project: dir, rev })),
    configLoad: async () => unwrapEnvelope(await host.get('/config')),
    targetList: async () => {
      const config = unwrapEnvelope(await host.get('/config')) as { deploymentTargets?: unknown[] }
      return config?.deploymentTargets ?? []
    },
    serverConfig: async () => unwrapEnvelope(await host.get('/server/config')),
    serverStatus: async () => unwrapEnvelope(await host.get('/status')),
    configSave: async (config) => unwrapEnvelope(await host.post('/config', { config })),
    targetSave: async (payload) => {
      const path = payload.op === 'add' ? '/targets/add' : payload.op === 'clone' ? '/targets/clone' : '/targets/update'
      return unwrapEnvelope(await host.post(path, payload))
    },
    targetRemove: async (id) => unwrapEnvelope(await host.post('/targets/remove', { id })),
    targetReorder: async (ids) => unwrapEnvelope(await host.post('/targets/reorder', { ids })),
    mappingAdd: async (targetId, mapping) => unwrapEnvelope(await host.post('/mappings/add', { targetId, mapping })),
    mappingUpdate: async (targetId, mappingId, updates) =>
      unwrapEnvelope(await host.post('/mappings/update', { targetId, mappingId, updates })),
    mappingRemove: async (targetId, mappingId) =>
      unwrapEnvelope(await host.post('/mappings/remove', { targetId, mappingId })),
    serverConfigSave: async (patch) => unwrapEnvelope(await host.post('/server/config', { patch })),
    serverTokenRotate: async () => unwrapEnvelope(await host.post('/server/token')),
    serverExport: async () => unwrapEnvelope(await host.post('/server/export')),
    deployPreview: async (files, projectRoot, target) =>
      unwrapEnvelope(await host.post('/plan/preview', { files, projectRoot, target })),
    deployDirect: async (payload) => unwrapEnvelope(await host.post('/deploy/direct', payload)),
    deployCancel: async (windowId) => unwrapEnvelope(await host.post('/deploy/cancel', { windowId })),
    testConnectionDraft: async (target) => unwrapEnvelope(await host.post('/test-connection/draft', { target }))
  }
}
