/**
 * IPC 通道常量（主进程注册 handler / preload 暴露的 key 都引用这里）
 * 命名规则: 域_动作，如 PROJECT_OPEN / DEPLOY_UPLOAD
 */
export const IpcChannels = {
  // 项目
  PROJECT_OPEN: 'project:open',
  PROJECT_GET_RECENT: 'project:get-recent',
  PROJECT_SET_CURRENT: 'project:set-current',

  // 文件树
  FILE_TREE_GET: 'file:tree-get',
  FILE_EXPAND_DIR: 'file:expand-dir',
  FILE_COLLECT_FILES: 'file:collect-files',

  // Git 状态（只读）
  GIT_CHECK_REPO: 'git:check-repo',
  GIT_BRANCHES: 'git:branches',
  GIT_AUTHORS: 'git:authors',
  GIT_STATUS: 'git:status',
  GIT_LOG: 'git:log',
  GIT_DIFF: 'git:diff',
  GIT_COMMIT_FILES: 'git:commit-files',

  // 部署
  DEPLOY_PREVIEW: 'deploy:preview',
  DEPLOY_TEST_CONN: 'deploy:test-conn',
  DEPLOY_UPLOAD: 'deploy:upload',
  DEPLOY_CANCEL: 'deploy:cancel',
  DEPLOY_PROGRESS: 'deploy:progress', // 主进程 → 渲染进程推送事件
  DEPLOY_LOG_ENTRY: 'deploy:log-entry', // 主进程 → 渲染进程：CLI / MCP 触发的上传结果（含来源标注）

  // 配置
  CONFIG_LOAD: 'config:load',
  CONFIG_SAVE: 'config:save',
  // 目标管理
  TARGET_LIST: 'target:list',
  TARGET_ADD: 'target:add',
  TARGET_UPDATE: 'target:update',
  TARGET_REMOVE: 'target:remove',

  // 映射管理
  MAPPING_ADD: 'mapping:add',
  MAPPING_UPDATE: 'mapping:update',
  MAPPING_REMOVE: 'mapping:remove',

  // 本地服务端（默认关闭；开启后 CLI/MCP 可调用）
  SERVER_GET_CONFIG: 'server:get-config',
  SERVER_SAVE_CONFIG: 'server:save-config',
  SERVER_GET_STATUS: 'server:get-status',
  SERVER_REGENERATE_TOKEN: 'server:regenerate-token',
  SERVER_STATUS_CHANGED: 'server:status-changed', // 主进程 → 渲染进程：状态/队列变化推送（无轮询）
  SERVER_EXPORT_CONNECTION: 'server:export-connection',

  // 系统对话框
  DIALOG_OPEN_FILE: 'dialog:open-file',

  // 自绘菜单栏动作（渲染进程 → 主进程）
  APP_ACTION: 'app:action',

  /** 打开全局设置窗口（单实例；payload: 'targets' | 'server'） */
  SETTINGS_OPEN: 'settings:open',
  /** 主进程 → 设置窗口：切换标签页 */
  SETTINGS_SECTION: 'settings:section',
  /** 设置窗口 → 主进程：上报未保存状态（关窗守门用，避免关窗时丢改动） */
  SETTINGS_DIRTY: 'settings:dirty',
  /** 主进程 → 设置窗口：关闭被拦下（有未保存改动），请就地确认 */
  SETTINGS_CONFIRM_CLOSE: 'settings:confirm-close',

  /** 本窗口的权威状态（角色会随绑定/解绑项目变化） */
  WINDOW_GET_STATE: 'window:get-state',

  /** 本窗口自我关闭（项目窗口 → 关闭该项目；主窗口 → 隐藏） */
  WINDOW_CLOSE_SELF: 'window:close-self',

  /** 打开一个项目文件夹（拖拽 / 外部入口）：主进程校验是目录后开项目窗口 */
  PROJECT_OPEN_FOLDER: 'project:open-folder',

  /** 按项目记忆的界面状态（视图/日志面板/Git 筛选） */
  PROJECT_VIEW_GET: 'project:view-get',
  PROJECT_VIEW_SAVE: 'project:view-save',

  /** 配置（目标/映射/服务端）被其他窗口修改：主进程 → 所有窗口广播 */
  CONFIG_CHANGED: 'config:changed',

  // 多窗口观测（窗口列表 / 最近聚焦）
  WINDOW_LIST: 'window:list',
  /** 项目窗口数量达到阈值时的提示（主进程 → 触发这次打开的那个窗口） */
  WINDOW_LIMIT_HINT: 'window:limit-hint',
  /** 取走待处理的窗口数量提示（拉取式：push 可能早于渲染层订阅） */
  WINDOW_LIMIT_HINT_TAKE: 'window:limit-hint-take',

  // 应用信息（版本号等）
  APP_GET_VERSION: 'app:get-version',

  // 菜单同步（渲染进程 → 主进程，单向）
  MENU_SYNC_STATE: 'menu:sync-state',
  // 主进程 → 渲染进程：打开指定项目（自绘菜单栏的「最近项目」走这里）
  MENU_OPEN_PROJECT: 'menu:open-project',
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
