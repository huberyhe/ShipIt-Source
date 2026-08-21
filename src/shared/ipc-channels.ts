/**
 * IPC 通道常量（主进程注册 handler / preload 暴露的 key 都引用这里）
 * 命名规则: 域_动作，如 PROJECT_OPEN / DEPLOY_UPLOAD
 */
export const IpcChannels = {
  // 项目
  PROJECT_OPEN: 'project:open',
  PROJECT_GET_RECENT: 'project:get-recent',

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

  // 系统对话框
  DIALOG_OPEN_FILE: 'dialog:open-file',

  // 菜单同步（渲染进程 → 主进程，单向）
  MENU_SYNC_STATE: 'menu:sync-state',
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
