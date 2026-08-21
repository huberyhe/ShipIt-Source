import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'

contextBridge.exposeInMainWorld('deployApi', {
  // --- 项目 ---
  openProject: () => ipcRenderer.invoke(IpcChannels.PROJECT_OPEN),
  getRecentProjects: () => ipcRenderer.invoke(IpcChannels.PROJECT_GET_RECENT),

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
  deployFiles: (tasks: any[], target: any) =>
    ipcRenderer.invoke(IpcChannels.DEPLOY_UPLOAD, tasks, target),
  cancelDeploy: () => ipcRenderer.invoke(IpcChannels.DEPLOY_CANCEL),
  onDeployProgress: (callback: (data: { current: number; total: number; file: string }) => void) => {
    ipcRenderer.on(IpcChannels.DEPLOY_PROGRESS, (_event, data) => callback(data))
  },

  // --- 菜单事件 ---
  onMenuEvent: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args))
  },
  syncMenuState: (state: { view?: string; theme?: string }) => {
    ipcRenderer.send(IpcChannels.MENU_SYNC_STATE, state)
  },

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
