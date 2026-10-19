/**
 * 本地服务端的业务处理器。
 *
 * 传输与鉴权在 `local-server.ts`，这里只负责把请求映射到既有服务层
 * （`ConfigStore` / `DeployService` / `GitService` / `FileService` / 上传队列），
 * 保证桌面界面、CLI、MCP 三条入口共用同一份执行逻辑（INV-2 / DFX-REUSE-001）。
 */
import { errEnvelope, metaOf, okEnvelope, PROTOCOL_VERSION, type Envelope, type ErrorCode, type Selector } from '../../shared/cli-contract'
import type {
  DeployPlan,
  GitBranchInfo,
  GitCommitInfo,
  GitStatusView,
  DeployResult,
  DeployTarget,
  TaskSubmitResult,
  TargetDetail,
  TargetSummary,
  UploadTask
} from '../../shared/types'
import { QueueError, type DeployQueue, type SubmitResult } from './deploy-queue'
import type { RouteHandler, RequestContext, Handlers } from './local-server'
import { resolveSelection, toPlanItems, toPlanSkips, toSlashes, type SelectionDeps } from './selection'
import type { ResolveProjectInput, ResolveProjectResult } from './project-context'
import { isSafeGitRev } from '../../shared/git-rev'

export interface ServerHandlerDeps {
  /** 读取目标配置（与桌面设置共用同一配置文件） */
  loadTargets: () => Promise<DeployTarget[]>
  /** 校验目标连通性（复用既有实现） */
  testConnection: (target: DeployTarget) => Promise<{ success: boolean; error?: string }>
  /** 项目解析（策略 D′：**项目根必填**；缺失返回 USAGE） */
  resolveProject: (input: ResolveProjectInput) => ResolveProjectResult
  /** 仅用于展示：桌面最近聚焦的项目根（不参与执行路径的项目解析） */
  projectContext: { currentProject: () => string | null }
  /** 桌面当前已打开的项目（供 `GET /projects` 发现：策略 D′ 下调用方需要知道能传什么） */
  listProjects: () => Promise<Array<{ path: string; name: string; windowId: number; focused: boolean }>>
  /** 桌面直连会话快照（不进队列）：可观测性，供退出前判断与界面显示 */
  activeSessions: () => Array<{ owner: string; target: string; windowId?: number }>
  /** 当前项目作用域（D-25）：让调用方知道"除已打开项目外还能操作哪些目录" */
  projectScope: () => { enforce: boolean; allowedRoots: string[] }
  /** 选择器依赖（Git 与目录列举） */
  selection: SelectionDeps
  /** 计算上传任务（复用既有实现；计划阶段不建立远端连接） */
  buildUploadTasks: (files: string[], projectRoot: string, target: DeployTarget) => Promise<UploadTask[]>
  /** 上传互斥队列（单会话串行） */
  queue: DeployQueue
  /** 包版本（CON-3：取自包，禁止硬编码） */
  getVersion: () => string
  /** 只读 Git 查询（复用既有 GitService；不做任何写操作） */
  git: {
    isGitRepo: (dir: string) => Promise<boolean>
    getStatusView: (dir: string) => Promise<GitStatusView>
    getLogView: (dir: string, options?: { branch?: string; author?: string; maxCount?: number }) => Promise<GitCommitInfo[]>
    getBranches: (dir: string) => Promise<GitBranchInfo[]>
  }
  /** 执行上传（复用既有 DeployService.deploy） */
  deploy: (
    tasks: UploadTask[],
    target: DeployTarget,
    onProgress: (current: number, total: number, file: string) => void,
    /** 队列任务上下文：取消信号（看门狗超时）必须往下传 */
    jobCtx?: { signal?: AbortSignal }
  ) => Promise<DeployResult>
}

/** 目标 → 摘要（去掉一切凭据字段，INV-5 / AC-001） */
export function toTargetSummary(target: DeployTarget): TargetSummary {
  return {
    name: target.name,
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    mappingCount: target.mappings?.length ?? 0
  }
}

/** 目标 → 详情（映射不含 id，凭据一律不出现） */
export function toTargetDetail(target: DeployTarget): TargetDetail {
  return {
    ...toTargetSummary(target),
    username: target.username,
    mappings: (target.mappings ?? []).map((m) => ({
      localPrefix: m.localPrefix,
      remotePath: m.remotePath,
      ...(m.description ? { description: m.description } : {})
    }))
  }
}

/** 从 query 或 JSON body 中取字符串字段 */
export function pick(ctx: RequestContext, key: string): string | undefined {
  const fromQuery = ctx.query.get(key)
  if (fromQuery && fromQuery.length > 0) return fromQuery
  const body = ctx.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const value = (body as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 取目标名；缺失返回 undefined 由调用方给出 USAGE */
export function pickTargetName(ctx: RequestContext): string | undefined {
  return pick(ctx, 'target') ?? pick(ctx, 'name')
}

/** git log 默认与最大条数 */
const DEFAULT_LOG_LIMIT = 20
const MAX_LOG_LIMIT = 5000

const noTarget = (name: string): Envelope =>
  errEnvelope('NO_TARGET', `目标不存在：${name}`, '请用 shipit targets list 查看可用目标')

const usage = (message: string): Envelope => errEnvelope('USAGE', message)

/**
 * 目标清单处理器：`GET /targets`（可选 `?name=`）。
 * 列表返回摘要，带名称时返回详情；两种情况都不含凭据（AC-001 / AC-002）。
 */
export function targetsHandler(deps: ServerHandlerDeps): RouteHandler {
  return async (ctx) => {
    const targets = await deps.loadTargets()
    const name = pickTargetName(ctx)

    if (!name) {
      const data = targets.map(toTargetSummary)
      return okEnvelope(data, metaOf({ origin: ctx.origin, count: data.length }))
    }

    const target = targets.find((t) => t.name === name)
    if (!target) return noTarget(name)
    return okEnvelope(toTargetDetail(target), metaOf({ origin: ctx.origin, target: name, count: 1 }))
  }
}

/**
 * 连接校验处理器：`POST /test-connection?target=`。
 * 复用既有 `testConnection`，失败映射为连接类错误（AC-003 / AC-004）。
 */
export function testConnectionHandler(deps: ServerHandlerDeps): RouteHandler {
  return async (ctx) => {
    const name = pickTargetName(ctx)
    if (!name) return usage('缺少目标名：test-connection 需要目标名')

    const targets = await deps.loadTargets()
    const target = targets.find((t) => t.name === name)
    if (!target) return noTarget(name)

    const result = await deps.testConnection(target)
    if (!result.success) {
      const code: ErrorCode = 'CONNECT_FAILED'
      return errEnvelope(code, `连接失败：${result.error ?? '未知原因'}`, '请检查主机、端口与凭据')
    }
    return okEnvelope(
      { reachable: true, protocol: target.protocol, host: target.host, port: target.port },
      metaOf({ origin: ctx.origin, target: name })
    )
  }
}

/** 取 body 中的原始值（query 优先，其次 JSON body） */
export function pickRaw(ctx: RequestContext, key: string): unknown {
  const fromQuery = ctx.query.get(key)
  if (fromQuery !== null && fromQuery.length > 0) return fromQuery
  const body = ctx.body
  if (body && typeof body === 'object' && !Array.isArray(body)) return (body as Record<string, unknown>)[key]
  return undefined
}

/**
 * 取字符串数组参数：接受 JSON body 里的数组，也接受 query / body 里的逗号分隔字符串；未提供返回 null。
 */
export function pickList(ctx: RequestContext, key: string): string[] | null {
  const raw = pickRaw(ctx, key)
  if (raw === undefined || raw === null) return null
  if (Array.isArray(raw)) {
    const items = raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
    return items.filter((item) => item.length > 0)
  }
  if (typeof raw === 'string') {
    const items = raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    return items.length > 0 ? items : null
  }
  return null
}

/** 取布尔参数：兼容 GET query 的字符串形式（'true' / '1'） */
export function pickBool(ctx: RequestContext, key: string): boolean {
  const raw = pickRaw(ctx, key)
  return raw === true || raw === 'true' || raw === 1 || raw === '1'
}

/**
 * 解析选择器。
 * - 未提供（undefined/null）→ `{ kind: 'absent' }`，由服务端按「当前变更」缺省处理
 * - 提供了但非法（未知 kind、缺路径、空文件集合）→ `{ kind: 'invalid' }`，必须报用法错误
 *
 * 绝不把非法输入降级成缺省值：那会把调用方限定的范围悄悄放大成「全部变更」，
 * 对一个会覆盖远端文件的工具是危险的（spec：枚举非法 → USAGE；选择器缺省不推断）。
 */
type SelectorParse =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; selector: Selector }

function parseSelector(value: unknown): SelectorParse {
  if (value === undefined || value === null || value === '') return { kind: 'absent' }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'selector 必须是对象' }
  }
  const raw = value as Record<string, unknown>
  switch (raw.kind) {
    case 'all-changed':
      return { kind: 'ok', selector: { kind: 'all-changed' } }
    case 'last-commit':
      return { kind: 'ok', selector: { kind: 'last-commit' } }
    case 'dir': {
      const path = typeof raw.path === 'string' ? raw.path.trim() : ''
      if (!path) return { kind: 'invalid', reason: 'selector.kind=dir 需要非空 path' }
      return { kind: 'ok', selector: { kind: 'dir', path } }
    }
    case 'files': {
      const paths = Array.isArray(raw.paths)
        ? raw.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : []
      if (paths.length === 0) return { kind: 'invalid', reason: 'selector.kind=files 需要非空 paths' }
      return { kind: 'ok', selector: { kind: 'files', paths } }
    }
    default:
      return { kind: 'invalid', reason: `未知选择器类型：${String(raw.kind)}` }
  }
}

/** 解析选择器并统一处理非法输入（合法/缺省时返回 selector） */
function resolveSelectorOrError(
  ctx: RequestContext
): { ok: true; selector: Selector | null } | { ok: false; envelope: Envelope } {
  const parsed = parseSelector(pickRaw(ctx, 'selector'))
  if (parsed.kind === 'invalid') {
    return {
      ok: false,
      envelope: usage(
        `选择器非法：${parsed.reason}（--all-changed / --files <路径> / --dir <目录> / --last-commit 四选一）`
      )
    }
  }
  return { ok: true, selector: parsed.kind === 'ok' ? parsed.selector : null }
}

/**
 * 预先算出「选中但不存在」的文件集合（需要文件系统信息，故在处理器里算一次）。
 * 用于把跳过原因区分为 missing / no-mapping，以及给出如实的空集合文案。
 */
/**
 * 存在性检查的并发上限。
 *
 * 无上限 `Promise.all` 在大目录（数万文件）下会瞬间打满 fd 配额并饿死事件循环
 * （EMFILE），服务端是常驻进程，这类自伤会波及界面与其他调用方。
 */
const EXISTS_CONCURRENCY = 32

async function missingPaths(files: string[], exists?: (abs: string) => Promise<boolean>): Promise<Set<string>> {
  const missing = new Set<string>()
  if (!exists) return missing
  // 分批并发：批间串行，批内并行
  for (let i = 0; i < files.length; i += EXISTS_CONCURRENCY) {
    const batch = files.slice(i, i + EXISTS_CONCURRENCY)
    await Promise.all(
      batch.map(async (file) => {
        if (!(await exists(file))) missing.add(file)
      })
    )
  }
  return missing
}

/** 空上传集合的文案：区分「文件不存在」与「未命中映射」（排障方向完全不同） */
function describeEmptySelection(total: number, missingCount: number): string {
  const noMappingCount = total - missingCount
  if (missingCount > 0 && noMappingCount > 0) {
    return `${missingCount} 个文件不存在（已删除或未提交），${noMappingCount} 个未命中目录映射`
  }
  if (missingCount > 0) return `${missingCount} 个文件不存在（已删除或未提交）`
  return '选中的文件均未命中目录映射'
}

/**
 * 计划处理器：`POST /plan`。
 * 只做项目策略校验 + 选择器解析 + 映射匹配，不建立远端连接（INV-1 / AC-005）。
 */
export function planHandler(deps: ServerHandlerDeps): RouteHandler {
  return async (ctx) => {
    const name = pickTargetName(ctx)
    if (!name) return usage('缺少目标名：plan 需要 --target')

    // 策略 D′：项目根必填（不接受"跟随桌面焦点"——多窗口下会漂移，可能把别的项目当成本次项目）
    const resolved = deps.resolveProject({ project: pick(ctx, 'projectRoot') ?? pick(ctx, 'project') })
    if (!resolved.ok) return errEnvelope(resolved.error.code, resolved.error.message, resolved.error.hint)
    const { projectRoot } = resolved.project

    const targets = await deps.loadTargets()
    const target = targets.find((t) => t.name === name)
    if (!target) return noTarget(name)

    const parsedSelector = resolveSelectorOrError(ctx)
    if (!parsedSelector.ok) return parsedSelector.envelope

    const selection = await resolveSelection(parsedSelector.selector, projectRoot, deps.selection)
    if (!selection.ok) return errEnvelope(selection.code, selection.message, selection.hint)

    const tasks = await deps.buildUploadTasks(selection.files, projectRoot, target)
    const missing = await missingPaths(selection.files, deps.selection.exists)
    const plan: DeployPlan = {
      projectRoot,
      target: name,
      items: toPlanItems(tasks, target),
      skipped: toPlanSkips(selection.files, tasks, projectRoot, missing)
    }
    if (plan.items.length === 0) {
      // 与 deploy 口径一致：没有可上传文件就不算「计划成功」（否则 plan 说 ok、deploy 说 EMPTY_SELECTION，
      // 调用方会以为只是「这次没东西传」）。明细放进 data，CLI 仍会逐条打印跳过原因。
      return errEnvelope(
        'EMPTY_SELECTION',
        `没有可上传的文件：${describeEmptySelection(selection.files.length, missing.size)}`,
        '请检查目标的目录映射配置，并确认文件仍在项目内',
        plan
      )
    }
    return okEnvelope(
      plan,
      metaOf({
        origin: ctx.origin,
        target: name,
        count: plan.items.length,
        projectRoot,
        extra: { skippedCount: plan.skipped.length }
      })
    )
  }
}

/**
 * 上传处理器：`POST /deploy`。
 * 默认异步：提交即返回 taskId 与队列位置（不阻塞）；是否等待由前端轮询控制（D-18 / AC-032）。
 * 项目策略、目标与选择器校验与 plan 完全一致（同一实现，DFX-REUSE-001）。
 */
export function deployHandler(deps: ServerHandlerDeps): RouteHandler {
  return async (ctx) => {
    const name = pickTargetName(ctx)
    if (!name) return usage('缺少目标名：deploy 需要 --target')

    // 策略 D′：项目根必填（见 plan 处的说明）
    const resolved = deps.resolveProject({ project: pick(ctx, 'projectRoot') ?? pick(ctx, 'project') })
    if (!resolved.ok) return errEnvelope(resolved.error.code, resolved.error.message, resolved.error.hint)
    const { projectRoot } = resolved.project

    const targets = await deps.loadTargets()
    const target = targets.find((t) => t.name === name)
    if (!target) return noTarget(name)

    const parsedSelector = resolveSelectorOrError(ctx)
    if (!parsedSelector.ok) return parsedSelector.envelope

    const selection = await resolveSelection(parsedSelector.selector, projectRoot, deps.selection)
    if (!selection.ok) return errEnvelope(selection.code, selection.message, selection.hint)

    const tasks = await deps.buildUploadTasks(selection.files, projectRoot, target)
    if (tasks.length === 0) {
      // 如实说明原因：「都没命中映射」与「文件根本不存在」是两种完全不同的排障方向
      const missing = await missingPaths(selection.files, deps.selection.exists)
      return errEnvelope(
        'EMPTY_SELECTION',
        `没有可上传的文件：${describeEmptySelection(selection.files.length, missing.size)}`,
        '请检查目标的目录映射配置，并确认文件仍在项目内'
      )
    }

    // 计划与提交之间文件可能变化：调用方给出 expectFiles 时按集合比对，不一致就拒绝提交
    // （桌面端有确认清单，CLI / MCP 此前没有，只能靠调用方自觉；静默换集合可能覆盖远端不该动的文件）。
    const actualFiles = tasks.map((task) => toSlashes(task.relativePath))
    const expectedFiles = pickList(ctx, 'expectFiles')
    if (expectedFiles) {
      const actual = [...actualFiles].sort()
      const want = [...new Set(expectedFiles.map((path) => toSlashes(path)))].sort()
      const drift = want.length !== actual.length || want.some((path, index) => path !== actual[index])
      if (drift) {
        return errEnvelope(
          'PLAN_STALE',
          `计划已过期：当前将上传的文件集合与 expectFiles 不一致（期望 ${want.length} 个，实际 ${actual.length} 个）`,
          '请重新执行 plan 确认后再 deploy（文件可能在计划之后被修改/删除/新增）',
          { expected: want, actual }
        )
      }
    }

    let submitted: SubmitResult
    try {
      submitted = deps.queue.submit({
        origin: ctx.origin,
        client: ctx.origin === 'desktop' ? undefined : ctx.origin,
        remoteAddress: ctx.remoteAddress,
        target: name,
        projectRoot,
        totalFiles: tasks.length,
        job: (jobCtx) => deps.deploy(tasks, target, jobCtx.onProgress, jobCtx)
      })
    } catch (error) {
      // 队列拒绝（如积压达上限的 QUEUE_FULL）：按信封如实上报，不当成服务端故障
      if (error instanceof QueueError) {
        return errEnvelope(error.code, error.message, '队列积压时请等待既有任务完成（shipit task / 桌面状态栏可查看）')
      }
      throw error
    }

    const record = deps.queue.get(submitted.taskId)
    const data: TaskSubmitResult = {
      taskId: submitted.taskId,
      position: submitted.position,
      state: record?.state ?? 'queued',
      createdAt: record?.createdAt ?? Date.now(),
      totalFiles: tasks.length,
      target: name,
      projectRoot,
      files: actualFiles
    }
    return okEnvelope(
      data,
      metaOf({
        origin: ctx.origin,
        target: name,
        count: tasks.length,
        projectRoot,
        extra: { queuePending: deps.queue.snapshot().pendingCount }
      })
    )
  }
}

/**
 * 项目列表：`GET /projects`。
 *
 * 策略 D′ 下项目根必填，因此调用方（CLI / MCP / agent）需要能发现"桌面现在开着哪些项目"。
 * 返回路径、名称、窗口 ID 与是否聚焦（聚焦项仅作提示，不作为默认项目）。
 */
export function projectsHandler(deps: ServerHandlerDeps): RouteHandler {
  return async (ctx) => {
    const projects = await deps.listProjects()
    const scope = deps.projectScope()
    return okEnvelope(
      {
        projects,
        // 作用域只对局域网绑定生效（本机回环不限制）；allowedRoots 为空表示"只能操作已打开项目"
        scope: { enforced: scope.enforce, allowedRoots: scope.allowedRoots }
      },
      // 来源按实际调用方标注：CLI/MCP 调 /projects 时不能一律回 desktop（AC-037 可追溯性）
      metaOf({ origin: ctx.origin, count: projects.length })
    )
  }
}

/** 状态与版本处理器：`GET /status`（AC-015 / AC-023 / AC-034） */
export function statusHandler(
  deps: ServerHandlerDeps,
  runtime: () => { listening: boolean; port: number | null; bound: string }
): RouteHandler {
  return async (ctx) => {
    const snapshot = deps.queue.snapshot()
    const live = runtime()
    const sessions = deps.activeSessions()
    // 仅展示用：桌面最近聚焦的项目（策略 D′ 下不再作为执行路径的默认项目）
    const focused = deps.projectContext.currentProject()
    return okEnvelope(
      {
        listening: live.listening,
        port: live.port,
        bound: live.bound,
        version: deps.getVersion(),
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        currentProject: focused,
        // 桌面直连会话（owner=desktop）：队列快照看不到它们，但确实在传
        activeSessions: sessions,
        projects: await deps.listProjects(),
        projectScope: { enforced: deps.projectScope().enforce, allowedRoots: deps.projectScope().allowedRoots },
        queue: snapshot
      },
      metaOf({
        origin: ctx.origin,
        count: snapshot.tasks.length,
        extra: { pendingCount: snapshot.pendingCount, runningTaskId: snapshot.runningTaskId }
      })
    )
  }
}

/** 任务查询处理器：`GET /tasks/:id`（AC-034 / AC-035） */
export function taskHandler(deps: ServerHandlerDeps): RouteHandler {
  return async (ctx) => {
    const taskId = ctx.params.id
    const record = deps.queue.get(taskId)
    if (!record) {
      return errEnvelope('UNKNOWN_TASK', `未知任务：${taskId}`, '任务状态仅保留在内存中，桌面版重启后不可查')
    }
    // 任务详情包含逐文件明细（result.details）与进度；判定语义由前端按终态处理
    return okEnvelope(record, metaOf({ origin: ctx.origin, count: record.totalFiles, extra: { state: record.state } }))
  }
}

const notARepo = (projectRoot: string): Envelope =>
  errEnvelope('NOT_A_REPO', `目录不是 Git 仓库：${projectRoot}`, '请在 Git 仓库内使用该命令，或改用 --files 指定文件')

/** 解析项目上下文并确认是 Git 仓库（查询类接口共用） */
async function requireGitRepo(
  deps: ServerHandlerDeps,
  ctx: RequestContext
): Promise<{ ok: true; projectRoot: string } | { ok: false; envelope: Envelope }> {
  // 策略 D′：Git 只读查询同样要求显式项目根
  const resolved = deps.resolveProject({ project: pick(ctx, 'projectRoot') ?? pick(ctx, 'project') })
  if (!resolved.ok) {
    return { ok: false, envelope: errEnvelope(resolved.error.code, resolved.error.message, resolved.error.hint) }
  }
  const { projectRoot } = resolved.project
  let isRepo: boolean
  try {
    isRepo = await deps.git.isGitRepo(projectRoot)
  } catch (error) {
    // git 本身不可用（未安装 / dubious ownership / 超时）：环境类错误 + 指向 git 可用性的提示，
    // 不要报成 NOT_A_REPO（那会把排障引向"目录不对"的错误方向）。
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      envelope: errEnvelope('BACKEND_UNAVAILABLE', `git 不可用：${message}`, '请确认本机已安装 git 且当前用户可读取该项目（含 safe.directory 配置）')
    }
  }
  if (!isRepo) {
    return { ok: false, envelope: notARepo(projectRoot) }
  }
  return { ok: true, projectRoot }
}

/** 变更清单：`GET /git/status`（AC-009 / AC-010 / AC-012） */
export function gitStatusHandler(deps: ServerHandlerDeps): RouteHandler {
  return async (ctx) => {
    const resolved = await requireGitRepo(deps, ctx)
    if (!resolved.ok) return resolved.envelope

    const view = await deps.git.getStatusView(resolved.projectRoot)
    // getStatusView 内部吞掉异常并返回 hasGit:false；必须据此报错，
    // 否则「目录在两次调用之间不可读」会返回空清单冒充成功（AC-010）
    if (!view.hasGit) return notARepo(resolved.projectRoot)

    const changes = view.changes.map((c) => ({
      relativePath: toSlashes(c.relativePath),
      status: c.status
    }))
    return okEnvelope(
      {
        projectRoot: resolved.projectRoot,
        branch: view.branch ?? null,
        ahead: view.ahead,
        behind: view.behind,
        changes
      },
      metaOf({
        origin: ctx.origin,
        count: changes.length,
        projectRoot: resolved.projectRoot,
      })
    )
  }
}

/** 提交历史：`GET /git/log`（AC-011 / AC-012） */
export function gitLogHandler(deps: ServerHandlerDeps): RouteHandler {
  return async (ctx) => {
    const resolved = await requireGitRepo(deps, ctx)
    if (!resolved.ok) return resolved.envelope

    const limitRaw = pick(ctx, 'limit')
    let maxCount = DEFAULT_LOG_LIMIT
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) <= 0) {
        return usage(`参数 limit 需为正整数，收到：${limitRaw}`)
      }
      maxCount = Number(limitRaw)
      if (maxCount > MAX_LOG_LIMIT) {
        return usage(`参数 limit 超出上限（最大 ${MAX_LOG_LIMIT}），收到：${limitRaw}`)
      }
    }

    // 分支名必须通过白名单（P0：此前裸拼进 git argv，`--output=<path>` 之类可写/截断任意文件）
    const branch = pick(ctx, 'branch')
    if (branch !== undefined && branch !== '__all__' && !isSafeGitRev(branch)) {
      return usage('参数 branch 不是合法的分支名（只允许字母数字与 . _ / @ ^ ~ - { }，且不以 - 开头）')
    }
    const author = pick(ctx, 'author')
    if (author !== undefined && /[\r\n\u0000]/.test(author)) {
      return usage('参数 author 含非法字符（不得包含换行或空字符）')
    }

    let commits
    try {
      commits = await deps.git.getLogView(resolved.projectRoot, { branch, author, maxCount })
    } catch (error) {
      // 非法 rev 在服务层是抛错而非"空列表"：如实转成用法错误，不伪装成"没有提交"
      return usage(error instanceof Error ? error.message : 'git 查询参数非法')
    }
    return okEnvelope(
      { projectRoot: resolved.projectRoot, commits },
      metaOf({
        origin: ctx.origin,
        count: commits.length,
        projectRoot: resolved.projectRoot,
      })
    )
  }
}

/** 分支清单：`GET /git/branches`（AC-011 / AC-012） */
export function gitBranchesHandler(deps: ServerHandlerDeps): RouteHandler {
  return async (ctx) => {
    const resolved = await requireGitRepo(deps, ctx)
    if (!resolved.ok) return resolved.envelope

    const branches = await deps.git.getBranches(resolved.projectRoot)
    return okEnvelope(
      { projectRoot: resolved.projectRoot, branches },
      metaOf({
        origin: ctx.origin,
        count: branches.length,
        projectRoot: resolved.projectRoot,
      })
    )
  }
}

/** 组装服务端处理器（未实现的接口保持未绑定，由服务端返回「接口未启用」） */
export function createServerHandlers(
  deps: ServerHandlerDeps,
  runtime: () => { listening: boolean; port: number | null; bound: string } = () => ({
    listening: false,
    port: null,
    bound: ''
  })
): Partial<Handlers> {
  return {
    targets: targetsHandler(deps),
    projects: projectsHandler(deps),
    testConnection: testConnectionHandler(deps),
    plan: planHandler(deps),
    deploy: deployHandler(deps),
    status: statusHandler(deps, runtime),
    task: taskHandler(deps),
    gitStatus: gitStatusHandler(deps),
    gitLog: gitLogHandler(deps),
    gitBranches: gitBranchesHandler(deps)
  }
}
