import { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
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

// 当前 UI 状态，用于菜单选中态同步
let menuState = { view: 'filetree' as string, theme: 'auto' as string, hasProject: false }

function switchView(view: string) {
  menuState.view = view
  mainWindow?.webContents.send('menu:switch-view', view)
  buildMenu()
}

/** 让 Electron 原生 UI（菜单栏/滚动条/系统对话框）跟随应用主题 */
function applyNativeTheme(theme: string) {
  try {
    if (theme === 'dark') nativeTheme.themeSource = 'dark'
    else if (theme === 'light') nativeTheme.themeSource = 'light'
    else nativeTheme.themeSource = 'system'
  } catch { /* ignore */ }
}

function setTheme(theme: string) {
  menuState.theme = theme
  applyNativeTheme(theme)
  mainWindow?.webContents.send('menu:set-theme', theme)
  buildMenu()
}

async function buildMenu() {
  const config = await configStore.load()
  const recentProjects = config.recentProjects

  // 构建最近项目子菜单
  const recentMenuItems: MenuItemConstructorOptions[] = []
  if (recentProjects.length > 0) {
    for (const projPath of recentProjects) {
      recentMenuItems.push({
        label: projPath.length > 50 ? '...' + projPath.slice(-46) : projPath,
        click: () => openProjectPath(projPath)
      })
    }
    recentMenuItems.push({ type: 'separator' })
    recentMenuItems.push({
      label: '清除最近项目',
      click: async () => {
        config.recentProjects = []
        await configStore.save()
        buildMenu()
      }
    })
  } else {
    recentMenuItems.push({ label: '(无最近项目)', enabled: false })
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '打开目录...', accelerator: 'CmdOrCtrl+O', click: () => openProjectDialog() },
        { label: '打开工作目录', accelerator: 'CmdOrCtrl+Shift+O', click: () => openProjectPath(process.cwd()) },
        { type: 'separator' },
        { label: '最近打开的项目', submenu: recentMenuItems.length > 1 ? recentMenuItems : [{ label: '(无)', enabled: false }] },
        { type: 'separator' },
        { label: '关闭项目', accelerator: 'CmdOrCtrl+W', click: () => { mainWindow?.webContents.send('menu:close-project') } },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        // 仅在打开项目后显示视图切换（未打开项目时无意义）
        ...(menuState.hasProject ? [
          { label: '界面', enabled: false },
          { label: '文件树', type: 'radio', checked: menuState.view === 'filetree', accelerator: 'CmdOrCtrl+1', click: () => switchView('filetree') },
          { label: 'Git 变更', type: 'radio', checked: menuState.view === 'gitchanges', accelerator: 'CmdOrCtrl+2', click: () => switchView('gitchanges') },
          { label: 'Git 日志', type: 'radio', checked: menuState.view === 'gitlog', accelerator: 'CmdOrCtrl+3', click: () => switchView('gitlog') },
          { type: 'separator' }
        ] : []),
        { label: '外观', enabled: false },
        { label: '主题', submenu: [
          { label: '自动', type: 'radio', checked: menuState.theme === 'auto', click: () => setTheme('auto') },
          { label: '深色', type: 'radio', checked: menuState.theme === 'dark', click: () => setTheme('dark') },
          { label: '亮色', type: 'radio', checked: menuState.theme === 'light', click: () => setTheme('light') }
        ]},
        { type: 'separator' },
        { label: '显示/折叠上传日志', click: () => mainWindow?.webContents.send('menu:toggle-log') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'reload', label: '重新加载' }
      ]
    },
    {
      label: '设置',
      submenu: [
        { label: '上传目标管理...', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('menu:open-settings') }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '快捷键', click: () => mainWindow?.webContents.send('menu:show-shortcuts') },
        { type: 'separator' },
        { label: '关于 ShipIt', click: () => mainWindow?.webContents.send('menu:show-about') }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
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
  buildMenu()
}

function registerIpcHandlers() {
  // 渲染进程同步 UI 状态（用于菜单 radio 选中态）
  ipcMain.on(IpcChannels.MENU_SYNC_STATE, (_e, s: { view?: string; theme?: string; hasProject?: boolean }) => {
    if (s?.view) menuState.view = s.view
    if (s?.theme) {
      menuState.theme = s.theme
      applyNativeTheme(s.theme)
    }
    if (typeof s?.hasProject === 'boolean') menuState.hasProject = s.hasProject
    buildMenu()
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

  // 启动即应用持久化主题（原生菜单/滚动条跟随）
  const savedTheme = (await configStore.load()).theme || 'auto'
  menuState.theme = savedTheme
  applyNativeTheme(savedTheme)

  await buildMenu()
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
