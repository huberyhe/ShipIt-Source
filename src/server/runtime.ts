/**
 * 后端运行时：一个 Runtime + 两个 listener。
 *
 * - 管理端点：始终启动，只绑回环，宿主 token（经 ready 分发，不落盘）
 * - 公开端点：按配置 enabled 启停，用户 token，路由为现有 10 条
 *
 * 两个 listener 共享同一套 handler 与同一条上传串行链。
 */
import { randomBytes } from 'crypto'
import { promises as fsp } from 'fs'
import { ConfigStore } from '../main/services/config-store'
import { DeployService } from '../main/services/deploy-service'
import { createQueue } from '../main/services/deploy-queue'
import { GitService } from '../main/services/git-service'
import { FileService } from '../main/services/file-service'
import { ProjectContext } from '../main/services/project-context'
import { createServerHandlers } from '../main/services/server-handlers'
import { createLocalServer, type RouteHandler } from '../main/services/local-server'
import { loadServerConfig } from '../main/services/server-config'
import { PROTOCOL_VERSION } from '../shared/cli-contract'
import { ADMIN_ROUTES, PUBLIC_ROUTES } from './routes'

export interface OpenedProject {
  path: string
  name: string
  windowId: number
  focused: boolean
}

export interface RuntimeOptions {
  configPath: string
  appVersion: string
  dataDir: string
}

export interface PublicState {
  listening: boolean
  port: number | null
  bound: string
  error?: string
}

export function createRuntime (options: RuntimeOptions) {
  const configStore = new ConfigStore(options.configPath)
  const deployService = new DeployService()
  const git = new GitService()
  const files = new FileService()
  const projectContext = new ProjectContext()

  const instanceId = randomBytes(8).toString('hex')
  /** 宿主 token：只经 ready 分发给父进程，不落盘 */
  const adminToken = randomBytes(16).toString('hex')

  let opened: OpenedProject[] = []
  let currentProject: string | null = null
  let published = false
  let draining = false
  let emit: (event: string, data: unknown) => void = () => {}
  let adminServer: ReturnType<typeof createLocalServer> | null = null
  let publicServer: ReturnType<typeof createLocalServer> | null = null
  let adminState = { listening: false, port: null as number | null, bound: '', error: undefined as string | undefined }
  let publicState: PublicState = { listening: false, port: null, bound: '', error: undefined }
  let serverConfigCache: { bind: 'local' | 'lan'; allowedRoots: string[] } = { bind: 'local', allowedRoots: [] }
  let extraHandlers: Record<string, RouteHandler> = {}
  let revision = 0

  /** 快照含 instanceId：main 用它丢弃旧实例的迟到事件（R2） */
  function statusSnapshot () {
    return {
      listening: publicState.listening,
      port: publicState.port,
      bound: publicState.bound,
      published,
      version: options.appVersion,
      protocolVersion: PROTOCOL_VERSION,
      instanceId,
      queue: queue.snapshot(),
      currentProject,
      projects: opened,
      revision: ++revision
    }
  }

  function snapshotState () {
    return { admin: adminState, public: publicState, published }
  }

  const queue = createQueue({
    onCallbackError: (where, error) => emit('log', { level: 'error', scope: 'queue', message: `${where}: ${String(error)}` }),
    onTaskChanged: () => emit('queue.snapshot', statusSnapshot()),
    onTaskSettled: (record) => emit('task.settled', record)
  })

  const handlers = createServerHandlers({
    loadTargets: async () => (await configStore.load()).deploymentTargets,
    testConnection: (target) => deployService.testConnection(target),
    resolveProject: (input) =>
      projectContext.resolve(input, {
        enforce: serverConfigCache.bind === 'lan',
        allowedRoots: serverConfigCache.allowedRoots,
        openedProjects: opened.map((p) => p.path)
      }),
    projectContext: { currentProject: () => projectContext.getCurrent() },
    activeSessions: () => deployService.activeSessions(),
    projectScope: () => ({ enforce: serverConfigCache.bind === 'lan', allowedRoots: serverConfigCache.allowedRoots }),
    listProjects: async () => opened,
    selection: {
      isGitRepo: (dir) => git.isGitRepo(dir),
      listChangedFiles: async (dir) => (await git.getStatusView(dir)).changes.map((c) => c.relativePath),
      listCommitFiles: async (dir, ref) => (await git.getCommitFiles(dir, ref)).map((f) => f.path),
      listFilesInDir: (dir, maxFiles) => files.collectFilesForUpload(dir, maxFiles),
      exists: async (abs) => {
        try {
          await fsp.stat(abs)
          return true
        } catch {
          return false
        }
      }
    },
    buildUploadTasks: (selected, projectRoot, target) => deployService.buildUploadTasks(selected, projectRoot, target),
    git: {
      isGitRepo: (dir) => git.isGitRepo(dir),
      getStatusView: (dir) => git.getStatusView(dir),
      getLogView: (dir, opts) => git.getLogView(dir, opts),
      getBranches: (dir) => git.getBranches(dir)
    },
    queue,
    getVersion: () => options.appVersion,
    snapshot: () => statusSnapshot(),
    deploy: (tasks, target, onProgress, ctx) =>
      deployService.deploy(tasks, target, onProgress, 'queue', { signal: ctx?.signal })
  }, () => publicState)

  /** 管理端点：始终启动，只绑回环，宿主 token，不写 server.json */
  async function startAdminListener () {
    const config = await loadServerConfig(options.configPath)
    serverConfigCache = { bind: config.bind, allowedRoots: config.allowedRoots }

    adminServer = createLocalServer({
      config: { ...config, enabled: false, port: 0, bind: 'local' },
      dataDir: options.dataDir,
      handlers: { ...handlers, ...extraHandlers },
      listen: true,
      publish: false,
      routes: ADMIN_ROUTES,
      tokenOverride: adminToken,
      onError: (error) => {
        adminState = { ...adminState, error: error.message }
        emit('server.state', snapshotState())
      }
    })

    const result = await adminServer.start()
    adminState = result.listening
      ? { listening: true, port: result.port, bound: result.bound, error: undefined }
      : { listening: false, port: null, bound: '', error: result.error?.message }
    emit('server.state', snapshotState())
    return result
  }

  /** 公开端点：按 enabled 启停；失败只影响公开能力，管理连接不受影响 */
  async function syncPublicListener () {
    const config = await loadServerConfig(options.configPath)
    serverConfigCache = { bind: config.bind, allowedRoots: config.allowedRoots }
    published = config.enabled

    if (publicServer) {
      await publicServer.stop()
      publicServer = null
    }

    if (!config.enabled) {
      publicState = { listening: false, port: null, bound: '', error: undefined }
      emit('server.state', snapshotState())
      return { listening: false as const }
    }

    publicServer = createLocalServer({
      config,
      dataDir: options.dataDir,
      handlers,
      listen: true,
      publish: true,
      routes: PUBLIC_ROUTES,
      onError: (error) => {
        publicState = { ...publicState, error: error.message }
        emit('server.state', snapshotState())
      }
    })

    const result = await publicServer.start()
    publicState = result.listening
      ? { listening: true, port: result.port, bound: result.bound, error: undefined }
      : { listening: false, port: null, bound: '', error: result.error?.message }
    emit('server.state', snapshotState())
    return result
  }

  async function stopAll () {
    await publicServer?.stop()
    publicServer = null
    await adminServer?.stop()
    adminServer = null
    publicState = { listening: false, port: null, bound: '', error: undefined }
    adminState = { listening: false, port: null, bound: '', error: undefined }
    emit('server.state', snapshotState())
  }

  return {
    appVersion: options.appVersion,
    instanceId,
    isDraining: () => draining,
    configStore,
    deployService,
    queue,
    git,
    files,
    projectContext,
    handlers,
    startAdminListener,
    syncPublicListener,
    /** 注入管理端点专有的 handler（由入口用 buildAdminHandlers 组装，避免循环依赖） */
    setExtraHandlers (map: Record<string, RouteHandler>) {
      extraHandlers = map
    },
    statusSnapshot,
    serverState: () => snapshotState(),
    adminPort: () => adminState.port,
    adminToken: () => adminToken,
    adminFingerprint: () => adminServer?.fingerprint() ?? null,
    publicPort: () => publicState.port,
    publicFingerprint: () => publicServer?.fingerprint() ?? null,
    published: () => published,
    setOpenedProjects (list: OpenedProject[]) {
      opened = list
    },
    setCurrentProject (path: string | null) {
      currentProject = path
      projectContext.setCurrent(path)
    },
    onEvent (fn: (event: string, data: unknown) => void) {
      emit = fn
    },
    notify (event: string, data: unknown) {
      emit(event, data)
    },
    async targetByName (name: string) {
      const found = (await configStore.load()).deploymentTargets.find((target) => target.name === name)
      if (!found) {
        const error = new Error(`目标不存在：${name}`) as Error & { code?: string }
        error.code = 'NO_TARGET'
        throw error
      }
      return found
    },
    /**
     * 两阶段退出：
     * - prepare：drain 一轮；未完成则不停 listener、不退出，把 pending 交给宿主做用户决策
     * - final：再等一轮后停 listener 并退出
     * - force：不等待，直接停
     */
    async shutdown (phase: 'prepare' | 'final' | 'force', deadlineMs: number) {
      draining = true
      // 只等待，不在此处停 listener：调用方需要先把响应写回（P0-6）
      if (phase === 'force') return { drained: false, forced: true as const }

      const [queueDrained, sessionsIdle] = await Promise.all([
        queue.drain(deadlineMs),
        deployService.waitForIdle(deadlineMs)
      ])
      const drained = queueDrained && sessionsIdle

      if (phase === 'prepare' && !drained) {
        const snapshot = queue.snapshot()
        const alive = deployService.activeSessions()
        return {
          drained: false as const,
          pending: { state: snapshot.state, pendingCount: snapshot.pendingCount, sessions: alive.length }
        }
      }

      return { drained }
    },
    /** 真正停止两个 listener（在响应写回后调用） */
    async finalize () {
      await stopAll()
    }
  }
}

export type Runtime = ReturnType<typeof createRuntime>
