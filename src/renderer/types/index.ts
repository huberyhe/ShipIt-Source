import type { DeployLogEntry, GitBranchInfo, GitCommitFile, QueueSnapshot, ServerBind, ServerConfig } from '../../shared/types'

// 领域类型统一定义在 shared/types.ts（铁律 1）；这里转出便于渲染层按原路径引用
export type { DeployLogEntry, GitCommitFile }

export type ActiveView = 'filetree' | 'gitchanges' | 'gitlog'

export interface DeployApi {
  /** 窗口角色与初始项目（由主进程通过 additionalArguments 注入，见 window-manager） */
  getWindowInit: () => { role: 'main' | 'project' | 'settings'; projectPath: string | null; section: 'targets' | 'server' }
  /** 打开全局设置窗口（单实例） */
  openSettings: (section?: 'targets' | 'server') => Promise<null>
  /** 设置窗口上报未保存状态（关窗守门用） */
  reportSettingsDirty: (dirty: boolean) => void
  /** 设置窗口：关闭被拦下（有未保存改动） */
  onSettingsConfirmClose: (callback: () => void) => void

  /** 设置窗口：主进程要求切换标签页 */
  onSettingsSection: (callback: (section: 'targets' | 'server') => void) => void
  /** 本窗口权威状态（角色随绑定/解绑项目变化） */
  getWindowState: () => Promise<{ role: 'main' | 'project' | 'settings'; projectPath: string | null }>
  /** 本窗口自我关闭（项目窗口：关闭该项目；主窗口：隐藏） */
  closeSelf: () => Promise<null>
  /** 打开项目文件夹（拖拽 / 外部入口） */
  openProjectFolder: (folderPath: string) => Promise<{ ok: boolean; reason?: string }>

  /** 按项目记忆的界面状态（视图 / 日志面板 / Git 筛选） */
  getProjectViewState: (projectPath: string) => Promise<{
    activeView?: 'filetree' | 'gitchanges' | 'gitlog'
    logPanelExpanded?: boolean
    gitLogBranch?: string
    gitLogAuthor?: string
  } | null>
  saveProjectViewState: (
    projectPath: string,
    patch: {
      activeView?: 'filetree' | 'gitchanges' | 'gitlog'
      logPanelExpanded?: boolean
      gitLogBranch?: string
      gitLogAuthor?: string
    }
  ) => Promise<null>

  /** 配置被其他窗口修改（多窗口一致性） */
  onConfigChanged: (callback: () => void) => void
  /** 取走待处理的窗口数量提示（拉取式兜底） */
  takeWindowLimitHint: () => Promise<{ count: number; limit: number } | null>
  /** 项目窗口数量达阈值的提示（订阅返回取消函数） */
  onWindowLimitHint: (callback: (payload: { count: number; limit: number }) => void) => () => void
  /** 托盘菜单标签自检（诊断用） */
  getTrayMenuLabels: () => Promise<string[]>

  /** 当前窗口列表与最近聚焦窗口（多窗口可观测性） */
  listWindows: () => Promise<{
    focusedWindowId: number | null
    trayAvailable: boolean
    windows: { id: number; role: 'main' | 'project'; projectPath: string | null; title: string }[]
  }>

  openProject: () => Promise<{ path: string } | null>
  getRecentProjects: () => Promise<string[]>
  setCurrentProject: (projectPath: string | null) => Promise<string | null>
  getFileTree: (rootPath: string) => Promise<any>
  expandDirectory: (dirPath: string) => Promise<any[]>
  collectFiles: (dirPath: string) => Promise<string[]>
  checkGitRepo: (dir: string) => Promise<boolean>
  getGitBranches: (dir: string) => Promise<GitBranchInfo[]>
  getGitAuthors: (dir: string) => Promise<string[]>
  getGitStatus: (dir: string) => Promise<any>
  getGitLog: (dir: string, options?: { branch?: string; author?: string; maxCount?: number }) => Promise<any[]>
  getGitDiff: (dir: string, filePath: string) => Promise<string>
  getCommitFiles: (dir: string, hash: string) => Promise<GitCommitFile[]>
  testConnection: (target: any) => Promise<{ success: boolean; error?: string }>
  previewDeployFiles: (files: string[], projectRoot: string, target: any) => Promise<any[]>
  deployFiles: (tasks: any[], target: any, projectRoot?: string) => Promise<any>
  cancelDeploy: () => Promise<void>
  /** 仅桌面窗口自己的上传会话（队列任务不推逐文件进度） */
  onDeployProgress: (callback: (data: { current: number; total: number; file: string }) => void) => void
  onDeployLogEntry: (callback: (entry: DeployLogEntry) => void) => void
  onServerStatusChanged: (callback: (payload: ServerStatusPayload) => void) => void
  openFileDialog: (options?: any) => Promise<string | null>
  onMenuEvent: (channel: string, callback: (...args: any[]) => void) => void
  syncMenuState: (state: { view?: string; theme?: string; hasProject?: boolean }) => void
  appAction: (action: string, payload?: any) => Promise<any>
  getAppVersion: () => Promise<string>
  loadConfig: () => Promise<any>
  saveConfig: (config: any) => Promise<void>
  getTargetList: () => Promise<any[]>
  addTarget: (target: any) => Promise<void>
  updateTarget: (id: string, updates: any) => Promise<void>
  removeTarget: (id: string) => Promise<void>
  addMapping: (targetId: string, mapping: any) => Promise<void>
  updateMapping: (targetId: string, mappingId: string, updates: any) => Promise<void>
  removeMapping: (targetId: string, mappingId: string) => Promise<void>

  // 本地服务端
  getServerConfig: () => Promise<ServerConfig>
  saveServerConfig: (
    patch: Partial<ServerConfig>
  ) => Promise<{ ok: boolean; reason?: string; config?: ServerConfig; status?: ServerRuntimeStatus }>
  getServerStatus: () => Promise<ServerRuntimeStatus & { enabled: boolean; bind: ServerBind; revision: number }>
  regenerateServerToken: () => Promise<{ config: ServerConfig }>
  exportServerConnection: () => Promise<
    | { ok: false; reason: string }
    | { ok: true; connection: Record<string, unknown>; text: string }
  >
}

/** 状态栏用的服务端状态与队列快照（主进程推送） */
export interface ServerStatusPayload {
  listening: boolean
  port: number | null
  bound: string
  error?: string
  enabled: boolean
  bind: ServerBind
  queue: QueueSnapshot
  /** 单调递增的状态版本号（推送与主动读取共用同一个计数器，用于丢弃迟到的旧快照） */
  revision: number
}

/** 本地服务端运行时状态（界面展示用） */
export interface ServerRuntimeStatus {
  listening: boolean
  port: number | null
  bound: string
  error?: string
  protocolVersion: number
  fingerprint: string | null
  connectionFile: string | null
  /** 队列快照（idle / running / waiting 与任务列表） */
  queue?: QueueSnapshot
  /** 桌面当前项目（CLI / MCP 缺省项目） */
  currentProject?: string | null
  /** 状态版本号（与推送同一个计数器；缺失时渲染层不过滤） */
  revision?: number
}

declare global {
  interface Window {
    deployApi: DeployApi
  }
}
