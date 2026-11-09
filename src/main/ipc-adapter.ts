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
import { applySecrets, cloneSecrets } from '../server/target-secrets'

export interface IpcAdapter {
  filesTree(root: string): Promise<unknown>
  filesExpand(dir: string): Promise<unknown>
  filesCollect(dir: string, maxFiles?: number): Promise<unknown>
  gitCheckRepo(dir: string): Promise<unknown>
  gitBranches(dir: string): Promise<unknown>
  gitAuthors(dir: string): Promise<unknown>
  gitStatus(dir: string): Promise<unknown>
  gitLog(dir: string, options?: any): Promise<unknown>
  gitDiff(dir: string, filePath: string): Promise<unknown>
  gitCommitFiles(dir: string, rev: string): Promise<unknown>
  configLoad(): Promise<unknown>
  targetList(): Promise<unknown>
  serverConfig(): Promise<unknown>
  serverStatus(): Promise<unknown>
  // 写入类（T9 批 2）
  configSave(config: any): Promise<unknown>
  targetSave(payload: { op: 'add' | 'update' | 'clone'; [key: string]: unknown }): Promise<unknown>
  targetRemove(id: string): Promise<unknown>
  targetReorder(ids: string[]): Promise<unknown>
  mappingAdd(targetId: string, mapping: any): Promise<unknown>
  mappingUpdate(targetId: string, mappingId: string, updates: any): Promise<unknown>
  mappingRemove(targetId: string, mappingId: string): Promise<unknown>
  serverConfigSave(patch: any): Promise<unknown>
  serverTokenRotate(): Promise<unknown>
  serverExport(): Promise<unknown>
  /** 项目视图状态写入（process 模式下必须走后端，P1-10） */
  projectViewSave(project: string, patch: any): Promise<unknown>
  // 部署类（T9 批 3）
  deployPreview(files: string[], projectRoot: string, target: any): Promise<unknown>
  deployDirect(
    payload: { windowId: number; tasks: any[]; targetName: string; projectRoot?: string },
    onProgress?: (current: number, total: number, file: string) => void
  ): Promise<unknown>
  deployCancel(windowId: number): Promise<unknown>
  testConnectionDraft(target: any): Promise<unknown>
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
    getLogView: (dir: string, options?: any) => Promise<unknown>
    getFileDiff: (dir: string, filePath: string) => Promise<unknown>
    getCommitFiles: (dir: string, rev: string) => Promise<unknown>
  }
  configStore: {
    load: () => Promise<{ deploymentTargets: any[] }>
    patchOwned: (partial: any) => Promise<void>
    addTarget: (target: any) => Promise<void>
    updateTarget: (id: string, updates: any) => Promise<void>
    removeTarget: (id: string) => Promise<void>
    reorderTargets: (ids: string[]) => Promise<void>
    addMapping: (targetId: string, mapping: any) => Promise<void>
    updateMapping: (targetId: string, mappingId: string, updates: any) => Promise<void>
    removeMapping: (targetId: string, mappingId: string) => Promise<void>
  }
  serverConfig: () => Promise<unknown>
  serverStatus: () => unknown
  serverConfigSave: (patch: any) => Promise<unknown>
  serverTokenRotate: () => Promise<unknown>
  serverExport: () => Promise<unknown>
  saveProjectViewState: (project: string, patch: any) => Promise<void>
  deployService: {
    buildUploadPlan: (files: string[], projectRoot: string, target: any) => Promise<unknown>
    deploy: (
      tasks: any[],
      target: any,
      onProgress: (current: number, total: number, file: string) => void,
      owner: 'desktop',
      options: { windowId: number }
    ) => Promise<unknown>
    abort: (owner: 'desktop', windowId: number) => void
    testConnection: (target: any) => Promise<unknown>
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
      // embedded 也必须遵守联秘密契约（P1-3）：否则清除/复制只在新模式下生效
      const cfg = (await deps.configStore.load()) as { deploymentTargets: any[] }
      const strip = (value: any) => {
        const { password: _p, passphrase: _pp, ...rest } = value ?? {}
        return rest
      }
      const missing = (label: string) => {
        const error = new Error(label) as Error & { code?: string }
        error.code = 'NO_TARGET'
        return error
      }

      if (payload.op === 'add') {
        await deps.configStore.addTarget(applySecrets(strip(payload.target), payload.secrets as any))
      } else if (payload.op === 'clone') {
        const source = cfg.deploymentTargets.find((item) => item.id === payload.sourceId)
        if (!source) throw missing(`源目标不存在：${String(payload.sourceId)}`)
        await deps.configStore.addTarget(cloneSecrets(source, strip(payload.target)))
      } else {
        const current = cfg.deploymentTargets.find((item) => item.id === payload.id)
        if (!current) throw missing(`目标不存在：${String(payload.id)}`)
        const merged = applySecrets({ ...current, ...strip(payload.updates) }, payload.secrets as any)
        await deps.configStore.updateTarget(String(payload.id), merged)
      }
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
    projectViewSave: async (project, patch) => {
      await deps.saveProjectViewState(project, patch)
      return null
    },
    deployPreview: (files, projectRoot, target) => deps.deployService.buildUploadPlan(files, projectRoot, target),
    deployDirect: async (payload, onProgress) => {
      const target = (await deps.configStore.load()).deploymentTargets.find(
        (item) => (item as { name?: string }).name === payload.targetName
      )
      if (!target) {
        const error = new Error(`目标不存在：${payload.targetName}`) as Error & { code?: string }
        error.code = 'NO_TARGET'
        throw error
      }
      return deps.deployService.deploy(
        payload.tasks,
        target,
        onProgress ?? (() => undefined),
        'desktop',
        { windowId: payload.windowId }
      )
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
  post(path: string, body?: any, timeoutMs?: number): Promise<ClientResult>
  /** 订阅后端事件（SSE）；返回取消订阅函数 */
  on?(event: string, fn: (data: any) => void): () => void
}

export function createRemoteAdapter (host: RemoteHost): IpcAdapter {
  return {
    filesTree: async (root) => unwrapEnvelope(await host.post('/files/tree', { root })),
    filesExpand: async (dir) => unwrapEnvelope(await host.post('/files/expand', { dir })),
    filesCollect: async (dir, maxFiles) => unwrapEnvelope(await host.post('/files/collect', { dir, maxFiles })),
    gitCheckRepo: async (dir) => unwrapEnvelope(await host.get('/git/check-repo', { project: dir })),
    // 桌面期望数组/完整视图：走管理端点的 -full 路由（P1-7）
    gitBranches: async (dir) => unwrapEnvelope(await host.get('/git/branches-full', { project: dir })),
    gitAuthors: async (dir) => unwrapEnvelope(await host.get('/git/authors', { project: dir })),
    gitStatus: async (dir) => unwrapEnvelope(await host.get('/git/status-full', { project: dir })),
    gitLog: async (dir, options) => {
      const opts = (options ?? {}) as { branch?: string; author?: string; maxCount?: number }
      return unwrapEnvelope(
        await host.get('/git/log-full', {
          project: dir,
          ...(opts.branch ? { branch: opts.branch } : {}),
          ...(opts.author ? { author: opts.author } : {}),
          ...(opts.maxCount ? { maxCount: opts.maxCount } : {})
        })
      )
    },
    gitDiff: async (dir, filePath) => unwrapEnvelope(await host.get('/git/diff', { project: dir, filePath })),
    gitCommitFiles: async (dir, rev) => unwrapEnvelope(await host.get('/git/commit-files', { project: dir, rev })),
    configLoad: async () => unwrapEnvelope(await host.get('/config')),
    targetList: async () => {
      const config = unwrapEnvelope(await host.get('/config')) as { deploymentTargets?: any[] }
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
    projectViewSave: async (project, patch) =>
      unwrapEnvelope(await host.post('/projects/view', { project, patch })),
    deployPreview: async (files, projectRoot, target) =>
      unwrapEnvelope(await host.post('/plan/preview', { files, projectRoot, target })),
    deployDirect: async (payload, onProgress) => {
      const off = onProgress && host.on
        ? host.on('deploy.progress', (data) => {
            const progress = data as { windowId?: number; current: number; total: number; file: string }
            if (progress?.windowId === payload.windowId) onProgress(progress.current, progress.total, progress.file)
          })
        : null
      try {
        // 直连上传可能远超 30s：单独超时（F3）
        return unwrapEnvelope(await host.post('/deploy/direct', payload, 30 * 60 * 1000))
      } finally {
        off?.()
      }
    },
    deployCancel: async (windowId) => unwrapEnvelope(await host.post('/deploy/cancel', { windowId })),
    testConnectionDraft: async (target) => unwrapEnvelope(await host.post('/test-connection/draft', { target }))
  }
}

