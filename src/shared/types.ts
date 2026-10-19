/**
 * 领域模型类型定义（主进程与渲染进程共享）
 *
 * 主进程服务负责生产这些类型，渲染进程 store 负责消费。
 * 修改字段时保持双向同步 —— 该文件是唯一事实来源。
 */

/**
 * 传输协议
 * - sftp: SSH 文件传输
 * - ftp: 传统 FTP
 * - ftps: FTP over 隐式 TLS（专用 990 端口）
 * - ftpes: FTP over 显式 TLS（21 端口，AUTH TLS）
 * - local: 本地/挂载文件夹（host 为本地根目录）
 */
export type Protocol = 'sftp' | 'ftp' | 'ftps' | 'ftpes' | 'local'

/** 目录映射规则：本地路径前缀 → 远程路径前缀 */
export interface DirectoryMapping {
  id: string
  /** 本地路径前缀（相对项目根目录），如 "manage/" */
  localPrefix: string
  /** 远程路径前缀，如 "/opt/ssmp/" */
  remotePath: string
  description?: string
}

/** 单个项目的界面状态（按项目记忆，重启后恢复：多项目多窗口下每窗口一份） */
export interface ProjectViewState {
  /** 主视图：文件树 / Git 变更 / Git 日志 */
  activeView?: 'filetree' | 'gitchanges' | 'gitlog'
  /** 上传日志面板是否展开 */
  logPanelExpanded?: boolean
  /** Git 日志筛选（分支 ref / 提交者） */
  gitLogBranch?: string
  gitLogAuthor?: string
}

/** 部署目标（服务器连接配置 + 目录映射） */
export interface DeployTarget {
  id: string
  name: string
  protocol: Protocol
  host: string
  port: number
  username: string
  password?: string
  /** SFTP 私钥文件路径 */
  privateKeyPath?: string
  passphrase?: string
  mappings: DirectoryMapping[]
}

/** 目标摘要（前端清单展示用；不含任何凭据字段，INV-5） */
export interface TargetSummary {
  name: string
  protocol: Protocol
  host: string
  port: number
  /** 目录映射条数 */
  mappingCount: number
}

/** 目标详情（含目录映射；同样不含凭据） */
export interface TargetDetail extends TargetSummary {
  username: string
  mappings: Array<{
    localPrefix: string
    remotePath: string
    description?: string
  }>
}

/** 上传任务状态：只能单向推进（INV-12） */
export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed'

/** 上传任务进度 */
export interface UploadTaskProgress {
  current: number
  total: number
  file: string
}

/**
 * 上传任务对象（仅内存，最多保留最近 50 条；重启即清空，CON-10）。
 * origin 取值 desktop / cli / mcp，由前端声明的 client 决定，不猜测（D-25）。
 */
export interface UploadTaskRecord {
  taskId: string
  state: TaskState
  progress: UploadTaskProgress
  createdAt: number
  startedAt?: number
  finishedAt?: number
  origin: 'desktop' | 'cli' | 'mcp'
  client?: 'cli' | 'mcp'
  /** 来源地址（跨机器调用时用于界面日志标注，不持久化） */
  remoteAddress?: string
  target: string
  projectRoot: string
  totalFiles: number
  result?: DeployResult
  cancelled?: boolean
  error?: {
    code: string
    message: string
  }
}

/** 提交上传任务的返回（默认异步语义，AC-032） */
export interface TaskSubmitResult {
  taskId: string
  /** 队列位置：1 表示立即执行 */
  position: number
  state: TaskState
  createdAt: number
  totalFiles: number
  target: string
  projectRoot: string
  /**
   * 本次实际进入上传集合的文件（项目相对路径，与 plan 的 items 口径一致）。
   * 提交接口按选择器重算任务，回传实际集合便于调用方与 plan 结果比对（防静默漂移）。
   */
  files: string[]
}

/** 等待结束后的结果（`--wait` / MCP wait） */
export interface TaskResultView {
  taskId: string
  state: TaskState
  target: string
  projectRoot: string
  origin: 'desktop' | 'cli' | 'mcp'
  summary: {
    totalFiles: number
    succeeded: number
    failed: number
    skipped: number
    duration: number
    cancelled: boolean
  }
  details: DeployDetail[]
}

/** 队列状态：空闲 / 有任务在执行且无排队 / 有排队（可能同时也在执行） */
export type QueueState = 'idle' | 'running' | 'waiting'

/**
 * 状态/列表用的轻量任务摘要：**不含逐文件明细**。
 *
 * 状态快照会随每次「提交/开始/结束」广播给所有窗口，并被每个 CLI 命令的预检读取；
 * 带上 `details` 时单次响应可达数 MB（50 任务 × 数千文件），明细请走 `GET /tasks/:id`。
 */
export type QueueTaskSummary = Omit<UploadTaskRecord, 'result'> & {
  result?: Pick<DeployResult, 'totalFiles' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'>
}

/** 队列快照（状态接口返回） */
export interface QueueSnapshot {
  /** 队列状态摘要（idle：无任务且无排队；running：有任务执行且无排队；waiting：有排队任务） */
  state: QueueState
  /** 正在执行的任务 ID；空闲为 null */
  runningTaskId: string | null
  /** 仍在排队等待的任务数 */
  pendingCount: number
  /** 任务摘要表（按提交时间升序，最多 50 条；明细不进快照） */
  tasks: QueueTaskSummary[]
}

/** 计划项：命中目录映射的文件（relativePath 统一为正斜杠，DFX-PORT-001） */
export interface PlanItem {
  relativePath: string
  remotePath: string
  size: number
  /** 命中的目录映射（最长前缀优先） */
  mapping: {
    localPrefix: string
    remotePath: string
  }
}

/**
 * 跳过项：不进入上传集合（INV-3）。
 *
 * reason 区分真实原因，避免排障被带偏：
 * - `no-mapping`：文件存在但未命中任何目录映射
 * - `missing`：文件不存在（已删除 / 未提交 / 路径不在项目内）
 */
export interface PlanSkip {
  relativePath: string
  reason: 'no-mapping' | 'missing'
}

/** 待上传计划（服务端计算，计划阶段不建立远端连接，INV-1） */
export interface DeployPlan {
  projectRoot: string
  target: string
  items: PlanItem[]
  skipped: PlanSkip[]
}

/** 单个文件的上传任务 */
export interface UploadTask {
  localPath: string
  remotePath: string
  relativePath: string
  size: number
}

/** 单个文件部署结果明细 */
export interface DeployDetail {
  relativePath: string
  remotePath: string
  status: 'success' | 'failed' | 'skipped'
  error?: string
}

/** 一次部署的完整结果 */
export interface DeployResult {
  taskId: string
  targetName: string
  timestamp: number
  totalFiles: number
  succeeded: number
  failed: number
  skipped: number
  /** 是否被用户取消（取消后不再上传剩余文件） */
  cancelled?: boolean
  duration: number
  details: DeployDetail[]
}

/** Git 工作区单个变更文件 */
/**
 * 上传日志条目：部署结果 + 来源标注（desktop / cli / mcp）。
 *
 * 跨进程类型（主进程按 DEPLOY_LOG_ENTRY 推给渲染层），因此定义在 shared（铁律 1）。
 * 仅存在于内存，不写磁盘（CON-6）。
 */
export interface DeployLogEntry {
  taskId: string
  targetName: string
  timestamp: number
  totalFiles: number
  succeeded: number
  failed: number
  skipped: number
  duration: number
  details: DeployDetail[]
  cancelled?: boolean
  origin: 'desktop' | 'cli' | 'mcp'
  projectRoot?: string
  /** 来源地址（跨机器调用时标注） */
  remoteAddress?: string
}

export interface GitChangeInfo {
  path: string
  relativePath: string
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
  /** 重命名时的原路径 */
  oldPath?: string
}

/** 一次 Git 提交 */
export interface GitCommitInfo {
  hash: string
  date: string
  author: string
  email: string
  message: string
}

/**
 * Git 分支条目（本地 / 远程）
 * - name：展示用名称，远程分支默认不带 remote 前缀（如 "2.0.2SP5"）；
 *   仓库存在多个远程时保留前缀（如 "shipit/main"）以区分同名分支
 * - ref：git 引用，用于 `git log <ref>`（本地 "main"，远程 "origin/main"）
 * - isRemote：远程分支标记，渲染层用于附加 ☁️
 */
export interface GitBranchInfo {
  name: string
  ref: string
  isRemote: boolean
}

/** Git 状态视图（未提交变更 + 分支信息） */
export interface GitStatusView {
  hasGit: boolean
  branch?: string
  changes: GitChangeInfo[]
  ahead: number
  behind: number
}

/** 应用持久化配置 */
export interface AppConfig {
  recentProjects: string[]
  deploymentTargets: DeployTarget[]
  currentTargetId?: string
  theme?: string
  /** 本地服务端配置（默认关闭，见服务端配置模块） */
  server?: ServerConfig
  /** 按项目记忆的界面状态（键为归一化后的项目路径） */
  projectViewState?: Record<string, ProjectViewState>
}

/** 绑定范围：仅本机回环 / 局域网 */
export type ServerBind = 'local' | 'lan'

/** 令牌来源：自动生成（默认） / 用户自定义 */
export type TokenMode = 'random' | 'custom'

/**
 * 本地服务端配置。
 * 默认 `enabled: false`（不监听）、`bind: 'local'`、令牌自动生成（INV-4 / INV-5）。
 */
export interface ServerConfig {
  enabled: boolean
  bind: ServerBind
  port: number
  tokenMode: TokenMode
  token: string
  /**
   * 允许的项目根（**仅 `bind: 'lan'` 生效**）。
   *
   * 本机回环时任何路径都允许（桌面版本就能读写本机文件）；
   * 一旦开放到局域网，"可操作哪些目录"必须收口，否则持有令牌的对端
   * 可以上传/读取该机器上任意位置的文件。
   * 已经打开的项目始终视为允许（无需在此重复登记）。
   */
  allowedRoots: string[]
}
