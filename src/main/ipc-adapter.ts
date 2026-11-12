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
    payload: {
      windowId: number
      /** 选中的源路径（服务端重算任务，不接受客户端给的 localPath/remotePath） */
      files: string[]
      projectRoot: string
      targetName: string
      /** 预览时看到的相对路径集合：重算后不一致就拒绝（PLAN_STALE） */
      expectFiles: string[]
      /** 预览时的目标配置签名：确认后被改过就拒绝 */
      targetSignature: string
    },
    onProgress?: (current: number, total: number, file: string, bytes?: { done: number; total: number }) => void,
    /** 排队位置回调：前面还有几个会话（用于显示“排队中”而不是假进度） */
    onQueued?: (ahead: number) => void
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
    deployDirect: async (payload, onProgress, onQueued) => {
      const off = onProgress && host.on
        ? host.on('deploy.progress', (data) => {
            const progress = data as {
              windowId?: number
              current: number
              total: number
              file: string
              bytes?: { done: number; total: number }
            }
            if (progress?.windowId === payload.windowId) {
              onProgress(progress.current, progress.total, progress.file, progress.bytes)
            }
          })
        : null
      const offQueued = onQueued && host.on
        ? host.on('deploy.queued', (data) => {
            const queued = data as { windowId?: number; ahead: number }
            if (queued?.windowId === payload.windowId) onQueued(queued.ahead)
          })
        : null
      try {
        // 直连上传可能远超 30s：单独超时（F3）
        return unwrapEnvelope(await host.post('/deploy/direct', payload, 30 * 60 * 1000))
      } finally {
        off?.()
        offQueued?.()
      }
    },
    deployCancel: async (windowId) => unwrapEnvelope(await host.post('/deploy/cancel', { windowId })),
    testConnectionDraft: async (target) => {
      // renderer 把 secrets/cloneFrom 展开在 target 里（草稿补丁），而后端 handler 读的是
      // 顶层字段（F6）。不在这里拆包，R7 的 applySecrets/cloneSecrets 永远拿不到数据。
      const { secrets, cloneFrom, ...rest } = (target ?? {}) as Record<string, unknown>
      return unwrapEnvelope(
        await host.post('/test-connection/draft', {
          target: rest,
          ...(secrets ? { secrets } : {}),
          ...(cloneFrom ? { cloneFrom } : {})
        })
      )
    }
  }
}

