import { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } from 'electron'
import { join, dirname } from 'path'
import { networkInterfaces } from 'os'
import { promises as fsPromises } from 'fs'
import { GitService } from './services/git-service'
import { DeployService } from './services/deploy-service'
import { ConfigStore } from './services/config-store'
import { FileService } from './services/file-service'
import { IpcChannels } from '../shared/ipc-channels'
import {
  connectionString,
  loadServerConfig,
  rotateToken,
  saveServerConfig,
  type ExportedConnection
} from './services/server-config'
import { createLocalServer, type Handlers, type LocalServer } from './services/local-server'
import { createServerHandlers } from './services/server-handlers'
import { ProjectContext } from './services/project-context'
import { createQueue } from './services/deploy-queue'
import { createTray, trayMenuTemplate, shouldQuitOnWindowClose, type TrayActions, type TrayHandle } from './tray'
import {
  PROJECT_WINDOW_LIMIT,
  closeActionFor,
  decideOpenTarget,
  findWindowForProject,
  pickWindowToFocus,
  parseWindowArgs,
  projectNameOf,
  shouldPromptWindowLimit,
  ARG_SECTION,
  windowArguments,
  windowTitle,
  type SettingsSection,
  type WindowEntry,
  type WindowRole
} from './window-manager'
import { PROTOCOL_VERSION } from '../shared/cli-contract'
import { queueTextOf } from '../shared/queue-text'
import type { ServerConfig } from '../shared/types'

/**
 * 多项目多窗口：一个主窗口（项目选择/服务入口）+ 每个项目一个窗口，共享同一进程、
 * 同一服务端、同一配置、同一条上传队列（决策记录见 .project/specs/multi-project-windows/plan.md）。
 */
interface AppWindow {
  win: BrowserWindow
  role: WindowRole
  /** 项目窗口的项目根；主窗口为 null */
  projectPath: string | null
  title: string
}

/**
 * 打开项目的结果（渲染进程据此知道项目落在哪个窗口）。
 * - current：已就地认领到调用窗口（本窗口会收到 MENU_OPEN_PROJECT 事件并加载）
 * - focus：该项目已在别的窗口打开 → 已聚焦那个窗口
 * - window：在新窗口打开
 */
export type OpenProjectMode = 'current' | 'focus' | 'window'
export interface OpenProjectResult {
  ok: true
  mode: OpenProjectMode
}

const appWindows = new Map<number, AppWindow>()
/** 最近聚焦的窗口 id：决定 CLI/MCP 的「桌面当前项目」（决策 D-4） */
let focusedWindowId: number | null = null

/** 供托盘菜单使用的窗口快照（纯数据结构，便于单测） */
/** 桌面已打开项目的路径集合（作用域判定用） */
function projectPaths(): string[] {
  return windowEntries()
    .map((entry) => entry.projectPath)
    .filter((path): path is string => !!path)
}

function windowEntries(): WindowEntry[] {
  return [...appWindows.values()].map((entry) => ({
    id: entry.win.webContents.id,
    role: entry.role,
    projectPath: entry.projectPath,
    title: entry.title
  }))
}

/**
 * 通知所有窗口「配置（目标/映射/服务端）已变更」。
 * 配置是全局单份：不广播会让其他窗口拿着旧目标上传（多窗口下的主要风险点）。
 */
function broadcastConfigChanged(): void {
  broadcast(IpcChannels.CONFIG_CHANGED, { at: Date.now() })
}

/**
 * 向所有存活窗口广播（全局事件：服务状态、任务日志等）。
 *
 * 逐窗口隔离：`isDestroyed()` 与 `send()` 不是原子操作，窗口销毁的瞬间 send 会抛。
 * 不兜住的话，一个窗口的竞态就会让**后面的窗口收不到这次更新**（甚至击穿调用方）。
 */
function broadcast(channel: string, payload: unknown): void {
  for (const entry of appWindows.values()) {
    if (entry.win.isDestroyed()) continue
    try {
      entry.win.webContents.send(channel, payload)
    } catch (error) {
      process.stderr.write(`[shipit] 广播失败（${channel}）：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

/** 向指定窗口发送（每窗口独立的事件，如上传进度）；目标窗口失效时静默跳过 */
function sendToWindow(id: number | null, channel: string, payload: unknown): void {
  if (id === null) return
  const entry = appWindows.get(id)
  if (!entry || entry.win.isDestroyed()) return
  try {
    entry.win.webContents.send(channel, payload)
  } catch {
    // 窗口刚销毁：进度/结果丢了不影响上传本身
  }
}

function mainWindowEntry(): AppWindow | null {
  for (const entry of appWindows.values()) {
    if (entry.role === 'main' && !entry.win.isDestroyed()) return entry
  }
  return null
}

function focusedEntry(): AppWindow | null {
  if (focusedWindowId === null) return null
  return appWindows.get(focusedWindowId) ?? null
}

/**
 * 同步「最近聚焦的项目」（**仅用于展示**：`/status` 的 currentProject 与界面状态栏）。
 * 策略 D′：执行路径的项目由请求显式给出，这里不再作为缺省值（聚焦主窗口或无项目窗口时为 null）。
 */
function syncCurrentProject(): void {
  const focused = focusedEntry()
  const projectPath = focused && focused.role === 'project' ? focused.projectPath : null
  if (projectContext.getCurrent() !== projectPath) projectContext.setCurrent(projectPath)
  trayHandle?.refresh()
}
let configStore: ConfigStore
let fileService: FileService
let gitService: GitService
let deployService: DeployService
/** 桌面当前项目（仅内存，随打开/关闭项目同步；策略 D） */
const projectContext = new ProjectContext()
/** 上传互斥队列（单会话串行；任务状态仅内存，CON-10） */
/**
 * 服务端配置的内存快照（启停与保存配置时更新）。
 *
 * 状态推送会随任务提交/结束/逐文件进度高频触发，此前每次都 `loadServerConfig` 读盘 ——
 * 而它还会在令牌不可用时**写盘自愈**，等于把磁盘 I/O 挂在了高频推送路径上。
 */
let serverConfigCache: { enabled: boolean; bind: ServerConfig['bind']; allowedRoots: string[] } = {
    enabled: false,
    bind: 'local',
    allowedRoots: []
  }

/**
 * 状态版本号：每次生成状态快照（推送**或**主动读取）都自增。
 *
 * 渲染层用它的丢弃「迟到的旧快照」：GET /status 与推送是两条无序的路径，
 * 旧响应后到会把新状态盖回去（典型表现：任务已结束，界面又变回「上传中」且再无推送）。
 * 在同一个同步块里「读状态 + 取号」，保证快照与号码同拍。
 */
let statusRevision = 0
function nextStatusRevision(): number {
  return ++statusRevision
}

/** 服务端状态与队列快照（状态栏展示；仅内存，无轮询） */
function broadcastServerStatus(): void {
  const config = serverConfigCache
  broadcast(IpcChannels.SERVER_STATUS_CHANGED, {
    listening: serverSnapshot.listening,
    port: serverSnapshot.port,
    bound: serverSnapshot.bound,
    error: serverSnapshot.error,
    enabled: config.enabled,
    bind: config.bind,
    queue: deployQueue.snapshot(),
    revision: nextStatusRevision()
  })
  // 托盘状态文本也含队列/项目数：不刷新的话右键菜单永远停在“上次构建时”的值
  trayHandle?.refresh()
}

const deployQueue = createQueue({
  // 队列回调（含 webContents.send）抛错时留诊断：队列会吞掉它，这里负责不让它静默
  onCallbackError: (where, error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[shipit] 队列回调异常（${where}）：${message}\n`)
  },
  // 队列任务结束时把结果推给界面日志，标注来源（desktop / cli / mcp）与来源地址；
  // 日志仅存在于内存，不写磁盘（CON-6）
  onTaskChanged: () => {
    broadcastServerStatus()
  },
  onTaskSettled: (record) => {
    // 窗口可能已被销毁（退出流程）：broadcast 内部已跳过已销毁窗口
    broadcast(IpcChannels.DEPLOY_LOG_ENTRY, {
      taskId: record.taskId,
      targetName: record.target,
      timestamp: record.finishedAt ?? Date.now(),
      totalFiles: record.result?.totalFiles ?? record.totalFiles,
      succeeded: record.result?.succeeded ?? 0,
      failed: record.result?.failed ?? 0,
      skipped: record.result?.skipped ?? 0,
      duration: record.result?.duration ?? 0,
      details: record.result?.details ?? [],
      cancelled: record.cancelled ?? false,
      origin: record.origin,
      projectRoot: record.projectRoot,
      ...(record.remoteAddress ? { remoteAddress: record.remoteAddress } : {})
    })
  }
})
let localServer: LocalServer | null = null
let trayHandle: TrayHandle | null = null
/**
 * 设置窗口是否有未保存改动（由设置窗口上报）。
 * 关闭设置窗口时用它守门：有改动就先就地确认，避免关窗即丢配置（H3/H5）。
 */
let settingsDirty = false

/** 托盘退出是唯一退出入口：退出过程中不再拦截关窗（INV-7） */
let isQuitting = false
/** 窗口数量提示是否已提示过（每个应用会话只提示一次，避免多开时反复打扰） */
let windowLimitHintShown = false
/** 待渲染层取走的窗口数量提示（push 与渲染层订阅存在竞态，pull 兜底） */
let pendingWindowLimitHint: { count: number; limit: number; windowId: number } | null = null
/** 服务端运行时快照（供托盘状态与状态接口使用） */
let serverSnapshot: { listening: boolean; port: number | null; bound: string; error?: string } = {
  listening: false,
  port: null,
  bound: ''
}
/** 服务端处理器注入点：任务 8~12 逐个绑定，未绑定的接口视为未启用 */
let serverHandlers: Partial<Handlers> = {}

/**
 * 创建窗口。角色决定初始视图：主窗口 = 项目选择页；项目窗口直达该项目的工区。
 * 项目路径通过 `additionalArguments` 传给渲染进程（preload 读取，见 windowArguments）。
 */
function createAppWindow(opts: {
  role: WindowRole
  projectPath?: string | null
  section?: SettingsSection
}): BrowserWindow {
  const projectPath = opts.role === 'project' ? (opts.projectPath ?? null) : null
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: windowTitle(opts.role, projectPath),
    icon: appIconPath(),
    // 先不显示：等渲染进程首帧绘制完再显示，否则会看到约 1 秒的白屏
    // （新窗口默认立即显示，而 HTML/CSS/JS 还没加载完）
    show: false,
    // 窗口底色跟随主题（首帧之前露出的就是它，而不是系统白）
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        ...windowArguments(opts.role, projectPath),
        ...(opts.section ? [`${ARG_SECTION}${opts.section}`] : [])
      ]
    }
  })

  const id = win.webContents.id
  appWindows.set(id, { win, role: opts.role, projectPath, title: windowTitle(opts.role, projectPath) })

  // 首帧就绪 → 显示。兜底：若 ready-to-show 未触发（渲染进程加载失败等），
  // 3 秒后强制显示，避免"点了设置却没反应"。
  const showFallback = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 3000)
  win.once('ready-to-show', () => {
    clearTimeout(showFallback)
    if (!win.isDestroyed()) win.show()
  })
  win.on('closed', () => clearTimeout(showFallback))

  if (isDevMode()) {
    void win.loadURL('http://localhost:5173')
    // 默认**不自动打开** DevTools：多窗口下每个窗口都弹一个面板太吵。
    // 需要时用 SHIPIT_DEVTOOLS=1 启动，或按 F12 单独切换当前窗口（见下方快捷键）。
    if (process.env.SHIPIT_DEVTOOLS === '1') win.webContents.openDevTools()
    // 开发模式：F12 切换当前窗口的 DevTools（随时可用，不必重启）
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools()
      }
    })
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'))
  }

  // 页面 <title> 会覆盖窗口标题（Electron 默认行为）：多窗口下窗口标题是项目身份标识，
  // 必须由主进程独占管理 → 阻止页面改写标题。
  win.on('page-title-updated', (event) => {
    event.preventDefault()
    const current = appWindows.get(id)
    win.setTitle(current?.title ?? windowTitle(opts.role, projectPath))
  })

  // 聚焦即成为「当前项目」（决策 D-4）
  win.on('focus', () => {
    focusedWindowId = win.webContents.id
    syncCurrentProject()
  })

  // INV-7 / D-1：关窗不等于退出——托盘可用时所有窗口（含最后一个）都只隐藏
  win.on('close', (event) => {
    // 设置窗口：有未保存改动时拦下关闭，让窗口就地确认（继续编辑 / 放弃修改）
    if (opts.role === 'settings' && !isQuitting && settingsDirty) {
      event.preventDefault()
      win.webContents.send(IpcChannels.SETTINGS_CONFIRM_CLOSE)
      return
    }
    const action = closeActionFor({
      role: appWindows.get(id)?.role ?? opts.role,
      trayAvailable: trayHandle?.available === true,
      isQuitting
    })
    if (action !== 'hide') return // quit：放行；close：项目窗口真正关闭（关闭窗口即关闭该项目）
    event.preventDefault()
    win.hide()
  })

  win.on('closed', () => {
    if (opts.role === 'settings') settingsDirty = false
    // 项目窗口关闭 = 该项目不再使用：释放它的 git 缓存（否则长会话里只增不减）。
    // 以**注册表里的当前绑定**为准：窗口可能中途从主窗口认领了项目，
    // 用创建时的 opts.projectPath 会释放错项目（或该释放的没释放）。
    const current = appWindows.get(id)
    if (current?.projectPath) gitService.dispose(current.projectPath)
    appWindows.delete(id)
    if (focusedWindowId === id) focusedWindowId = null
    syncCurrentProject()
  })

  focusedWindowId = id
  syncCurrentProject() // 内部会刷新托盘（项目数/焦点变化）
  return win
}

/**
 * 托盘单击：聚焦最近聚焦的窗口（决策 D-4）；若已无窗口则创建/显示主窗口。
 * 与「打开主窗口」菜单项区分：后者始终针对主窗口。
 */
function focusMostRecentWindow(): void {
  const targetId = pickWindowToFocus(windowEntries(), focusedWindowId)
  if (targetId === null) showMainWindow()
  else focusWindowById(targetId)
}

/** 确保主窗口存在并显示（托盘「打开主窗口」/macOS activate 都走这里） */
function showMainWindow(): void {
  const existing = mainWindowEntry()
  if (existing) {
    if (existing.win.isMinimized()) existing.win.restore()
    existing.win.show()
    existing.win.focus()
    return
  }
  createAppWindow({ role: 'main' })
}

/**
 * 打开项目窗口：
 * - 同一项目已打开 → 聚焦已有窗口（决策 D-2：禁止同项目多开）
 * - 项目窗口数达到阈值 → 先提示（决策 D-5；不阻止）
 * 返回被聚焦/新建的窗口；path 非法时返回 null。
 */
function openProjectWindow(projectPath: string, callerId: number | null = focusedWindowId): BrowserWindow | null {
  const target = projectPath?.trim()
  if (!target) return null

  // 决策：已打开同项目 → 聚焦它；调用方是"没有项目的主窗口" → 就地打开；否则新开窗口
  const decision = decideOpenTarget(windowEntries(), callerId, target)
  if (decision.kind === 'focus') {
    focusWindowById(decision.windowId)
    return appWindows.get(decision.windowId)?.win ?? null
  }
  if (decision.kind === 'here' && callerId !== null && openProjectInWindow(callerId, target)) {
    return appWindows.get(callerId)?.win ?? null
  }

  const projectWindows = [...appWindows.values()].filter((entry) => !!entry.projectPath)
  const created = createAppWindow({ role: 'project', projectPath: target })

  // 窗口数量提示（D-5）：走**正式 IPC 通道**，只发给"刚打开的这个窗口"——
  // ① 原实现 broadcast 到一个无人订阅的硬编码 'toast' 通道，提示从未到达用户（D-5 实际未交付）；
  // ② 即便通道通了，广播也会让 N 个窗口各弹一次，噪音大于价值。
  // 渲染层订阅后弹应用内对话框；每个会话只提示一次（避免每多开一个窗口就打扰一次）。
  if (created && shouldPromptWindowLimit(projectWindows.length) && !windowLimitHintShown) {
    windowLimitHintShown = true
    pendingWindowLimitHint = { count: projectWindows.length + 1, limit: PROJECT_WINDOW_LIMIT, windowId: created.id }
    // push：渲染层若已订阅就直接显示（多数情况）。
    // push 后立即清空 pending：否则下一次新建窗口的 take() 会取走这份陈旧提示并自己弹一次
    // （提示会串到错误的窗口、计数还是上一刻的，"每会话一次"也就失效了）。
    const hint = pendingWindowLimitHint
    pendingWindowLimitHint = null
    created.webContents.once('did-finish-load', () => {
      if (!created.isDestroyed() && hint) {
        created.webContents.send(IpcChannels.WINDOW_LIMIT_HINT, hint)
      }
    })
  }
  return created
}

/**
 * 让指定窗口就地打开项目：**只发指令**，不提前登记为项目窗口。
 *
 * 角色升级由渲染层的 `setProject` → `PROJECT_SET_CURRENT` 驱动（加载成功才绑定）：
 * 否则加载失败时会留下"显示欢迎页、却登记为项目窗口"的不一致。
 */
function openProjectInWindow(id: number, projectPath: string): boolean {
  const entry = appWindows.get(id)
  if (!entry || entry.win.isDestroyed()) return false
  entry.win.webContents.send(IpcChannels.MENU_OPEN_PROJECT, projectPath)
  return true
}

/**
 * 打开/聚焦**全局设置窗口**（单实例）。
 *
 * 全局配置（上传目标、本地服务）是应用级单份数据：让它只有一个可写窗口，
 * 并发编辑冲突就"结构上不可能"发生（比事后提示更可靠）。
 * 已存在则聚焦并切到指定标签页；不存在则创建（role=settings，关窗即销毁）。
 */
function showSettingsWindow(section: SettingsSection = 'targets'): void {
  for (const entry of appWindows.values()) {
    if (entry.role !== 'settings' || entry.win.isDestroyed()) continue
    if (entry.win.isMinimized()) entry.win.restore()
    entry.win.show()
    entry.win.focus()
    entry.win.webContents.send(IpcChannels.SETTINGS_SECTION, section)
    return
  }
  // 初始标签页随启动参数传入（窗口首次加载即可用，不必等 did-finish-load）
  createAppWindow({ role: 'settings', section })
}

/** 聚焦指定窗口（托盘菜单/同项目聚焦） */
function focusWindowById(id: number): void {
  const entry = appWindows.get(id)
  if (!entry || entry.win.isDestroyed()) return
  if (entry.win.isMinimized()) entry.win.restore()
  entry.win.show()
  entry.win.focus()
}

/** 是否开发模式（多处判定，抽出来避免各处硬编码环境变量名） */
function isDevMode(): boolean {
  return process.env.NODE_ENV === 'development'
}

/** 托盘与窗口图标路径（打包后从 resources 读取） */
function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../build/icon.png')
}

/** 托盘状态文本：服务 + 项目数 + 队列（按需生成，不做定时轮询，DFX-PERF-005） */
function serverStatusText(): string {
  const parts: string[] = []
  if (serverSnapshot.error) parts.push(`服务异常：${serverSnapshot.error}`)
  else if (!serverSnapshot.listening) parts.push('本地服务未开启')
  else {
    const scope = serverSnapshot.bound === '0.0.0.0' ? '局域网' : '仅本机'
    parts.push(`本地服务运行中：端口 ${serverSnapshot.port}（${scope}）`)
  }
  // 队列与项目数是多窗口下最需要一眼看到的信息（multi-window plan 承诺的托盘状态口径）
  const projects = [...appWindows.values()].filter(
    (entry) => entry.role === 'project' && !entry.win.isDestroyed()
  )
  if (projects.length > 0) parts.push(`${projects.length} 个项目`)
  parts.push(queueTextOf(deployQueue.snapshot()))
  return parts.join(' · ')
}

/** 服务端启停串行链：启停互相串行，避免并发建/拆监听器导致引用丢失与端口泄漏 */
let serverLifecycleChain: Promise<void> = Promise.resolve()

function onServerLifecycle(task: () => Promise<void>): Promise<void> {
  const next = serverLifecycleChain.then(task, task)
  serverLifecycleChain = next.catch(() => undefined)
  return next
}

/** 启动本地服务端（按配置；未开启时不做任何监听，INV-4） */
function startLocalServer(): Promise<void> {
  return onServerLifecycle(async () => {
    if (localServer) await localServer.stop()
    const config = await loadServerConfig(configStore.path)
    serverConfigCache = { enabled: config.enabled, bind: config.bind, allowedRoots: config.allowedRoots }
    localServer = createLocalServer({
      config,
      dataDir: dirname(configStore.path),
      handlers: serverHandlers,
      // 监听建立后的运行时异常必须有人接住：未处理的 'error' 事件会直接崩掉主进程
      onError: (error) => {
        serverSnapshot = { ...serverSnapshot, error: error.message }
        // 广播内部已刷新托盘（状态文本含队列/项目数），不再重复构建菜单
        broadcastServerStatus()
      }
    })
    // start() 已保证不 reject（同步抛错会被收成 StartResult）；这里再兜一层，
    // 确保意外情况也不会让主进程带着半初始化状态崩掉，而是如实体现在状态里。
    try {
      const result = await localServer.start()
      serverSnapshot = result.listening
        ? { listening: true, port: result.port, bound: result.bound }
        : { listening: false, port: null, bound: '', error: result.error?.message }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      serverSnapshot = { listening: false, port: null, bound: '', error: `本地服务启动失败：${message}` }
    }
    // 广播内部已刷新托盘（状态文本含队列/项目数），不再重复构建菜单
    broadcastServerStatus()
  })
}

function stopLocalServer(): Promise<void> {
  return onServerLifecycle(async () => {
    if (localServer) await localServer.stop()
    serverSnapshot = { listening: false, port: null, bound: '' }
    // 广播内部已刷新托盘（状态文本含队列/项目数），不再重复构建菜单
    broadcastServerStatus()
  })
}

/** 创建托盘；不可用时关窗即退出，避免留下无法操作的进程 */
/**
 * 托盘可交互动作。抽成函数是为了让「创建托盘」与「菜单自检」共用同一份定义，
 * 避免两处漂移（排查"菜单里少了一项"这类问题时，自检结果必须与实际菜单同源）。
 */
function trayActions(): TrayActions {
  return {
    // 单击托盘：聚焦最近聚焦的窗口；菜单「打开主窗口」：始终给主窗口
    openWindow: focusMostRecentWindow,
    openMainWindow: showMainWindow,
    // 状态项可点：直接进服务配置（托盘里最显眼的入口，别只当只读文本）
    openServerSettings: () => showSettingsWindow('server'),
    openSettings: () => showSettingsWindow('targets'),
    focusWindow: (id: number) => focusWindowById(id),
    // 唯一退出入口：交给 before-quit 统一处理（等上传收尾 → 停服务 → 退出，决策 D-3）
    quit: () => app.quit(),
    statusText: serverStatusText,
    entries: windowEntries,
    focusedWindowId: () => focusedWindowId
  }
}

function createTrayIfPossible(): void {
  trayHandle = createTray(trayActions(), appIconPath())
}

/** 原生菜单已移除：菜单栏改由渲染进程自绘（VS Code 风格，见 AppMenuBar.vue） */
function disableNativeMenu() {
  Menu.setApplicationMenu(null)
}

/** 让 Electron 原生 UI（滚动条/系统对话框）跟随应用主题 */
function applyNativeTheme(theme: string) {
  try {
    if (theme === 'dark') nativeTheme.themeSource = 'dark'
    else if (theme === 'light') nativeTheme.themeSource = 'light'
    else nativeTheme.themeSource = 'system'
  } catch { /* ignore */ }
}

async function openProjectDialog(parent?: BrowserWindow | null) {
  const owner = parent && !parent.isDestroyed() ? parent : (focusedEntry()?.win ?? mainWindowEntry()?.win)
  const result = await dialog.showOpenDialog(owner!, {
    properties: ['openDirectory'],
    title: '选择项目目录'
  })
  if (result.canceled || result.filePaths.length === 0) return

  const projectPath = result.filePaths[0]
  await openProjectPath(projectPath)
}

/**
 * 打开项目：记入最近列表 + 新开（或聚焦）项目窗口。
 * 多窗口下不再把项目塞进「当前窗口」，而是每项目一个窗口（决策 D-2）。
 */
async function openProjectPath(projectPath: string, callerId: number | null = focusedWindowId) {
  await configStore.addRecentProject(projectPath)
  openProjectWindow(projectPath, callerId)
}

function registerIpcHandlers() {
  // 渲染进程同步 UI 状态：仅需同步原生主题（菜单勾选态由自绘菜单栏本地管理）
  ipcMain.on(IpcChannels.MENU_SYNC_STATE, (_e, s: { theme?: string }) => {
    if (s?.theme) applyNativeTheme(s.theme)
  })

  // 应用版本（来自打包时的 package.json，UI 与安装包版本同源）
  ipcMain.handle(IpcChannels.APP_GET_VERSION, () => app.getVersion())

  // 打开全局设置窗口（指定标签页）：项目/主窗口的「上传目标管理」「本地服务管理」都走这里
  ipcMain.handle(IpcChannels.SETTINGS_OPEN, async (_event, section: unknown) => {
    showSettingsWindow(section === 'server' ? 'server' : 'targets')
    return null
  })

  // 设置窗口上报未保存状态（关窗守门用）
  ipcMain.on(IpcChannels.SETTINGS_DIRTY, (_event, dirty: unknown) => {
    settingsDirty = dirty === true
  })

  // 本窗口的权威状态（窗口角色会随绑定/解绑项目变化，渲染层不能用启动参数判断）
  ipcMain.handle(IpcChannels.WINDOW_GET_STATE, async (_event) => {
    const entry = appWindows.get(_event.sender.id)
    if (!entry) return { role: 'main' as const, projectPath: null }
    return { role: entry.role, projectPath: entry.projectPath }
  })

  // 本窗口自我关闭（渲染进程用）：项目窗口 → 关闭该项目对应的窗口；主窗口 → 走隐藏逻辑
  ipcMain.handle(IpcChannels.WINDOW_CLOSE_SELF, async (_event) => {
    const entry = appWindows.get(_event.sender.id)
    if (!entry || entry.win.isDestroyed()) return null
    entry.win.close()
    return null
  })

  // 托盘菜单自检：返回菜单标签（含子菜单），用于核对"菜单里到底渲染了哪些项"
  ipcMain.handle('window:menu-labels', async () => {
    const labels: string[] = []
    const walk = (items: unknown[]): void => {
      for (const raw of items) {
        const item = raw as { type?: string; label?: string; submenu?: unknown[] }
        if (item.type === 'separator') labels.push('---')
        else labels.push(String(item.label ?? '(无标签)'))
        if (Array.isArray(item.submenu)) walk(item.submenu)
      }
    }
    walk(trayMenuTemplate(trayActions()) as unknown[])
    return labels
  })

  // 窗口列表（多窗口可观测性：界面/测试可读，也便于排查"窗口与项目对不上"）
  ipcMain.handle(IpcChannels.WINDOW_LIST, async () => ({
    focusedWindowId,
    // 托盘可用性：决定"关窗是否退进程"（多窗口下必须为 true，否则最后一个窗口关掉就会退出）
    trayAvailable: trayHandle?.available === true,
    windows: windowEntries()
  }))

  // ========== 自绘菜单栏动作分发 ==========
  ipcMain.handle(IpcChannels.APP_ACTION, async (_e, action: string, payload?: any) => {
    switch (action) {
      case 'open-project':
        await openProjectDialog(BrowserWindow.fromWebContents(_e.sender))
        break
      case 'open-recent':
        if (payload) await openProjectPath(payload)
        break
      case 'clear-recent': {
        const cfg = await configStore.load()
        cfg.recentProjects = []
        await configStore.save()
        break
      }
      case 'remove-recent':
        // 单条移除：列表里的坏条目（误加的目录、已删除的项目）要能被清掉
        if (typeof payload === 'string' && payload) await configStore.removeRecentProject(payload)
        break
      case 'open-settings':
        // 所有窗口的配置入口都汇聚到这里 → 全局设置窗口（单实例）
        showSettingsWindow(payload === 'server' ? 'server' : 'targets')
        break
      case 'open-main-window':
        // 与托盘菜单「打开主窗口」同一语义（始终给主窗口）
        showMainWindow()
        break
      case 'focus-most-recent':
        // 与托盘单击同一语义（聚焦最近聚焦的窗口）
        focusMostRecentWindow()
        break
      case 'quit':
        app.quit()
        break
      case 'reload':
        _e.sender.reload()
        break
      default:
        break
    }
    return null
  })

  // ========== 项目操作 ==========
  ipcMain.handle(IpcChannels.PROJECT_OPEN, async () => {
    await openProjectDialog()
    return null // 通过 MENU_OPEN_PROJECT 事件返回
  })

  // 按项目记忆的界面状态（视图 / 日志面板 / Git 筛选）：每窗口一份，重启后恢复
  ipcMain.handle(IpcChannels.PROJECT_VIEW_GET, async (_event, projectPath: string) => {
    // 参数校验：非法调用不应让主进程抛错（IPC 边界是可信边界，但仍要防脏输入）
    if (typeof projectPath !== 'string' || !projectPath.trim()) return null
    return configStore.getProjectViewState(projectPath)
  })

  ipcMain.handle(IpcChannels.PROJECT_VIEW_SAVE, async (_event, projectPath: string, patch: unknown) => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) return null
    if (!patch || typeof patch !== 'object') return null
    await configStore.saveProjectViewState(projectPath, patch as never)
    return null
  })

  // 打开项目文件夹（拖拽到窗口 / 外部入口）：只接受存在的目录，避免误把文件当项目
  // 拉取式兜底：渲染层的订阅注册可能晚于 push（onMounted 里有 await），取一次保证不丢
  ipcMain.handle(IpcChannels.WINDOW_LIMIT_HINT_TAKE, (_event) => {
    // 只给"待接收的窗口"：pending 记录目标窗口，避免并发加载时被别的窗口抢走
    if (pendingWindowLimitHint && pendingWindowLimitHint.windowId !== _event.sender.id) return null
    const hint = pendingWindowLimitHint
    pendingWindowLimitHint = null
    return hint ? { count: hint.count, limit: hint.limit } : null
  })

  ipcMain.handle(IpcChannels.PROJECT_OPEN_FOLDER, async (_event, folderPath: string) => {
    if (!folderPath || typeof folderPath !== 'string') return { ok: false as const, reason: '路径为空' }
    try {
      const stat = await fsPromises.stat(folderPath)
      if (!stat.isDirectory()) return { ok: false as const, reason: '只能打开文件夹' }
    } catch {
      return { ok: false as const, reason: '目录不存在或无法访问' }
    }
    // 发起窗口就是"当前窗口"：主窗口打开项目即就地成为该项目的窗口
    await openProjectPath(folderPath, _event.sender.id)
    return { ok: true as const }
  })

  ipcMain.handle(IpcChannels.PROJECT_GET_RECENT, async () => {
    const config = await configStore.load()
    return config.recentProjects
  })

  // ========== 文件树 ==========
  ipcMain.handle(IpcChannels.FILE_TREE_GET, async (_event, rootPath: string) => {
    // 目录不存在/不可访问时显式报错（异步校验，避免阻塞主进程），供渲染进程提示并回退
    try {
      await fsPromises.access(rootPath)
    } catch {
      throw new Error(`目录不存在或无法访问：${rootPath}`)
    }
    return fileService.buildTree(rootPath)
  })

  ipcMain.handle(IpcChannels.FILE_EXPAND_DIR, async (_event, dirPath: string) => {
    return fileService.expandDirectory(dirPath)
  })

  ipcMain.handle(IpcChannels.FILE_COLLECT_FILES, async (_event, dirPath: string) => {
    return fileService.collectAllFiles(dirPath)
  })

  // ========== Git 状态 ==========
  ipcMain.handle(IpcChannels.GIT_CHECK_REPO, async (_event, dir: string) => {
    return gitService.isGitRepo(dir)
  })

  ipcMain.handle(IpcChannels.GIT_BRANCHES, async (_event, dir: string) => {
    return gitService.getBranches(dir)
  })

  ipcMain.handle(IpcChannels.GIT_AUTHORS, async (_event, dir: string) => {
    return gitService.getAuthors(dir)
  })

  ipcMain.handle(IpcChannels.GIT_STATUS, async (_event, dir: string) => {
    return gitService.getStatusView(dir)
  })

  ipcMain.handle(IpcChannels.GIT_LOG, async (_event, dir: string, options?: { branch?: string; author?: string; maxCount?: number }) => {
    return gitService.getLogView(dir, options)
  })

  ipcMain.handle(IpcChannels.GIT_DIFF, async (_event, dir: string, filePath: string) => {
    return gitService.getFileDiff(dir, filePath)
  })

  ipcMain.handle(IpcChannels.GIT_COMMIT_FILES, async (_event, dir: string, hash: string) => {
    return gitService.getCommitFiles(dir, hash)
  })

  ipcMain.handle(IpcChannels.DIALOG_OPEN_FILE, async (_event, options: any) => {
    const owner = BrowserWindow.fromWebContents(_event.sender) ?? focusedEntry()?.win ?? mainWindowEntry()?.win
    const result = await dialog.showOpenDialog(owner!, options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ========== 部署 ==========
  ipcMain.handle(IpcChannels.DEPLOY_TEST_CONN, async (_event, target: any) => {
    return deployService.testConnection(target)
  })

  // 预览：主进程计算实际要上传的任务列表（供弹窗展示，保证与实际一致）
  ipcMain.handle(IpcChannels.DEPLOY_PREVIEW, async (_event, files: string[], projectRoot: string, target: any) => {
    return deployService.buildUploadTasks(files, projectRoot, target)
  })

  // 执行：直接上传已确认的任务列表（与预览完全一致）
  ipcMain.handle(IpcChannels.DEPLOY_UPLOAD, async (_event, tasks: any[], target: any, projectRoot?: string) => {
    const result = await deployService.deploy(
      tasks,
      target,
      (_current: number, _total: number, _file: string) => {
        // 逐文件进度只回发起窗口（进度条属于该窗口的会话）
        sendToWindow(_event.sender.id, IpcChannels.DEPLOY_PROGRESS, { current: _current, total: _total, file: _file })
      },
      'desktop', // 来源标注：取消只作用于桌面自身的上传
      // 窗口粒度：多窗口下 B 窗口点「取消」不得打断 A 窗口正在跑的上传
      { windowId: _event.sender.id }
    )
    // 桌面直连上传不进队列，其他窗口的日志面板默认看不到这次上传：
    // 结果统一广播（发起窗口按 taskId 去重），与 CLI/MCP 任务的可见性保持一致。
    broadcast(IpcChannels.DEPLOY_LOG_ENTRY, {
      taskId: result.taskId,
      targetName: result.targetName,
      timestamp: result.timestamp,
      totalFiles: result.totalFiles,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
      duration: result.duration,
      details: result.details,
      cancelled: result.cancelled === true,
      origin: 'desktop',
      ...(projectRoot ? { projectRoot } : {})
    })
    return result
  })

  // 取消当前部署（只取消**本窗口**发起的桌面会话，不误伤 CLI/MCP 与其他窗口）
  ipcMain.handle(IpcChannels.DEPLOY_CANCEL, async (_event) => {
    deployService.abort('desktop', _event.sender.id)
  })

  // ========== 配置管理 ==========
  ipcMain.handle(IpcChannels.CONFIG_LOAD, async () => {
    return configStore.load()
  })

  ipcMain.handle(IpcChannels.CONFIG_SAVE, async (_event, config: any) => {
    if (config && typeof config === 'object') {
      // 用 patchOwned 而不是 replace+save：
      // 渲染层既会发"整份 config"（主题等），也会发"单字段"（切换当前目标）；
      // patchOwned 在写锁内只合并独占键，单字段保存不会把 targets/最近项目写成空。
      await configStore.patchOwned(config as Parameters<typeof configStore.patchOwned>[0])
    }
    broadcastConfigChanged()
    return configStore.load()
  })

  // ========== 目标管理 ==========
  ipcMain.handle(IpcChannels.TARGET_LIST, async () => {
    const config = await configStore.load()
    return config.deploymentTargets
  })

  ipcMain.handle(IpcChannels.TARGET_ADD, async (_event, target: any) => {
    const saved = await configStore.addTarget(target)
    broadcastConfigChanged()
    return saved
  })

  ipcMain.handle(IpcChannels.TARGET_UPDATE, async (_event, id: string, updates: any) => {
    const saved = await configStore.updateTarget(id, updates)
    broadcastConfigChanged()
    return saved
  })

  ipcMain.handle(IpcChannels.TARGET_REMOVE, async (_event, id: string) => {
    const saved = await configStore.removeTarget(id)
    broadcastConfigChanged()
    return saved
  })

  ipcMain.handle(IpcChannels.MAPPING_ADD, async (_event, targetId: string, mapping: any) => {
    const saved = await configStore.addMapping(targetId, mapping)
    broadcastConfigChanged()
    return saved
  })

  ipcMain.handle(IpcChannels.MAPPING_UPDATE, async (_event, targetId: string, mappingId: string, updates: any) => {
    const saved = await configStore.updateMapping(targetId, mappingId, updates)
    broadcastConfigChanged()
    return saved
  })

  ipcMain.handle(IpcChannels.MAPPING_REMOVE, async (_event, targetId: string, mappingId: string) => {
    const saved = await configStore.removeMapping(targetId, mappingId)
    broadcastConfigChanged()
    return saved
  })

  // ========== 本地服务端 ==========
  // 桌面项目同步（仅内存）：CLI/MCP 缺省项目以此为准
  // 窗口内切换项目：只更新**该窗口**的项目归属（当前项目由聚焦决定，决策 D-2/D-4）
  ipcMain.handle(IpcChannels.PROJECT_SET_CURRENT, async (_event, projectPath: string | null) => {
    const entry = appWindows.get(_event.sender.id)
    if (entry) {
      // 角色随项目绑定/解绑变化：有项目=项目窗口（关窗=关项目），无项目=主窗口（关窗=隐藏）
      entry.projectPath = projectPath
      entry.role = projectPath ? 'project' : 'main'
      entry.title = windowTitle(entry.role, entry.projectPath)
      if (!entry.win.isDestroyed()) entry.win.setTitle(entry.title)
    }
    if (focusedWindowId === _event.sender.id) syncCurrentProject()
    trayHandle?.refresh()
    return entry?.projectPath ?? null
  })

  ipcMain.handle(IpcChannels.SERVER_GET_CONFIG, async () => {
    return loadServerConfig(configStore.path)
  })

  ipcMain.handle(IpcChannels.SERVER_SAVE_CONFIG, async (_event, patch: Partial<ServerConfig>) => {
    // 令牌门槛由配置模块把关（主进程是可信边界，渲染层校验只是提示）：
    // 不可用令牌（空串/过短）在这里被拒绝，不会落盘。
    const saved = await saveServerConfig(configStore.path, patch ?? {})
    if (!saved.ok) return { ok: false as const, reason: saved.reason }
    serverConfigCache = { enabled: saved.config.enabled, bind: saved.config.bind, allowedRoots: saved.config.allowedRoots }
    await startLocalServer()
    broadcastConfigChanged()
    return { ok: true as const, config: saved.config, status: serverSnapshot }
  })

  ipcMain.handle(IpcChannels.SERVER_GET_STATUS, async () => {
    const config = await loadServerConfig(configStore.path)
    // 下面的读取全部在 await 之后同步完成：快照与 revision 必须同一拍，
    // 否则会出现「旧数据 + 新版本号」，渲染层会把旧数据当成最新状态接受。
    return {
      listening: serverSnapshot.listening,
      port: serverSnapshot.port,
      bound: serverSnapshot.bound,
      error: serverSnapshot.error,
      enabled: config.enabled,
      bind: config.bind,
      protocolVersion: PROTOCOL_VERSION,
      fingerprint: localServer?.fingerprint() ?? null,
      connectionFile: localServer?.connectionFilePath() ?? null,
      // 队列与当前项目：界面与状态接口口径一致（FR-011 / FR-012）
      queue: deployQueue.snapshot(),
      currentProject: projectContext.getCurrent(),
      revision: nextStatusRevision()
    }
  })

  ipcMain.handle(IpcChannels.SERVER_EXPORT_CONNECTION, async () => {
    const config = await loadServerConfig(configStore.path)
    const fingerprint = localServer?.fingerprint() ?? null
    const port = serverSnapshot.port
    if (!serverSnapshot.listening || !fingerprint || port === null) {
      return { ok: false as const, reason: '服务未运行，无法导出连接串' }
    }
    // 局域网绑定时给出本机可被对端访问的 IPv4，否则明确为回环地址
    let host = '127.0.0.1'
    if (config.bind === 'lan') {
      const candidates = Object.values(networkInterfaces())
        .flat()
        .filter((info): info is NonNullable<typeof info> => !!info && info.family === 'IPv4' && !info.internal)
      host = candidates[0]?.address ?? '127.0.0.1'
    }
    const connection: ExportedConnection = { host, port, token: config.token, protocolVersion: PROTOCOL_VERSION, fingerprint }
    return { ok: true as const, connection, text: connectionString(connection) }
  })

  ipcMain.handle(IpcChannels.SERVER_REGENERATE_TOKEN, async () => {
    const config = await rotateToken(configStore.path)
    await startLocalServer() // 令牌变更后重启监听，连接信息文件同步刷新
    return { config }
  })
}

app.whenReady().then(async () => {
  configStore = new ConfigStore()
  fileService = new FileService()
  gitService = new GitService()
  deployService = new DeployService()

  // 启动即应用持久化主题（原生滚动条/系统对话框跟随）
  const savedTheme = (await configStore.load()).theme || 'auto'
  applyNativeTheme(savedTheme)

  // 服务端处理器：桌面界面、CLI、MCP 共用同一份执行逻辑（INV-2）
  serverHandlers = createServerHandlers(
    {
      loadTargets: async () => (await configStore.load()).deploymentTargets,
      testConnection: (target) => deployService.testConnection(target),
      // 项目解析 + 作用域（D-25）：本机回环不限；局域网只允许"已打开项目 + 允许的项目根"
      resolveProject: (input) =>
        projectContext.resolve(input, {
          enforce: serverConfigCache.bind === 'lan',
          allowedRoots: serverConfigCache.allowedRoots,
          openedProjects: projectPaths()
        }),
      // 仅展示用：最近聚焦的项目根
      projectContext: { currentProject: () => projectContext.getCurrent() },
      // 桌面直连会话（不进队列）：状态接口与状态栏据此显示"上传中"
      activeSessions: () =>
      deployService.activeSessions().map((session) => ({
        owner: session.owner,
        target: session.target,
        ...(session.windowId === undefined ? {} : { windowId: session.windowId })
      })),
      projectScope: () => ({ enforce: serverConfigCache.bind === 'lan', allowedRoots: serverConfigCache.allowedRoots }),
      // 项目发现（策略 D′ 下调用方必须能知道桌面开着哪些项目）
      listProjects: async () =>
        windowEntries()
          .filter((entry) => !!entry.projectPath)
          .map((entry) => ({
            path: entry.projectPath as string,
            name: projectNameOf(entry.projectPath as string),
            windowId: entry.id,
            focused: entry.id === focusedWindowId
          })),
      selection: {
        isGitRepo: (dir) => gitService.isGitRepo(dir),
        listChangedFiles: async (dir) => (await gitService.getStatusView(dir)).changes.map((c) => c.relativePath),
        listCommitFiles: async (dir, ref) => (await gitService.getCommitFiles(dir, ref)).map((f) => f.path),
        // 上传遍历：包含 dist 等构建产物（浏览用的 collectAllFiles 会跳过它们）
        listFilesInDir: (dir, maxFiles) => fileService.collectFilesForUpload(dir, maxFiles),
        exists: async (abs) => {
          try {
            await fsPromises.stat(abs)
            return true
          } catch {
            return false
          }
        }
      },
      buildUploadTasks: (files, projectRoot, target) => deployService.buildUploadTasks(files, projectRoot, target),
      git: {
        isGitRepo: (dir) => gitService.isGitRepo(dir),
        getStatusView: (dir) => gitService.getStatusView(dir),
        getLogView: (dir, options) => gitService.getLogView(dir, options),
        getBranches: (dir) => gitService.getBranches(dir)
      },
      queue: deployQueue,
      getVersion: () => app.getVersion(),
      // 队列任务标 owner='queue'：桌面「取消」不会中止这里的上传（INV-6）
      // 把队列的取消信号传下去：看门狗超时时真正中止传输，否则串行链一直被占着
      deploy: (tasks, target, onProgress, jobCtx) =>
        deployService.deploy(tasks, target, onProgress, 'queue', { signal: jobCtx?.signal })
    },
    () => ({ listening: serverSnapshot.listening, port: serverSnapshot.port, bound: serverSnapshot.bound })
  )

  disableNativeMenu()
  registerIpcHandlers()
  // 先起主窗口（项目选择页），再按启动参数打开项目窗口（双击/命令行带路径时）
  showMainWindow()
  createTrayIfPossible()
  openStartupProjectIfAny()
  // 配置已开启时启动监听；未开启时不监听（INV-4）
  await startLocalServer()

  app.on('activate', () => {
    // macOS：点 Dock 图标时确保有窗口（优先最近聚焦，无则主窗口）
    const targetId = pickWindowToFocus(windowEntries(), focusedWindowId)
    if (targetId === null) showMainWindow()
    else focusWindowById(targetId)
  })
})

/** 启动参数里带了项目路径（双击/命令行/文件关联）→ 校验是目录后打开该项目窗口 */
function openStartupProjectIfAny(): void {
  const { startupProject } = parseWindowArgs(process.argv)
  if (!startupProject) return
  void fsPromises.stat(startupProject).then(
    (stat) => {
      if (stat.isDirectory()) void openProjectPath(startupProject)
    },
    () => undefined // 路径不存在/不可访问：忽略（不是项目参数）
  )
}

// 单实例锁：多窗口必须单进程（两个实例会抢端口/互相覆盖连接信息）
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // 已有实例在运行：把参数交给它，然后退出自己
  app.exit(0)
} else {
  app.on('second-instance', (_event, argv) => {
    // 第二次启动：带项目路径则聚焦/打开该项目窗口，否则聚焦最近聚焦的窗口
    const { startupProject } = parseWindowArgs(argv)
    if (startupProject) {
      void openProjectPath(startupProject)
      return
    }
    const targetId = pickWindowToFocus(windowEntries(), focusedWindowId)
    if (targetId === null) showMainWindow()
    else focusWindowById(targetId)
  })
}

/** 退出前等待上传收尾的上限：等太久会让用户以为「关不掉」，超时就如实记录并退出 */
const SHUTDOWN_GRACE_MS = 5_000
  /** 用户在退出提示里选择「继续等待」时的额外宽限（与按钮文案一致） */
  const SHUTDOWN_EXTRA_WAIT_MS = 30_000
let shutdownInProgress = false

// 退出前先等上传任务收尾（有上限），再停止本地服务并删除连接信息文件，避免留下失效的连接信息。
// 此前是「立即退出」：上传会被静默截断且无任何记录（INV-9：失败/中断不得伪装成成功）。
app.on('before-quit', (event) => {
  isQuitting = true
  if (shutdownInProgress) return // 收尾完成后由我们自己触发的再次 quit：放行
  const snapshot = deployQueue.snapshot()
  // 桌面界面**直接**调用 deploy()（不进队列），只看队列会误判"空闲"→ 退出时静默截断桌面正在跑的上传
  const desktopSessions = deployService.activeSessions().filter((session) => session.owner === 'desktop')
  const busy = snapshot.state !== 'idle' || snapshot.pendingCount > 0 || desktopSessions.length > 0
  if (!busy && !localServer) return
  event.preventDefault()
  shutdownInProgress = true
  void (async () => {
    if (busy) {
      // 队列与桌面会话各等一份宽限。两者共用同一条串行链，**并行等待**时时间才不会叠加
      // （串行 await 时最坏是 2 × 5 秒，用户感觉“退出卡住”）
      const [queueDrained, sessionsIdle] = await Promise.all([
        deployQueue.drain(SHUTDOWN_GRACE_MS),
        deployService.waitForIdle(SHUTDOWN_GRACE_MS)
      ])
      if (!queueDrained || !sessionsIdle) {
        const pending = deployQueue.snapshot()
        const alive = deployService.activeSessions()
        process.stderr.write(
          `[shipit] 退出时仍有未完成的上传：队列运行中 ${pending.runningTaskId ?? '-'}，排队 ${pending.pendingCount} 个，` +
            `进行中会话 ${alive.length} 个（${alive.map((s) => `${s.owner}:${s.target}`).join('、') || '-'}）\n`
        )
        // 留痕不能只写 stderr：打包后的 GUI 进程没有控制台，用户看不到任何东西。
        // 有窗口就明确问一次：立即中断退出，还是再等一轮。
        const owner = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null
        if (owner) {
          const choice = await dialog.showMessageBox(owner, {
            type: 'warning',
            message: '仍有上传未完成',
            detail: `进行中的上传：${alive.map((s) => `${s.owner} → ${s.target}`).join('、') || '（队列任务）'}\n立即退出会中断上传，已传输的文件不会回滚。`,
            buttons: ['继续等待 30 秒', '立即退出'],
            defaultId: 0,
            cancelId: 0
          })
          if (choice.response === 0) {
            // 再等一轮：等到了就直接走完收尾，等不到也不再纠缠
            await deployService.waitForIdle(SHUTDOWN_EXTRA_WAIT_MS)
            await deployQueue.drain(SHUTDOWN_EXTRA_WAIT_MS)
          }
        }
      }
    }
    // 走启停串行链：避免与并发的启动/重配竞争（它们会拆/建监听器）
    await stopLocalServer()
    app.quit()
  })()
})

/**
 * 全局兜底。
 *
 * 桌面版是"执行唯一入口"的常驻进程：任何未捕获异常/拒绝都会让正在跑的上传随进程消失，
 * 而打包后的 GUI 进程没有控制台，用户只会看到应用凭空退出。
 * 这里至少保证 ① 有日志可查 ② 进程不因单个未处理拒绝而终止（真正的致命错误交给系统重启应用）。
 */
/**
 * 致命/异常错误的落盘日志。
 *
 * 为什么必须落盘：打包后的 GUI 进程**没有控制台**，只写 stderr 等于没有留痕 ——
 * 用户只会看到"上传消失/应用半死"，而我们拿不到任何可排查的信息。
 * 只保留最近若干行（追加 + 超过阈值时截断重写），避免无限增长。
 */
const LOG_KEEP_LINES = 500
function writeFatalLog(kind: string, detail: string): void {
  try {
    const dir = app.getPath('userData')
    const file = join(dir, 'error.log')
    const line = `${new Date().toISOString()} [${kind}] ${detail}\n`
    process.stderr.write(`[shipit] ${kind}：${detail}\n`)
    void (async () => {
      try {
        let prev = ''
        try {
          prev = await fsPromises.readFile(file, 'utf-8')
        } catch {
          prev = ''
        }
        const lines = (prev + line).split('\n')
        const kept = lines.slice(Math.max(0, lines.length - LOG_KEEP_LINES)).join('\n')
        await fsPromises.writeFile(file, kept, 'utf-8')
      } catch {
        // 日志写入失败不能再抛（否则递归触发 uncaughtException）
      }
    })()
  } catch {
    // 同上：兜底路径自身不允许抛错
  }
}

process.on('unhandledRejection', (reason) => {
  writeFatalLog('未处理的 Promise 拒绝', reason instanceof Error ? reason.message : String(reason))
})
process.on('uncaughtException', (error) => {
  writeFatalLog('未捕获异常', error?.message ?? String(error))
})

app.on('window-all-closed', () => {
  // 托盘常驻：进程继续提供本地服务（INV-7）；托盘不可用时按平台默认退出
  if (trayHandle?.available) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})