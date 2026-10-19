/**
 * CLI / MCP 前端与桌面服务端共享的协议契约。
 *
 * 这里只放**协议级**常量与响应外壳；业务领域类型（DeployTarget / GitCommitInfo /
 * GitBranchInfo 等）仍然只在 `shared/types.ts` 定义（铁律 1）。
 *
 * 字段与取值一旦发布即为兼容契约，只允许追加（CON-1）。
 */

/** 协议版本：前后端不一致时服务端拒绝请求（INV-8 / CON-4） */
export const PROTOCOL_VERSION = 1

/** 调用方标识：cli / mcp；桌面界面走内部调用、不带该头（D-25） */
export type ClientKind = 'cli' | 'mcp'

/** 请求头名称（前后端共用） */
export const HEADER = {
  token: 'x-shipit-token',
  protocol: 'x-shipit-protocol',
  client: 'x-shipit-client'
} as const

/**
 * 错误类别（CON-1：取值只能追加）。
 *
 * **运行期数组是唯一来源**，联合类型由它派生 —— 这样"新增类别却忘了加进白名单"
 * 这种漂移在类型层面就不可能发生（此前只有类型、没有运行期清单）。
 */
export const ERROR_CODES = [
  'USAGE',
  'NO_TARGET',
  'NO_MAPPING',
  'CONNECT_FAILED',
  'PARTIAL',
  'NOT_A_REPO',
  'EMPTY_SELECTION',
  'EMPTY_RESULT',
  'BACKEND_UNAVAILABLE',
  'PROTOCOL_MISMATCH',
  'INVALID_TOKEN',
  'QUEUE_TIMEOUT',
  'WAIT_TIMEOUT',
  'PORT_IN_USE',
  'TLS_MISMATCH',
  /** 请求的项目超出允许范围（仅局域网绑定生效，退出码 4） */
  'PROJECT_OUT_OF_SCOPE',
  'UNKNOWN_TASK',
  /** 队列积压达上限（本次提交未入队）；环境类，退出码 3 */
  'QUEUE_FULL',
  /** 单任务执行超时（看门狗中断等待，任务已标记失败）；环境类，退出码 3 */
  'TASK_TIMEOUT',
  /** 计划已过期：实际文件集合与 expectFiles 不一致（未提交任何任务）；配置/状态类，退出码 4 */
  'PLAN_STALE'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * 待上传范围选择器（四种取值互斥；缺省由服务端按当前变更处理，不由前端推断）。
 * 字段为兼容契约（CON-1）。
 */
export type Selector =
  | { kind: 'all-changed' }
  | { kind: 'files'; paths: string[] }
  | { kind: 'dir'; path: string }
  | { kind: 'last-commit' }

/** 成功外壳 */
export interface OkEnvelope<T = unknown> {
  ok: true
  command?: string
  data: T
  /** 来源、时间、目标、计数、projectRoot 等（CON-2：与进度事件分离） */
  meta?: Record<string, unknown>
}

/** 失败外壳 */
export interface ErrEnvelope {
  ok: false
  error: {
    code: ErrorCode
    message: string
    hint?: string
  }
  /** 部分失败等场景需要回传的明细（字段为兼容契约，仅允许追加） */
  data?: unknown
}

export type Envelope<T = unknown> = OkEnvelope<T> | ErrEnvelope

/** 退出码语义（CON-1） */
export const EXIT_CODE = {
  ok: 0,
  usage: 1,
  partial: 2,
  environment: 3,
  config: 4
} as const

/**
 * 错误类别的退出码归类（**表驱动**）。
 *
 * 为什么不用"数组 + 兜底"：`ErrorCode` 新增一项时，数组写法不会报错，会**静默落进 environment(3)**，
 * 让按退出码分流的脚本误判。用 `Record<ErrorCode, ExitClass>` 后，漏归类是**类型错误**，编译期就会拦住。
 */
type ExitClass = 'usage' | 'partial' | 'config' | 'environment'

const EXIT_CLASS: Record<ErrorCode, ExitClass> = {
  // 用法类（退出码 1）：调用方参数/选择器/项目根缺失
  USAGE: 'usage',
  // 部分失败（退出码 2）
  PARTIAL: 'partial',
  // 配置、目标与计划状态类（退出码 4）
  NO_TARGET: 'config',
  UNKNOWN_TASK: 'config',
  PLAN_STALE: 'config',
  PROJECT_OUT_OF_SCOPE: 'config',
  // 以下为"保留类别"：当前没有生产者（见 CON-1 的只增不改），归入环境类以便将来启用时不改退出码语义
  NO_MAPPING: 'environment',
  EMPTY_RESULT: 'environment',
  // 环境与后端类（退出码 3）
  CONNECT_FAILED: 'environment',
  NOT_A_REPO: 'environment',
  EMPTY_SELECTION: 'environment',
  BACKEND_UNAVAILABLE: 'environment',
  PROTOCOL_MISMATCH: 'environment',
  INVALID_TOKEN: 'environment',
  QUEUE_TIMEOUT: 'environment',
  WAIT_TIMEOUT: 'environment',
  PORT_IN_USE: 'environment',
  TLS_MISMATCH: 'environment',
  QUEUE_FULL: 'environment',
  TASK_TIMEOUT: 'environment'
}

/**
 * 错误类别 → 进程退出码。
 * 0 成功 / 1 用法 / 2 部分失败 / 3 环境与后端类 / 4 配置与目标类
 */
export function exitCodeOf(code: ErrorCode): number {
  switch (EXIT_CLASS[code]) {
    case 'usage':
      return EXIT_CODE.usage
    case 'partial':
      return EXIT_CODE.partial
    case 'config':
      return EXIT_CODE.config
    default:
      return EXIT_CODE.environment
  }
}

/** 供自检/测试使用：所有类别的归类结果（保证"每个 ErrorCode 都有归类"） */
export const EXIT_CLASS_OF: Readonly<Record<ErrorCode, ExitClass>> = EXIT_CLASS

/** 构造成功信封 */
export function okEnvelope<T>(data: T, meta?: Record<string, unknown>, command?: string): OkEnvelope<T> {
  return command ? { ok: true, command, data, meta } : { ok: true, data, meta }
}

/** 构造失败信封；data 用于携带失败明细（如 PARTIAL） */
export function errEnvelope(code: ErrorCode, message: string, hint?: string, data?: unknown): ErrEnvelope {
  const env: ErrEnvelope = { ok: false, error: hint ? { code, message, hint } : { code, message } }
  if (data !== undefined) env.data = data
  return env
}

/**
 * 统一成功响应的 meta（CON-2：与进度事件分离；含来源、时间、目标与计数）。
 * 时间使用 ISO 8601，便于调用方排序与审计。
 */
export function metaOf(input: {
  origin?: 'desktop' | ClientKind
  target?: string | null
  count?: number
  projectRoot?: string | null
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  const meta: Record<string, unknown> = { generatedAt: new Date().toISOString() }
  if (input.origin) meta.origin = input.origin
  if (input.target) meta.target = input.target
  if (typeof input.count === 'number') meta.count = input.count
  if (input.projectRoot) meta.projectRoot = input.projectRoot
  return input.extra ? { ...meta, ...input.extra } : meta
}
