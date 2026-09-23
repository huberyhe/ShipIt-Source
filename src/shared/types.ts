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
}
