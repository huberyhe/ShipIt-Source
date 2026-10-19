import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import { parseWindowArgs } from './window-manager'

contextBridge.exposeInMainWorld('deployApi', {
  // --- 项目 ---
  openProject: () => ipcRenderer.invoke(IpcChannels.PROJECT_OPEN),
  getRecentProjects: () => ipcRenderer.invoke(IpcChannels.PROJECT_GET_RECENT),
  setCurrentProject: (projectPath: string | null) => ipcRenderer.invoke(IpcChannels.PROJECT_SET_CURRENT, projectPath),

  // --- 文件树 ---
  getFileTree: (rootPath: string) => ipcRenderer.invoke(IpcChannels.FILE_TREE_GET, rootPath),
  expandDirectory: (dirPath: string) => ipcRenderer.invoke(IpcChannels.FILE_EXPAND_DIR, dirPath),
  collectFiles: (dirPath: string) => ipcRenderer.invoke(IpcChannels.FILE_COLLECT_FILES, dirPath),

  // --- Git 状态 ---
  checkGitRepo: (dir: string) => ipcRenderer.invoke(IpcChannels.GIT_CHECK_REPO, dir),
  getGitBranches: (dir: string) => ipcRenderer.invoke(IpcChannels.GIT_BRANCHES, dir),
  getGitAuthors: (dir: string) => ipcRenderer.invoke(IpcChannels.GIT_AUTHORS, dir),
  getGitStatus: (dir: string) => ipcRenderer.invoke(IpcChannels.GIT_STATUS, dir),
  getGitLog: (dir: string, options?: { branch?: string; author?: string; maxCount?: number }) =>
    ipcRenderer.invoke(IpcChannels.GIT_LOG, dir, options),
  getGitDiff: (dir: string, filePath: string) => ipcRenderer.invoke(IpcChannels.GIT_DIFF, dir, filePath),
  getCommitFiles: (dir: string, hash: string) => ipcRenderer.invoke(IpcChannels.GIT_COMMIT_FILES, dir, hash),
  openFileDialog: (options?: any) => ipcRenderer.invoke(IpcChannels.DIALOG_OPEN_FILE, options || {}),

  // --- 部署 ---
  testConnection: (target: any) => ipcRenderer.invoke(IpcChannels.DEPLOY_TEST_CONN, target),
  previewDeployFiles: (files: string[], projectRoot: string, target: any) =>
    ipcRenderer.invoke(IpcChannels.DEPLOY_PREVIEW, files, projectRoot, target),
  deployFiles: (tasks: any[], target: any, projectRoot?: string) =>
    ipcRenderer.invoke(IpcChannels.DEPLOY_UPLOAD, tasks, target, projectRoot),
  cancelDeploy: () => ipcRenderer.invoke(IpcChannels.DEPLOY_CANCEL),
  // 仅桌面窗口自己的上传会话（队列任务不推逐文件进度）
  onDeployProgress: (callback: (data: { current: number; total: number; file: string }) => void) => {
    ipcRenderer.on(IpcChannels.DEPLOY_PROGRESS, (_event, data) => callback(data))
  },
  onDeployLogEntry: (callback: (entry: any) => void) => {
    ipcRenderer.on(IpcChannels.DEPLOY_LOG_ENTRY, (_event, entry) => callback(entry))
  },
  onServerStatusChanged: (callback: (payload: any) => void) => {
    ipcRenderer.on(IpcChannels.SERVER_STATUS_CHANGED, (_event, payload) => callback(payload))
  },

  // --- 菜单事件 ---
  onMenuEvent: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args))
  },
  syncMenuState: (state: { view?: string; theme?: string }) => {
    ipcRenderer.send(IpcChannels.MENU_SYNC_STATE, state)
  },

  // --- 自绘菜单栏动作 ---
  appAction: (action: string, payload?: any) => ipcRenderer.invoke(IpcChannels.APP_ACTION, action, payload),

  // --- 应用信息 ---
  getAppVersion: () => ipcRenderer.invoke(IpcChannels.APP_GET_VERSION),

  /** 打开全局设置窗口（单实例；section: 'targets' | 'server'） */
  openSettings: (section?: 'targets' | 'server') => ipcRenderer.invoke(IpcChannels.SETTINGS_OPEN, section ?? 'targets'),
  /** 设置窗口上报未保存状态（关窗守门用） */
  reportSettingsDirty: (dirty: boolean) => ipcRenderer.send(IpcChannels.SETTINGS_DIRTY, dirty),
  /** 设置窗口：关闭被拦下（有未保存改动） */
  onSettingsConfirmClose: (callback: () => void) => {
    ipcRenderer.on(IpcChannels.SETTINGS_CONFIRM_CLOSE, () => callback())
  },

  /** 设置窗口：主进程要求切换标签页 */
  onSettingsSection: (callback: (section: 'targets' | 'server') => void) => {
    ipcRenderer.on(IpcChannels.SETTINGS_SECTION, (_e, section: 'targets' | 'server') => callback(section))
  },

  /** 本窗口权威状态（角色随绑定/解绑项目变化，勿用启动参数判断） */
  getWindowState: () => ipcRenderer.invoke(IpcChannels.WINDOW_GET_STATE),

  /** 本窗口自我关闭（项目窗口：关闭该项目；主窗口：隐藏） */
  closeSelf: () => ipcRenderer.invoke(IpcChannels.WINDOW_CLOSE_SELF),

  /** 打开项目文件夹（拖拽等外部入口） */
  openProjectFolder: (folderPath: string) => ipcRenderer.invoke(IpcChannels.PROJECT_OPEN_FOLDER, folderPath),

  /** 按项目记忆的界面状态（视图 / 日志面板 / Git 筛选） */
  getProjectViewState: (projectPath: string) => ipcRenderer.invoke(IpcChannels.PROJECT_VIEW_GET, projectPath),
  saveProjectViewState: (projectPath: string, patch: unknown) =>
    ipcRenderer.invoke(IpcChannels.PROJECT_VIEW_SAVE, projectPath, patch),

  /** 配置被其他窗口修改（多窗口一致性）：订阅后重新拉取目标/服务设置 */
  takeWindowLimitHint: () => ipcRenderer.invoke(IpcChannels.WINDOW_LIMIT_HINT_TAKE) as Promise<{ count: number; limit: number } | null>,
  onWindowLimitHint: (callback: (payload: { count: number; limit: number }) => void) => {
    const listener = (_e: unknown, payload: { count: number; limit: number }): void => callback(payload)
    ipcRenderer.on(IpcChannels.WINDOW_LIMIT_HINT, listener)
    return () => ipcRenderer.removeListener(IpcChannels.WINDOW_LIMIT_HINT, listener)
  },
  onConfigChanged: (callback: () => void) => {
    ipcRenderer.on(IpcChannels.CONFIG_CHANGED, () => callback())
  },

  /** 托盘菜单标签自检（诊断"菜单里少了哪项"） */
  getTrayMenuLabels: () => ipcRenderer.invoke('window:menu-labels'),

  /** 当前窗口列表与最近聚焦窗口（多窗口可观测性） */
  listWindows: () => ipcRenderer.invoke(IpcChannels.WINDOW_LIST),

  // --- 窗口初始化（多项目多窗口：主窗口 = 项目选择页；项目窗口直达该项目）---
  getWindowInit: () => {
    const { role, projectPath, section } = parseWindowArgs(process.argv)
    return { role, projectPath, section }
  },

  // --- 本地服务端 ---
  getServerConfig: () => ipcRenderer.invoke(IpcChannels.SERVER_GET_CONFIG),
  saveServerConfig: (patch: any) => ipcRenderer.invoke(IpcChannels.SERVER_SAVE_CONFIG, patch),
  getServerStatus: () => ipcRenderer.invoke(IpcChannels.SERVER_GET_STATUS),
  regenerateServerToken: () => ipcRenderer.invoke(IpcChannels.SERVER_REGENERATE_TOKEN),
  exportServerConnection: () => ipcRenderer.invoke(IpcChannels.SERVER_EXPORT_CONNECTION),

  // --- 配置 & 目标 ---
  loadConfig: () => ipcRenderer.invoke(IpcChannels.CONFIG_LOAD),
  saveConfig: (config: any) => ipcRenderer.invoke(IpcChannels.CONFIG_SAVE, config),
  getTargetList: () => ipcRenderer.invoke(IpcChannels.TARGET_LIST),
  addTarget: (target: any) => ipcRenderer.invoke(IpcChannels.TARGET_ADD, target),
  updateTarget: (id: string, updates: any) => ipcRenderer.invoke(IpcChannels.TARGET_UPDATE, id, updates),
  removeTarget: (id: string) => ipcRenderer.invoke(IpcChannels.TARGET_REMOVE, id),
  addMapping: (targetId: string, mapping: any) => ipcRenderer.invoke(IpcChannels.MAPPING_ADD, targetId, mapping),
  updateMapping: (targetId: string, mappingId: string, updates: any) =>
    ipcRenderer.invoke(IpcChannels.MAPPING_UPDATE, targetId, mappingId, updates),
  removeMapping: (targetId: string, mappingId: string) =>
    ipcRenderer.invoke(IpcChannels.MAPPING_REMOVE, targetId, mappingId),
})

/**
 * 拖拽处理：把文件夹拖到窗口 = 在新窗口打开该项目。
 *
 * 放在 preload 是因为这里能同时拿到 DOM 事件与 Electron 的 File 路径（Electron 28 的 `File.path`；
 * 30+ 应改用 `webUtils.getPathForFile`）。同时必须 preventDefault，否则 Chromium 默认会"用窗口打开该文件"，
 * 把应用页面整个替换掉。
 */
function setupDragAndDrop(): void {
  window.addEventListener('dragover', (event) => {
    // 只接管文件拖拽，不影响页面内的其它拖拽（如未来可能的排序）
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
  })
  window.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files
    if (!files || files.length === 0) return
    event.preventDefault()
    const first = files[0] as File & { path?: string }
    const folderPath = typeof first.path === 'string' ? first.path : ''
    if (!folderPath) return
    void ipcRenderer.invoke(IpcChannels.PROJECT_OPEN_FOLDER, folderPath)
  })
}

try {
  setupDragAndDrop()
} catch {
  // 拖拽不可用（极端环境）不应影响应用启动
}
