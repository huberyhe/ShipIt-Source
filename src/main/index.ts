import { app, BrowserWindow, globalShortcut, ipcMain, dialog, Menu, nativeTheme, shell } from 'electron'
import { join, dirname } from 'path'
import { networkInterfaces } from 'os'
import { promises as fsPromises, existsSync, mkdirSync, readFileSync } from 'fs'
import { ConfigStore } from './services/config-store'
import { IpcChannels } from '../shared/ipc-channels'
import {
  connectionString,
  loadServerConfig,
  rotateToken,
  saveServerConfig,
  type ExportedConnection
} from './services/server-config'
import { ProjectContext } from './services/project-context'
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

/**
 * 可选的「关硬件加速」开关（`SHIPIT_NO_GPU=1`）。
 *
 * 用途：远程桌面 / 虚拟机 / 低配机器。这些环境下软件光栅化反而不吃亏，
 * 而 Chromium 的 GPU 进程会固定占一份私有内存（实测约 60MB）与整份工作集。
 *
 * 必须在 app ready 之前调用，否则 Chromium 已完成 GPU 初始化，开关无效。
 * 默认行为不变（不设该变量时仍用硬件加速）。
 */
function applyGpuSwitch (): void {
  if (process.env.SHIPIT_NO_GPU !== '1') return
  app.disableHardwareAcceleration()
}

/**
 * 便携（绿色）模式：数据目录跟随程序目录，不写 %APPDATA%。
 *
 * - electron-builder 的 `portable` target 会注入 `PORTABLE_EXECUTABLE_DIR`
 * - 目录免安装（zip）包：在 exe 同目录放一个 `portable.txt` 即触发
 *
 * 必须在任何 `app.getPath('userData')` 之前执行；目录不可写（只读介质）时回退默认值。
 */
function applyPortableDataDir (): void {
  const exeDir = dirname(app.getPath('exe'))
  const portableDir =
    process.env.PORTABLE_EXECUTABLE_DIR || (existsSync(join(exeDir, 'portable.txt')) ? exeDir : '')
  if (!portableDir) return
  try {
    const target = join(portableDir, 'shipit-data')
    mkdirSync(target, { recursive: true })
    app.setPath('userData', target)
  } catch {
    // 只读介质：继续用默认 userData，不阻塞启动
  }
}
applyPortableDataDir()
// 同样必须在 app ready 之前：Chromium 已完成 GPU 初始化后再调无效
applyGpuSwitch()
import { createAdapter } from './adapter-factory'
import type { IpcAdapter } from './ipc-adapter'
import { createStatusMirror } from './status-mirror'
import type { ServerHost } from './server-host'
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
// 注：主进程不再持有 Git / 文件 / 上传执行体（全部在后端进程）。
// 之前这里 new 的三份实例既跑不了任务（单后端），又把 ssh2 / simple-git 静态加载进来（内存）。
/** IPC 适配器：embedded=进程内服务；process=独立后端管理端点 */
let ipcAdapter: IpcAdapter
let serverHost: ServerHost | null = null
let statusMirror: ReturnType<typeof createStatusMirror> | null = null
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
  // process 模式：队列真值在远端镜像里（本地 deployQueue 永远是空的）
  const remote = statusMirror?.snapshot()
  broadcast(IpcChannels.SERVER_STATUS_CHANGED, {
    listening: serverSnapshot.listening,
    port: serverSnapshot.port,
    bound: serverSnapshot.bound,
    error: serverSnapshot.error,
    enabled: config.enabled,
    bind: config.bind,
    // 单后端：队列真值只来自远端镜像（没有镜像时用空队列占位）
    queue: remote?.queue ?? EMPTY_QUEUE,
    revision: nextStatusRevision()
  })
  // 托盘状态文本也含队列/项目数：不刷新的话右键菜单永远停在“上次构建时”的值
  trayHandle?.refresh()
}

/** 队列快照的空值：单后端后主进程不再有队列，空闲时用它占位（队列真值来自 statusMirror） */
const EMPTY_QUEUE = { state: 'idle' as const, runningTaskId: null, pendingCount: 0, tasks: [] as never[] }
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

/**
 * 创建窗口。角色决定初始视图：主窗口 = 项目选择页；项目窗口直达该项目的工区。
 * 项目路径通过 `additionalArguments` 传给渲染进程（preload 读取，见 windowArguments）。
 */
/**
 * 输入法把 Ctrl+空格 当「切换输入法」的系统热键，按键在到达页面之前就被吞掉，
 * 渲染层的多选快捷键因此失效。
 *
 * 处理：**项目窗口获得焦点期间**用 globalShortcut 把该组合抢过来，转成一次
 * 「切换当前行选中」发给渲染进程；窗口失焦立即释放，系统和其它窗口的输入法切换不受影响。
 * 抢注失败（被已注册的程序占用）时静默跳过 —— 仍有 Ctrl+Enter 这条路。
 */
let imeToggleOwnerId: number | null = null

function releaseImeSafeToggle(): void {
  if (imeToggleOwnerId === null) return
  try {
    globalShortcut.unregister('Control+Space')
  } catch {
    /* 已释放/未注册，忽略 */
  }
  imeToggleOwnerId = null
}

function acquireImeSafeToggle(win: BrowserWindow): void {
  const id = win.webContents.id
  if (imeToggleOwnerId === id) return
  releaseImeSafeToggle()
  try {
    const ok = globalShortcut.register('Control+Space', () => {
      // 窗口/渲染进程可能已经销毁（崩溃或关窗竞态）：热键回调里抛异常会打断主进程
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      try {
        win.webContents.send(IpcChannels.EDITOR_TOGGLE_SELECTION)
      } catch {
        /* 窗口正在销毁，忽略 */
      }
    })
    if (ok) imeToggleOwnerId = id
  } catch {
    /* 注册失败：保持 Ctrl+Enter 作为替代 */
  }
}

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
      // 关闭拼写检查：Chromium 会为每个窗口加载系统词典（实测数 MB～十几 MB），
      // 而本应用的输入框全是路径 / 目标名 / 令牌，拼写检查没有价值。
      spellcheck: false,
      additionalArguments: [
        ...windowArguments(opts.role, projectPath),
        ...(opts.section ? [`${ARG_SECTION}${opts.section}`] : [])
      ]
    }
  })

  const id = win.webContents.id
  appWindows.set(id, { win, role: opts.role, projectPath, title: windowTitle(opts.role, projectPath) })
  // 窗口镜像：后端不知道窗口，必须由主进程推送（P1-8）
  if (opts.role === 'project' || projectPath) {
    statusMirror?.onWindowOpened({ id, projectPath, focused: win.isFocused() })
  }

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
    statusMirror?.onWindowOpened({
      id,
      projectPath: appWindows.get(id)?.projectPath ?? projectPath,
      focused: true
    })
    // 只有项目窗口里有可选行：设置窗口/主窗口不抢输入法的 Ctrl+空格。
    // 角色要**现取**：主窗口打开项目后会就地变成项目窗口（创建时的 role 还是 main）。
    const role = appWindows.get(id)?.role ?? opts.role
    if (role === 'project') acquireImeSafeToggle(win)
  })
  // 失焦/关窗即把 Ctrl+空格 还给系统（否则会挡住别处的输入法切换）
  win.on('blur', () => {
    if (imeToggleOwnerId === id) releaseImeSafeToggle()
  })
  win.on('closed', () => {
    if (imeToggleOwnerId === id) releaseImeSafeToggle()
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
    statusMirror?.onWindowClosed(id)
    if (opts.role === 'settings') settingsDirty = false
    // 项目窗口关闭 = 该项目不再使用：释放它的 git 缓存（否则长会话里只增不减）。
    // 以**注册表里的当前绑定**为准：窗口可能中途从主窗口认领了项目，
    // 用创建时的 opts.projectPath 会释放错项目（或该释放的没释放）。
    const current = appWindows.get(id)
    // Git 查询在后端进程，主进程不再持有 Git 缓存，无需 dispose
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
function showSettingsWindow(section: SettingsSection = 'targets', requesterId?: number): void {
  // 新窗口创建 + 首帧绘制要几秒：期间发起窗口只是“没反应”。
  // 开始时就通知它盖遮罩，窗口可见后再撤。
  const notify = (channel: string): void => {
    if (requesterId !== undefined) sendToWindow(requesterId, channel, {})
  }

  for (const entry of appWindows.values()) {
    if (entry.role !== 'settings' || entry.win.isDestroyed()) continue
    if (entry.win.isMinimized()) entry.win.restore()
    entry.win.show()
    entry.win.focus()
    entry.win.webContents.send(IpcChannels.SETTINGS_SECTION, section)
    notify(IpcChannels.SETTINGS_READY)
    return
  }

  notify(IpcChannels.SETTINGS_OPENING)
  // 初始标签页随启动参数传入（窗口首次加载即可用，不必等 did-finish-load）
  const win = createAppWindow({ role: 'settings', section })
  let settled = false
  const done = (): void => {
    if (settled) return
    settled = true
    notify(IpcChannels.SETTINGS_READY)
  }
  win.once('ready-to-show', done)
  // 兜底：事件丢失（窗口已就绪后才注册）时别让遮罩永远盖着
  setTimeout(done, 4000).unref?.()
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
  parts.push(queueTextOf(statusMirror?.snapshot()?.queue ?? EMPTY_QUEUE))
  return parts.join(' · ')
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
  // process 模式：配置写入必须走后端（跨进程写锁无效，P1-10）
  if (serverHost) {
    const cfg = (await ipcAdapter.configLoad()) as { recentProjects?: string[] }
    const recent = [projectPath, ...(cfg.recentProjects ?? []).filter((p) => p !== projectPath)].slice(0, 10)
    await ipcAdapter.configSave({ recentProjects: recent })
  } else {
    // 后端未就绪时不写盘：主进程不再是配置写者（否则会与后端跨进程并发覆盖）
    writeFatalLog('config', 'open-project 早于后端就绪，最近项目未记录')
  }
  openProjectWindow(projectPath, callerId)
}

function registerIpcHandlers() {
  // 渲染进程同步 UI 状态：仅需同步原生主题（菜单勾选态由自绘菜单栏本地管理）
  ipcMain.on(IpcChannels.MENU_SYNC_STATE, (_e, s: { theme?: string }) => {
    if (s?.theme) applyNativeTheme(s.theme)
  })

  // 应用版本（来自打包时的 package.json，UI 与安装包版本同源）
  ipcMain.handle(IpcChannels.APP_GET_VERSION, () => app.getVersion())
  // 打包时经 electron-builder 的 extraMetadata 写入产物 package.json；开发态没有该字段
  ipcMain.handle(IpcChannels.APP_GET_BUILD_NUMBER, () => {
    // 构建脚本写入 dist-electron/build-info.json（在 asar 内）；开发态没有该文件
    try {
      const info = JSON.parse(readFileSync(join(__dirname, 'build-info.json'), 'utf-8')) as { buildNumber?: unknown }
      if (typeof info.buildNumber === 'string') return info.buildNumber
    } catch {
      // 回退到 package.json（若将来改用 extraMetadata）
    }
    try {
      const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf-8')) as { buildNumber?: unknown }
      return typeof pkg.buildNumber === 'string' ? pkg.buildNumber : ''
    } catch {
      return ''
    }
  })

  /**
   * 用系统浏览器打开外部链接。
   *
   * 只接受 https + 白名单主机：这个通道供渲染层拼字符串用（关于页的发布地址），
   * 不校验就相当于把“可打开任意 URL”的能力交给页面（渲染层一旦被注入就是任意协议拉起）。
   */
  // 目前只有 GitHub releases 需要从应用内打开；不留 npm 主机（暂时用不上，少一个可被拉起的域名）
  const OPEN_EXTERNAL_HOSTS = new Set(['github.com'])
  ipcMain.handle(IpcChannels.APP_OPEN_EXTERNAL, async (_event, rawUrl: unknown) => {
    let parsed: URL
    try {
      parsed = new URL(String(rawUrl))
    } catch {
      throw new Error('无效的链接')
    }
    if (parsed.protocol !== 'https:' || !OPEN_EXTERNAL_HOSTS.has(parsed.hostname)) {
      throw new Error('该链接不允许从应用内打开：' + parsed.hostname)
    }
    await shell.openExternal(parsed.toString())
  })

  // 打开全局设置窗口（指定标签页）：项目/主窗口的「上传目标管理」「本地服务管理」都走这里
  ipcMain.handle(IpcChannels.SETTINGS_OPEN, async (_event, section: unknown) => {
    showSettingsWindow(section === 'server' ? 'server' : 'targets', _event.sender.id)
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
      // 配置只有一个写者：后端进程。主进程直接写盘会与后端并发（写锁是进程内的），
      // 且全量写会把后端刚保存的目标（含凭据）覆盖回旧快照。
      case 'clear-recent': {
        if (serverHost) await ipcAdapter.configSave({ recentProjects: [] })
        else writeFatalLog('config', 'clear-recent 早于后端就绪，已忽略')
        break
      }
      case 'remove-recent':
        // 单条移除：列表里的坏条目（误加的目录、已删除的项目）要能被清掉
        if (typeof payload === 'string' && payload) {
          if (serverHost) {
            const cfg = (await ipcAdapter.configLoad()) as { recentProjects?: string[] }
            await ipcAdapter.configSave({
              recentProjects: (cfg.recentProjects ?? []).filter((p) => p !== payload)
            })
          } else {
            writeFatalLog('config', 'remove-recent 早于后端就绪，已忽略')
          }
        }
        break
      case 'open-settings':
        // 所有窗口的配置入口都汇聚到这里 → 全局设置窗口（单实例）
        showSettingsWindow(payload === 'server' ? 'server' : 'targets', _e.sender.id)
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
    // 视图状态同样只由后端写；早于后端就绪时丢弃（下次切视图会再存）
    if (serverHost) await ipcAdapter.projectViewSave(projectPath, patch)
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
    return ipcAdapter.filesTree(rootPath)
  })

  ipcMain.handle(IpcChannels.FILE_EXPAND_DIR, async (_event, dirPath: string) => {
    return ipcAdapter.filesExpand(dirPath)
  })

  // 上传取文件：**必须**用 collectFilesForUpload。
  // 它只跳 `.git` / `node_modules`，保留 dist/build/target/vendor 等构建产物；
  // 曾误用浏览用的 collectAllFiles → 选目录发 dist 时一个文件都不会上传，且不报错。
  ipcMain.handle(IpcChannels.FILE_COLLECT_FILES, async (_event, dirPath: string) => {
    return ipcAdapter.filesCollect(dirPath)
  })

  // ========== Git 状态 ==========
  // 渲染层用它决定「Git 视图是否可用」：多根项目里项目根本身可以不是仓库，
  // 因此这里用比 isGitRepo 更宽的判定（内层仓库也算）。
  // CLI/MCP 的 NOT_A_REPO 判定走 isGitRepo，不受影响。
  ipcMain.handle(IpcChannels.GIT_CHECK_REPO, async (_event, dir: string) => {
    return ipcAdapter.gitCheckRepo(dir)
  })

  ipcMain.handle(IpcChannels.GIT_BRANCHES, async (_event, dir: string) => {
    return ipcAdapter.gitBranches(dir)
  })

  ipcMain.handle(IpcChannels.GIT_AUTHORS, async (_event, dir: string) => {
    return ipcAdapter.gitAuthors(dir)
  })

  ipcMain.handle(IpcChannels.GIT_STATUS, async (_event, dir: string) => {
    return ipcAdapter.gitStatus(dir)
  })

  ipcMain.handle(IpcChannels.GIT_LOG, async (_event, dir: string, options?: { branch?: string; author?: string; maxCount?: number }) => {
    return ipcAdapter.gitLog(dir, options)
  })

  ipcMain.handle(IpcChannels.GIT_DIFF, async (_event, dir: string, filePath: string) => {
    return ipcAdapter.gitDiff(dir, filePath)
  })

  ipcMain.handle(IpcChannels.GIT_COMMIT_FILES, async (_event, dir: string, hash: string) => {
    return ipcAdapter.gitCommitFiles(dir, hash)
  })

  ipcMain.handle(IpcChannels.DIALOG_OPEN_FILE, async (_event, options: any) => {
    const owner = BrowserWindow.fromWebContents(_event.sender) ?? focusedEntry()?.win ?? mainWindowEntry()?.win
    const result = await dialog.showOpenDialog(owner!, options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ========== 部署 ==========
  ipcMain.handle(IpcChannels.DEPLOY_TEST_CONN, async (_event, target: any) => {
    return ipcAdapter.testConnectionDraft(target)
  })

  // 预览：主进程计算实际要上传的任务列表 + 被跳过的条目（含真实原因），供弹窗展示，保证与实际一致
  ipcMain.handle(IpcChannels.DEPLOY_PREVIEW, async (_event, files: string[], projectRoot: string, target: any) => {
    return ipcAdapter.deployPreview(files, projectRoot, target)
  })

  // 执行：直接上传已确认的任务列表（与预览完全一致）
  ipcMain.handle(IpcChannels.DEPLOY_UPLOAD, async (_event, tasks: any[], target: any, projectRoot?: string) => {
    const startedAt = Date.now()
    let result: any
    try {
      result = (await ipcAdapter.deployDirect(
        { windowId: _event.sender.id, tasks, targetName: target?.name, projectRoot },
        (current: number, total: number, file: string, bytes?: { done: number; total: number }) => {
          // 逐文件进度只回发起窗口（进度条属于该窗口的会话）
          sendToWindow(_event.sender.id, IpcChannels.DEPLOY_PROGRESS, { current, total, file, bytes })
        },
        (ahead: number) => {
          // 排队提示：界面据此显示“排队中（第 N 位）”，不显示假进度
          sendToWindow(_event.sender.id, IpcChannels.DEPLOY_QUEUED, { ahead })
        }
      )) as any
    } catch (error) {
      // 请求本身失败（后端不可达、连接中断等）也必须留一条日志：
      // 否则用户点完上传只看到弹窗消失、日志面板空白，完全不知道发生了什么。
      const message = error instanceof Error ? error.message : String(error)
      const total = Array.isArray(tasks) ? tasks.length : 0
      broadcast(IpcChannels.DEPLOY_LOG_ENTRY, {
        taskId: `failed-${Date.now().toString(36)}`,
        targetName: target?.name ?? '-',
        timestamp: Date.now(),
        totalFiles: total,
        succeeded: 0,
        failed: total,
        skipped: 0,
        duration: 0,
        details: [{ relativePath: '(上传请求失败)', remotePath: '', status: 'failed', error: message }],
        origin: 'desktop',
        ...(projectRoot ? { projectRoot } : {})
      })
      throw error
    } finally {
      // 排障：一次上传超过 5s 就留痕（正常上传不会触发），
      // 用于区分“请求没返回”与“渲染层状态错了”。
      const elapsed = Date.now() - startedAt
      if (elapsed > 5000) {
        writeFatalLog('deploy', `DEPLOY_UPLOAD 耗时 ${elapsed}ms（windowId=${_event.sender.id}）`)
      }
    }
    // 桌面直连上传不进队列，其他窗口的日志面板默认看不到这次上传：
    // 结果统一广播（发起窗口按 taskId 去重），与 CLI/MCP 任务的可见性保持一致。
    // 取消也会走到这里（deploy 会返回 cancelled:true 的结果），所以取消同样有日志。
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
      ...(result.postUpload ? { postUpload: result.postUpload } : {}),
      origin: 'desktop',
      ...(projectRoot ? { projectRoot } : {})
    })
    return result
  })

  // 取消当前部署（只取消**本窗口**发起的桌面会话，不误伤 CLI/MCP 与其他窗口）
  ipcMain.handle(IpcChannels.DEPLOY_CANCEL, async (_event) => {
    await ipcAdapter.deployCancel(_event.sender.id)
  })

  // ========== 配置管理 ==========
  ipcMain.handle(IpcChannels.CONFIG_LOAD, async () => {
    return ipcAdapter.configLoad()
  })

  ipcMain.handle(IpcChannels.CONFIG_SAVE, async (_event, config: any) => {
    // 用 patchOwned 语义（adapter 内部实现）：单字段保存不会把 targets/最近项目写成空
    const saved = await ipcAdapter.configSave(config)
    broadcastConfigChanged()
    return saved
  })

  // ========== 目标管理 ==========
  ipcMain.handle(IpcChannels.TARGET_LIST, async () => {
    return ipcAdapter.targetList()
  })

  ipcMain.handle(IpcChannels.TARGET_ADD, async (_event, target: any) => {
    await ipcAdapter.targetSave({ op: 'add', target })
    broadcastConfigChanged()
  })

  ipcMain.handle(IpcChannels.TARGET_UPDATE, async (_event, id: string, updates: any) => {
    await ipcAdapter.targetSave({ op: 'update', id, updates })
    broadcastConfigChanged()
  })

  ipcMain.handle(IpcChannels.TARGET_REMOVE, async (_event, id: string) => {
    await ipcAdapter.targetRemove(id)
    broadcastConfigChanged()
  })

  ipcMain.handle(IpcChannels.TARGET_REORDER, async (_event, ids: string[]) => {
    await ipcAdapter.targetReorder(ids)
    broadcastConfigChanged()
  })

  // 目标写入（add/update/clone + secrets）：F1
  ipcMain.handle(IpcChannels.TARGET_SAVE, async (_event, payload: any) => {
    const saved = await ipcAdapter.targetSave(payload)
    broadcastConfigChanged()
    return saved
  })

  ipcMain.handle(IpcChannels.MAPPING_ADD, async (_event, targetId: string, mapping: any) => {
    await ipcAdapter.mappingAdd(targetId, mapping)
    broadcastConfigChanged()
  })

  ipcMain.handle(IpcChannels.MAPPING_UPDATE, async (_event, targetId: string, mappingId: string, updates: any) => {
    await ipcAdapter.mappingUpdate(targetId, mappingId, updates)
    broadcastConfigChanged()
  })

  ipcMain.handle(IpcChannels.MAPPING_REMOVE, async (_event, targetId: string, mappingId: string) => {
    await ipcAdapter.mappingRemove(targetId, mappingId)
    broadcastConfigChanged()
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
      // 主窗口「就地」打开项目时角色从 main 变成 project，不会再触发 focus：
      // 在这里补一次 Ctrl+空格 的抢注（退回主窗口时再还回去）
      if (!entry.win.isDestroyed()) {
        if (entry.role === 'project' && entry.win.isFocused()) acquireImeSafeToggle(entry.win)
        else if (entry.role !== 'project' && imeToggleOwnerId === entry.win.webContents.id) releaseImeSafeToggle()
      }
    }
    if (focusedWindowId === _event.sender.id) syncCurrentProject()
    trayHandle?.refresh()
    return entry?.projectPath ?? null
  })

  ipcMain.handle(IpcChannels.SERVER_GET_CONFIG, async () => {
    return ipcAdapter.serverConfig()
  })

  ipcMain.handle(IpcChannels.SERVER_SAVE_CONFIG, async (_event, patch: Partial<ServerConfig>) => {
    // 令牌门槛由配置模块把关（主进程是可信边界，渲染层校验只是提示）：
    // 不可用令牌（空串/过短）在这里被拒绝，不会落盘。
    const saved = (await ipcAdapter.serverConfigSave(patch ?? {})) as {
      ok: boolean
      reason?: string
      config: ServerConfig
    }
    if (!saved.ok) return { ok: false as const, reason: saved.reason }
    // 监听由后端重启（适配层内部已 syncPublicListener）
    broadcastConfigChanged()
    return { ok: true as const, config: saved.config, status: serverSnapshot }
  })

  ipcMain.handle(IpcChannels.SERVER_GET_STATUS, async () => {
    // 两种形态统一：状态与配置都由适配层取，返回结构保持旧口径
    const status = (await ipcAdapter.serverStatus()) as any
    const config = (await ipcAdapter.serverConfig()) as any
    return {
      listening: status?.listening ?? false,
      port: status?.port ?? null,
      bound: status?.bound ?? '',
      error: status?.error,
      enabled: config?.enabled ?? false,
      bind: config?.bind ?? 'local',
      protocolVersion: PROTOCOL_VERSION,
      fingerprint: status?.fingerprint ?? null,
      connectionFile: status?.connectionFile ?? null,
      queue: status?.queue,
      currentProject: status?.currentProject ?? null,
      // 必须用 main 的发号器（F1）：GET 与推送先到一处，renderer 才能按同一个时钟丢弃旧快照。
      // 后端实例内 revision 在后端重启后会归零，直接透传会被 renderer 当成旧状态丢掉。
      revision: nextStatusRevision()
    }
  })

  ipcMain.handle(IpcChannels.SERVER_EXPORT_CONNECTION, async () => {
    const exported = (await ipcAdapter.serverExport()) as any
    if (!exported?.port || !exported?.fingerprint) {
      return { ok: false as const, reason: '服务未运行，无法导出连接串' }
    }
    // 局域网绑定时给出本机可被对端访问的 IPv4，否则明确为回环地址
    let host = '127.0.0.1'
    if (exported.bind === 'lan') {
      const candidates = Object.values(networkInterfaces())
        .flat()
        .filter((info): info is NonNullable<typeof info> => !!info && info.family === 'IPv4' && !info.internal)
      host = candidates[0]?.address ?? '127.0.0.1'
    }
    const connection: ExportedConnection = {
      host,
      port: exported.port,
      token: exported.token,
      protocolVersion: exported.protocolVersion,
      fingerprint: exported.fingerprint
    }
    return { ok: true as const, connection, text: connectionString(connection) }
  })

  ipcMain.handle(IpcChannels.SERVER_REGENERATE_TOKEN, async () => {
    const config = await ipcAdapter.serverTokenRotate()
    // 公开端点由后端随令牌轮换重启（适配层内部完成）
    broadcastConfigChanged()
    return { config }
  })
}

app.whenReady().then(async () => {
  configStore = new ConfigStore()

  // 单后端：桌面只通过管理端点执行（不再有进程内模式）
  const buildAdapter = () =>
    createAdapter({
      host: {
        entry: app.isPackaged
          ? join(app.getAppPath(), 'dist-server/index.js')
          // 开发模式：__dirname 是 dist-electron/，项目根只需一级 ..
          : join(__dirname, '../dist-server/index.js'),
        configPath: configStore.path,
        appVersion: app.getVersion(),
        dataDir: dirname(configStore.path)
      }
    })

  let built: Awaited<ReturnType<typeof createAdapter>> | null = null
  let lastError = ''

  /** 尝试一次；失败写日志并返回 false（不弹窗、不退进程） */
  const tryStart = async (): Promise<boolean> => {
    try {
      built = await buildAdapter()
      return true
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      writeFatalLog('backend', `后端启动失败：${lastError}`)
      return false
    }
  }

  // 启动是唯一一次“没后端就真用不了”的路径，但失败往往是临时的
  // （首次冷启动、杀毒扫描 80MB asar、磁盘繁忙）。先自己重试一次再说。
  if (!(await tryStart())) {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await tryStart()
  }

  // 仍失败：用**人话**问用户接下来怎么办，而不是一句“等待 ready 超时”判死刑
  while (!built) {
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: 'ShipIt 无法启动',
      message: '后台服务未能启动',
      detail:
        '这通常是临时问题（首次启动较慢、杀毒软件正在扫描、磁盘繁忙），重试一般就能恢复。\n\n' +
        '如果反复出现，请点「打开日志目录」，把其中的 error.log 发给开发者。',
      buttons: ['重试', '打开日志目录', '退出'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })
    if (choice.response === 2) {
      app.exit(1)
      return
    }
    if (choice.response === 1) {
      void shell.openPath(dirname(configStore.path))
      continue
    }
    await tryStart()
  }
  // while 循环保证走到这里时 built 非空（TS 的控制流看不到闭包里的赋值）
  const started = built as Awaited<ReturnType<typeof createAdapter>>
  ipcAdapter = started.adapter
  serverHost = started.host
  let backendFatalNotified = false
  if (serverHost) {
    statusMirror = createStatusMirror({
      post: (path, body) => {
        void serverHost!.post(path, body)
      }
    })
    // 后端重启后 Runtime 的项目列表为空：重传一次已开窗口（R2）
    serverHost.on('restarted', () => statusMirror?.resync())
    serverHost.on('queue.snapshot', (data) => {
      statusMirror!.onSnapshot(data)
      broadcastServerStatus()
    })
    serverHost.on('server.state', (data: any) => {
      // 远端状态同步到本地快照（否则状态栏/托盘一直停留在“未监听”）
      const publicState = data?.public ?? {}
      serverSnapshot = {
        listening: !!publicState.listening,
        port: publicState.port ?? null,
        bound: publicState.bound ?? '',
        error: publicState.error
      }
      serverConfigCache = { ...serverConfigCache, enabled: !!data?.published }
      broadcastServerStatus()
    })
    // 队列任务结算：CLI / MCP 提交的上传结果要进桌面日志面板（此前只推给本地队列，
    // 而本地队列永远不会再跑任务 → 这类日志曾整体丢失）。桌面直连上传不走队列，
    // 其结果由 DEPLOY_UPLOAD 的响应单独广播，两边不会重复。
    serverHost.on('task.settled', (payload: unknown) => {
      const record = payload as {
        taskId: string
        target: string
        finishedAt?: number
        totalFiles?: number
        origin?: string
        projectRoot?: string
        remoteAddress?: string
        cancelled?: boolean
        result?: {
          totalFiles?: number
          succeeded?: number
          failed?: number
          skipped?: number
          duration?: number
          details?: unknown[]
          postUpload?: unknown
        }
      }
      if (!record?.taskId) return
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
        ...(record.result?.postUpload ? { postUpload: record.result.postUpload } : {}),
        origin: record.origin ?? 'cli',
        projectRoot: record.projectRoot,
        ...(record.remoteAddress ? { remoteAddress: record.remoteAddress } : {})
      })
    })
    // 后端放弃自动重启时必须让用户知道（评审 B-2）：否则所有操作只会返回
    // BACKEND_UNAVAILABLE，真正原因只躺在 error.log 里没人看。只弹一次，避免重启循环时刷屏。
    serverHost.on('fatal', (payload: unknown) => {
      const detail =
        payload && typeof payload === 'object' && 'message' in payload
          ? String((payload as { message?: unknown }).message)
          : String(payload)
      writeFatalLog('backend', detail)
      if (backendFatalNotified) return
      backendFatalNotified = true
      void dialog.showMessageBox({
        type: 'error',
        title: 'ShipIt 后端已停止',
        message: '后端进程已停止，且不再自动重启',
        detail: `${detail}\n\n上传、配置与 Git 查询都不可用。请重启应用；完整日志见 error.log。`,
        buttons: ['知道了']
      })
    })
  }

  // 启动即应用持久化主题（原生滚动条/系统对话框跟随）
  const savedTheme = (await configStore.load()).theme || 'auto'
  applyNativeTheme(savedTheme)


  disableNativeMenu()
  registerIpcHandlers()
  // 先起主窗口（项目选择页），再按启动参数打开项目窗口（双击/命令行带路径时）
  showMainWindow()
  createTrayIfPossible()
  openStartupProjectIfAny()
  // 监听完全由后端管理（主进程不再建/拆 listener）

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
app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* 忽略 */
  }
})

app.on('before-quit', (event) => {
  isQuitting = true
  if (shutdownInProgress) return // 收尾完成后由我们自己触发的再次 quit：放行
  // 后端是唯一执行体：无论空闲与否都要走两阶段退出（否则只能靠父进程探测）
  if (!serverHost) {
    app.quit()
    return
  }
  event.preventDefault()
  shutdownInProgress = true
  void (async () => {
    // 由后端执行 drain，保留现有“继续等待 / 立即退出”交互（F4）
    {
      const prepare = await serverHost.prepareStop(SHUTDOWN_GRACE_MS)
      const drained =
        prepare.ok &&
        prepare.envelope.ok &&
        (prepare.envelope.data as { drained?: boolean } | null)?.drained === true

      if (!drained) {
        const owner = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null
        let keepWaiting = false
        if (owner) {
          const choice = await dialog.showMessageBox(owner, {
            type: 'warning',
            message: '仍有上传未完成',
            detail: '立即退出会中断上传，已传输的文件不会回滚。',
            buttons: ['继续等待 30 秒', '立即退出'],
            defaultId: 0,
            cancelId: 0
          })
          keepWaiting = choice.response === 0
        }
        if (keepWaiting) {
          // 再等一轮仍拿不到 drained 就必须强制（R4）：否则后端不退出，main 只能盲等 32s
          const fin = await serverHost.finalizeStop(SHUTDOWN_EXTRA_WAIT_MS)
          const finDrained =
            fin.ok &&
            fin.envelope.ok &&
            (fin.envelope.data as { drained?: boolean } | null)?.drained === true
          if (!finDrained) await serverHost.forceStop()
        } else {
          await serverHost.forceStop()
        }
      }

      // 等后端退出（最多 deadline + 2s），避免主进程先走把子进程硬切掉
      await Promise.race([
        new Promise<void>((resolve) => serverHost!.child?.on('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_EXTRA_WAIT_MS + 2000))
      ])
      app.quit()
      return
    }
    // 后端已在两阶段退出中停掉 listener（含删 server.json）
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
