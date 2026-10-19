/**
 * MCP 工具层（不依赖 MCP SDK，便于离线测试与复用）。
 *
 * 工具集必须与 CLI 命令集一一对应（CON-9 / AC-030）：
 * list_targets / ping_targets / plan_deploy / deploy / git_status / git_log / server_status / task_status
 *
 * 所有调用都转发到本机桌面服务端（INV-2），client 标识固定为 `mcp`（D-25）。
 */
import { errEnvelope, type Envelope } from '../shared/cli-contract'
import type { Selector } from '../shared/cli-contract'
import type { Query, ServerClient } from './client'
import { toEnvelope } from './client'
import { correctTaskEnvelope } from '../shared/task-verdict'
import { waitForTask } from './task-wait'

/** 与 HTTP 接口的映射关系（字段为兼容契约，CON-1） */
export interface ToolDefinition {
  name: string
  title: string
  description: string
  /** 对应 CLI 命令（用于核对一一对应关系） */
  cli: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

/**
 * 项目根（策略 D′：**必填**）。
 *
 * 多窗口下「桌面当前项目」= 最近聚焦的窗口，会在 plan 与 deploy 之间漂移，
 * 导致把 A 的计划提交到 B → 因此项目必须由调用方显式给出。
 * 可用 `list_projects` 查看桌面当前已打开的项目。
 */
const projectProps = {
  projectRoot: {
    type: 'string',
    description: '项目根目录（必填）；可用 list_projects 查看桌面已打开的项目'
  }
} as const

const selectorProps = {
  selector: {
    type: 'object',
    description: '待上传范围；缺省按当前变更（all-changed）',
    oneOf: [
      { type: 'object', properties: { kind: { const: 'all-changed' } }, required: ['kind'] },
      { type: 'object', properties: { kind: { const: 'last-commit' } }, required: ['kind'] },
      { type: 'object', properties: { kind: { const: 'dir' }, path: { type: 'string' } }, required: ['kind', 'path'] },
      {
        type: 'object',
        properties: { kind: { const: 'files' }, paths: { type: 'array', items: { type: 'string' } } },
        required: ['kind', 'paths']
      }
    ]
  }
} as const

export const MCP_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'list_targets',
    title: '列出上传目标',
    description: '列出桌面版配置的上传目标（不含凭据）；给出 name 时返回该目标详情与目录映射。',
    cli: 'targets list / targets show',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '目标名；省略则返回清单' } },
      additionalProperties: false
    }
  },
  {
    name: 'list_projects',
    title: '列出已打开的项目',
    description: '列出桌面版当前已打开的项目（路径 / 名称 / 窗口 / 是否聚焦）。项目相关工具需要显式 projectRoot，可先用本工具发现可用项目。',
    cli: 'projects list',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'ping_targets',
    title: '校验目标连通性',
    description: '校验指定目标能否连接；失败返回连接类错误与原因。',
    cli: 'targets ping',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: '目标名' } },
      required: ['target'],
      additionalProperties: false
    }
  },
  {
    name: 'plan_deploy',
    title: '生成上传计划',
    description: '按目标与选择器计算待上传清单与跳过项；计划阶段不建立远端连接。',
    cli: 'plan',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标名' },
        ...selectorProps,
        ...projectProps
      },
      required: ['target', 'projectRoot'],
      additionalProperties: false
    }
  },
  {
    name: 'deploy',
    title: '提交上传',
    description: '提交上传任务；默认异步返回 taskId，wait 为真时等待完成（默认上限 300 秒，超时不取消任务）。',
    cli: 'deploy',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标名' },
        ...selectorProps,
        ...projectProps,
        wait: { type: 'boolean', description: '是否等待任务完成' },
        waitTimeoutSeconds: { type: 'number', description: '等待上限（秒），默认 300' },
        expectFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '只允许上传这一组文件（与 plan 结果比对，防止计划之后集合漂移）'
        }
      },
      required: ['target', 'projectRoot'],
      additionalProperties: false
    }
  },
  {
    name: 'git_status',
    title: '查询未提交变更',
    description: '返回当前分支与未提交变更清单（relativePath 与部署口径一致）。',
    cli: 'git status',
    inputSchema: {
      type: 'object',
      properties: { ...projectProps },
      required: ['projectRoot'],
      additionalProperties: false
    }
  },
  {
    name: 'git_log',
    title: '查询提交历史',
    description: '返回提交历史，可按分支、提交者与条数筛选。',
    cli: 'git log',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: '分支名' },
        author: { type: 'string', description: '提交者' },
        limit: { type: 'number', description: '条数，默认 20' },
        ...projectProps
      },
      required: ['projectRoot'],
      additionalProperties: false
    }
  },
  {
    name: 'server_status',
    title: '查询服务端状态',
    description: '返回服务端监听状态、端口、包版本、协议版本、最近聚焦项目（仅展示）、已打开项目列表与队列快照。',
    cli: 'status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'task_status',
    title: '查询上传任务',
    description: '按 taskId 查询任务状态、进度与逐文件明细；重启后被清理的任务返回未知任务。',
    cli: 'task',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '任务 ID' } },
      required: ['taskId'],
      additionalProperties: false
    }
  }
]

/** 工具名清单（供核对与文档） */
export function mcpToolNames(): string[] {
  return MCP_TOOLS.map((t) => t.name).sort()
}

/** 连接提供者：每次工具调用前重读连接信息（常驻进程令牌可能已轮换，AC-029） */
export interface McpConnectionProvider {
  connect(): Promise<{ ok: true; client: ServerClient } | { ok: false; error: { code: string; message: string; hint?: string } }>
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/** 组装项目上下文参数（仅在有值时出现，保持请求体最小） */
function projectParams(args: Record<string, unknown>): Query {
  const projectRoot = str(args.projectRoot)
  return { ...(projectRoot ? { projectRoot } : {}) }
}

/**
 * 解析工具入参中的选择器：未提供 → null（服务端按当前变更缺省）；
 * 提供了但非法 → 用法错误，绝不降级成缺省（否则会把范围放大成「全部变更」）。
 */
type SelectorParse = { kind: 'absent' } | { kind: 'invalid'; reason: string } | { kind: 'ok'; selector: Selector }

function parseSelectorArg(args: Record<string, unknown>): SelectorParse {
  const raw = args.selector
  if (raw === undefined || raw === null) return { kind: 'absent' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'selector 必须是对象' }
  const value = raw as Record<string, unknown>
  switch (value.kind) {
    case 'all-changed':
      return { kind: 'ok', selector: { kind: 'all-changed' } }
    case 'last-commit':
      return { kind: 'ok', selector: { kind: 'last-commit' } }
    case 'dir': {
      const path = str(value.path) ?? ''
      return path.trim().length > 0
        ? { kind: 'ok', selector: { kind: 'dir', path: path.trim() } }
        : { kind: 'invalid', reason: 'selector.kind=dir 需要非空 path' }
    }
    case 'files': {
      const paths = Array.isArray(value.paths)
        ? value.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : []
      return paths.length > 0
        ? { kind: 'ok', selector: { kind: 'files', paths } }
        : { kind: 'invalid', reason: 'selector.kind=files 需要非空 paths' }
    }
    default:
      return { kind: 'invalid', reason: `未知选择器类型：${String(value.kind)}` }
  }
}

/** 重试期间复用的调用状态：避免把已提交的上传任务再提交一次（P2-4） */
interface InvokeState {
  /** `deploy` 已提交的任务 ID（重试时只继续轮询，不重复提交） */
  submittedTaskId?: string
}

/** 单次工具调用（不做重试） */
async function invoke(
  name: string,
  args: Record<string, unknown>,
  client: ServerClient,
  state: InvokeState
): Promise<Envelope> {
  switch (name) {
    case 'list_targets': {
      const targetName = str(args.name)
      return toEnvelope(await client.get('/targets', targetName ? { name: targetName } : undefined))
    }
    case 'ping_targets':
      return toEnvelope(await client.post('/test-connection', { target: str(args.target) }))
    case 'list_projects':
      return toEnvelope(await client.get('/projects'))
    case 'plan_deploy': {
      const selector = parseSelectorArg(args)
      if (selector.kind === 'invalid') return errEnvelope('USAGE', `选择器非法：${selector.reason}`)
      return toEnvelope(
        await client.post('/plan', {
          target: str(args.target),
          selector: selector.kind === 'ok' ? selector.selector : null,
          ...projectParams(args)
        })
      )
    }
    case 'deploy': {
      const selector = parseSelectorArg(args)
      if (selector.kind === 'invalid') return errEnvelope('USAGE', `选择器非法：${selector.reason}`)

      let submitEnvelope: Envelope | null = null
      if (!state.submittedTaskId) {
        // expectFiles 是"防集合漂移"的护栏（服务端与 plan 结果比对，不一致即拒绝提交）。
        // schema 声明了它、文档也写了，但请求体此前**从不携带** → PLAN_STALE 永不触发，
        // 计划之后漂移的文件集合会被静默上传（护栏形同不存在）。
        // 提供即必须合法：静默降级（类型不符/全空白 → 当作"未提供"）会让护栏悄悄消失，
        // 而调用方以为集合已被钉住。NaN 处理与 selector 一致：非法一律 USAGE，不降级成缺省。
        let expectedFiles: string[] = []
        if (args.expectFiles !== undefined) {
          if (!Array.isArray(args.expectFiles) || args.expectFiles.length === 0) {
            return errEnvelope('USAGE', 'expectFiles 需为非空字符串数组')
          }
          expectedFiles = (args.expectFiles as unknown[]).map((p) => str(p)).filter((p): p is string => !!p)
          if (expectedFiles.length !== (args.expectFiles as unknown[]).length) {
            return errEnvelope('USAGE', 'expectFiles 只能包含非空字符串')
          }
        }
        // wait 同样按声明类型校验：'true'（字符串）此前被静默当成异步
        if (args.wait !== undefined && typeof args.wait !== 'boolean') {
          return errEnvelope('USAGE', 'wait 需为布尔值')
        }
        const submitted = await client.post('/deploy', {
          target: str(args.target),
          selector: selector.kind === 'ok' ? selector.selector : null,
          ...(expectedFiles.length > 0 ? { expectFiles: expectedFiles } : {}),
          ...projectParams(args)
        })
        submitEnvelope = toEnvelope(submitted)
        if (!submitEnvelope.ok) return submitEnvelope
        // 记录已提交任务：重试（令牌轮换）时不再重复提交上传
        state.submittedTaskId = (submitEnvelope.data as { taskId: string }).taskId
      }
      const taskId = state.submittedTaskId

      if (bool(args.wait) !== true) {
        // 首次提交：原样返回服务端信封（保留 position / totalFiles / meta，契约不变）
        if (submitEnvelope) return submitEnvelope
        // 重试恢复（令牌轮换后重进本函数、首次提交已在上一轮完成）：
        // 没有提交信封可复用，退化为查询任务详情；它与提交信封形状不同，调用方按 state 判读
        return toEnvelope(await client.get(`/tasks/${encodeURIComponent(taskId)}`))
      }
      const timeoutSeconds = num(args.waitTimeoutSeconds) ?? 300
      // CLI 侧有正整数校验，MCP 侧此前没有：负数/小数会直接把等待窗口算成 0 或 NaN
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
        return errEnvelope('USAGE', `waitTimeoutSeconds 需为正整数：${String(args.waitTimeoutSeconds)}`)
      }
      return waitForTask(client, taskId, { timeoutSeconds })
    }
    case 'git_status':
      return toEnvelope(await client.get('/git/status', projectParams(args)))
    case 'git_log':
      return toEnvelope(
        await client.get('/git/log', {
          ...projectParams(args),
          ...(str(args.branch) ? { branch: str(args.branch) as string } : {}),
          ...(str(args.author) ? { author: str(args.author) as string } : {}),
          ...(num(args.limit) !== undefined ? { limit: num(args.limit) as number } : {})
        })
      )

    case 'server_status':
      return toEnvelope(await client.get('/status'))
    case 'task_status': {
      const taskId = str(args.taskId)
      if (!taskId) return errEnvelope('USAGE', '缺少 taskId')
      // 与 CLI task 命令同一套终态判定（被取消但 state=succeeded 的任务报 PARTIAL）
      return correctTaskEnvelope(toEnvelope(await client.get(`/tasks/${encodeURIComponent(taskId)}`)))
    }
    default:
      return errEnvelope('USAGE', `未知工具：${name}`, `可用工具：${mcpToolNames().join('、')}`)
  }
}

/** 需要「重读连接信息并重试一次」的错误类别（令牌轮换 / 证书变化） */
const RETRYABLE = ['INVALID_TOKEN', 'TLS_MISMATCH'] as const

/**
 * 工具调用入口：每次调用前重读连接信息；遇令牌或指纹失效时重读一次并重试一次（AC-029）。
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> | undefined,
  provider: McpConnectionProvider
): Promise<Envelope> {
  const input = args ?? {}

  // 参数白名单：**必须**在调用前拒绝未知参数。
  //
  // 事故背景：deploy 的选择器是 `selector: { kind: 'files', paths }`，没有 `files` 字段。
  // 传错名字时若静默忽略，`selector` 就落到默认的 all-changed —— 一次"只传一个文件"的调用
  // 实际上传了 23 个文件。对写操作来说，这不是"宽容"，是危险。
  const tool = MCP_TOOLS.find((t) => t.name === name)
  if (tool) {
    const allowed = Object.keys(tool.inputSchema.properties)
    const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
    if (unknown.length > 0) {
      return errEnvelope(
        'USAGE',
        `未知参数：${unknown.join('、')}（工具 ${name}）`,
        `允许的参数：${allowed.join('、')}`
      )
    }
  }

  const state: InvokeState = {}

  const first = await provider.connect()
  if (!first.ok) {
    return errEnvelope('BACKEND_UNAVAILABLE', first.error.message, first.error.hint)
  }
  const envelope = await invoke(name, input, first.client, state)
  if (envelope.ok) return envelope
  if (!RETRYABLE.includes(envelope.error.code as (typeof RETRYABLE)[number])) return envelope

  // 桌面版重启会导致令牌轮换：重读一次连接信息并重试一次。
  // state 复用保证 deploy 不会因为重试而重复提交上传任务（覆盖远端文件）。
  const second = await provider.connect()
  if (!second.ok) {
    return errEnvelope('BACKEND_UNAVAILABLE', second.error.message, second.error.hint)
  }
  return invoke(name, input, second.client, state)
}
