/**
 * git 只读查询命令（FR-005 / FR-006）。
 *
 * 查询由服务端执行（INV-2），前端只传项目上下文与筛选条件；不做任何写操作。
 */
import type { Envelope, OkEnvelope } from '../../shared/cli-contract'
import type { GitChangeInfo } from '../../shared/types'
import { toEnvelope } from '../client'
import { registerCommand, type CommandContext } from '../registry'
import { displayWidth, padEndDisplay } from '../text'
import { projectPayload, requireProject } from './plan'

/** `shipit git status` */
async function gitStatusCommand(ctx: CommandContext): Promise<Envelope> {
  const missing = requireProject(ctx.args)
  if (missing) return missing
  return toEnvelope(await ctx.client.get('/git/status', projectPayload(ctx.args)))
}

/**
 * 变更类型 → 简要标记（与桌面端「Git 未提交的变更」视图同一套词表）。
 * 取值集合见 `shared/types.ts` 的 `GitChangeInfo['status']`（铁律 1）。
 */
const CHANGE_MARKER: Record<GitChangeInfo['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: '?',
  renamed: 'R'
}

/** 路径列最大对齐宽度（超长路径不截断，只是标记不再右对齐） */
const MAX_PATH_PAD = 60

/** `/git/status` 的 data 形状（服务端 `gitStatusHandler`；字段为兼容契约） */
interface GitStatusPayload {
  branch?: string | null
  ahead?: number
  behind?: number
  changes?: Array<{ relativePath?: string; status?: string }>
}

/**
 * `git status` 的人类可读输出：变更文件按**文件列表**逐行列出，
 * 文件名后跟简要标记（M 修改 / A 新增 / D 删除 / ? 未跟踪 / R 重命名）。
 *
 * 例：
 *   main · 2 个未提交变更
 *   src/a.ts     M
 *   dist/b.js    A
 *
 * 结构化字段仍以 `--json` 的信封为准（本渲染器只影响默认文本通道）。
 */
export function renderGitStatusText(env: OkEnvelope): string {
  const data = (env.data ?? {}) as GitStatusPayload
  const changes = Array.isArray(data.changes) ? data.changes : []

  const tracking: string[] = []
  if (data.ahead) tracking.push(`领先 ${data.ahead}`)
  if (data.behind) tracking.push(`落后 ${data.behind}`)
  const head = [data.branch ?? '(未知分支)', tracking.length ? `(${tracking.join(', ')})` : '']
    .filter(Boolean)
    .join(' ')
  const summary = changes.length === 0 ? '无未提交变更' : `${changes.length} 个未提交变更`
  const lines = [`${head} · ${summary}`]

  const rows = changes.map((change) => {
    const path = String(change?.relativePath ?? '')
    const status = String(change?.status ?? '')
    // 未知取值不猜标记，原样呈现（与桌面端同一兜底口径）
    const marker = CHANGE_MARKER[status as GitChangeInfo['status']] ?? status
    return [path, marker] as const
  })

  // 状态标记**紧跟文件名**（中间固定两个空格）：不做列对齐 ——
  // 对齐会让短文件名与标记之间出现一大段空白，反而不好读（用户明确要求紧跟）。
  for (const [path, marker] of rows) lines.push(`${path}  ${marker}`)
  return lines.join('\n')
}

/** `/git/log` 的 data 形状（服务端 `gitLogHandler`） */
interface GitLogPayload {
  projectRoot?: string
  commits?: Array<{ hash?: string; date?: string; author?: string; message?: string }>
}

/**
 * `git log` 的人类可读输出：**带序号**的提交列表（最近优先）。
 *
 * 例：
 *   1. 7ed9876  2026/10/13  heyuncheng  feat: fix
 *   2. …
 */
export function renderGitLogText(env: OkEnvelope): string {
  const data = (env.data ?? {}) as GitLogPayload
  const commits = Array.isArray(data.commits) ? data.commits : []
  const lines = [commits.length === 0 ? '无提交记录' : `${commits.length} 条提交（最近优先）`]
  commits.forEach((commit, index) => {
    const no = String(index + 1).padStart(2, ' ')
    const hash = String(commit?.hash ?? '').padEnd(7, ' ')
    const date = String(commit?.date ?? '').slice(0, 10)
    const author = String(commit?.author ?? '')
    const message = String(commit?.message ?? '')
    lines.push(`${no}. ${hash}  ${date}  ${author}  ${message}`)
  })
  return lines.join('\n')
}

/** `shipit git log [--branch <分支>] [--author <提交者>] [--limit <条数>]` */
async function gitLogCommand(ctx: CommandContext): Promise<Envelope> {
  const missing = requireProject(ctx.args)
  if (missing) return missing
  const { args } = ctx
  return toEnvelope(
    await ctx.client.get('/git/log', {
      ...projectPayload(args),
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.author ? { author: args.author } : {}),
      ...(args.limit !== null ? { limit: args.limit } : {})
    })
  )
}

registerCommand('git status', gitStatusCommand, renderGitStatusText)
registerCommand('git log', gitLogCommand, renderGitLogText)

