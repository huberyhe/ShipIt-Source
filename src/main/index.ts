import { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } from 'electron'
import { join } from 'path'
import { promises as fsPromises } from 'fs'
import { GitService } from './services/git-service'
import { DeployService } from './services/deploy-service'
import { ConfigStore } from './services/config-store'
import { FileService } from './services/file-service'
import { IpcChannels } from '../shared/ipc-channels'

let mainWindow: BrowserWindow | null = null
let configStore: ConfigStore
let fileService: FileService
let gitService: GitService
let deployService: DeployService

function createWindow() {
  // 窗口图标：打包后从 resources 读取，开发时用 build 目录
  const windowIcon = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../build/icon.png')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ShipIt',
    icon: windowIcon,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }
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

async function openProjectDialog() {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: '选择项目目录'
  })
  if (result.canceled || result.filePaths.length === 0) return

  const projectPath = result.filePaths[0]
  await openProjectPath(projectPath)
}

async function openProjectPath(projectPath: string) {
  await configStore.addRecentProject(projectPath)
  mainWindow?.webContents.send('menu:open-project', projectPath)
}

function registerIpcHandlers() {
  // 渲染进程同步 UI 状态：仅需同步原生主题（菜单勾选态由自绘菜单栏本地管理）
  ipcMain.on(IpcChannels.MENU_SYNC_STATE, (_e, s: { theme?: string }) => {
    if (s?.theme) applyNativeTheme(s.theme)
  })

  // 应用版本（来自打包时的 package.json，UI 与安装包版本同源）
  ipcMain.handle(IpcChannels.APP_GET_VERSION, () => app.getVersion())

  // ========== 自绘菜单栏动作分发 ==========
  ipcMain.handle(IpcChannels.APP_ACTION, async (_e, action: string, payload?: any) => {
    switch (action) {
      case 'open-project':
        await openProjectDialog()
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
      case 'quit':
        app.quit()
        break
      case 'reload':
        mainWindow?.webContents.reload()
        break
      default:
        break
    }
    return null
  })

  // ========== 项目操作 ==========
  ipcMain.handle(IpcChannels.PROJECT_OPEN, async () => {
    await openProjectDialog()
    return null // 通过 menu:open-project 事件返回
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
    const result = await dialog.showOpenDialog(mainWindow!, options)
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
  ipcMain.handle(IpcChannels.DEPLOY_UPLOAD, async (_event, tasks: any[], target: any) => {
    return deployService.deploy(
      tasks,
      target,
      (_current: number, _total: number, _file: string) => {
        if (mainWindow) {
          mainWindow.webContents.send(IpcChannels.DEPLOY_PROGRESS, { current: _current, total: _total, file: _file })
        }
      }
    )
  })

  // 取消当前部署
  ipcMain.handle(IpcChannels.DEPLOY_CANCEL, async () => {
    deployService.abort()
  })

  // ========== 配置管理 ==========
  ipcMain.handle(IpcChannels.CONFIG_LOAD, async () => {
    return configStore.load()
  })

  ipcMain.handle(IpcChannels.CONFIG_SAVE, async (_event, config: any) => {
    if (config && typeof config === 'object') {
      configStore.replace(config)
    }
    return configStore.save()
  })

  // ========== 目标管理 ==========
  ipcMain.handle(IpcChannels.TARGET_LIST, async () => {
    const config = await configStore.load()
    return config.deploymentTargets
  })

  ipcMain.handle(IpcChannels.TARGET_ADD, async (_event, target: any) => {
    return configStore.addTarget(target)
  })

  ipcMain.handle(IpcChannels.TARGET_UPDATE, async (_event, id: string, updates: any) => {
    return configStore.updateTarget(id, updates)
  })

  ipcMain.handle(IpcChannels.TARGET_REMOVE, async (_event, id: string) => {
    return configStore.removeTarget(id)
  })

  ipcMain.handle(IpcChannels.MAPPING_ADD, async (_event, targetId: string, mapping: any) => {
    return configStore.addMapping(targetId, mapping)
  })

  ipcMain.handle(IpcChannels.MAPPING_UPDATE, async (_event, targetId: string, mappingId: string, updates: any) => {
    return configStore.updateMapping(targetId, mappingId, updates)
  })

  ipcMain.handle(IpcChannels.MAPPING_REMOVE, async (_event, targetId: string, mappingId: string) => {
    return configStore.removeMapping(targetId, mappingId)
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

  disableNativeMenu()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
