/**
 * plan 命令（FR-003）。
 *
 * 只把目标、选择器与项目上下文交给服务端计算；计划阶段不建立远端连接（INV-1）。
 */
import { errEnvelope, type Envelope, type OkEnvelope } from '../../shared/cli-contract'
import { toEnvelope } from '../client'
import { registerCommand, type CommandContext } from '../registry'

/**
 * 项目相关请求体（兼容契约 CON-1）。
 *
 * 策略 D′：项目根**必填**（CLI 侧由 `requireProject` 提前拦截；服务端同样校验）。
 * 项目根缺失时也照原样发出，让服务端给出统一口径的 USAGE（避免两处各写一套文案）。
 */
export function projectPayload(args: CommandContext['args']): { projectRoot?: string } {
  return { ...(args.project ? { projectRoot: args.project } : {}) }
}

/**
 * 项目必填校验（CLI 侧快速失败）：缺失时返回可直接输出的用法错误信封。
 *
 * 服务端也有同样的校验（MCP / HTTP 的权威边界），这里拦住是为了：
 * 1）不必先发现连接、再被服务端拒绝；2）错误提示就地带出 `projects list` 引导。
 */
export function requireProject(args: CommandContext['args']): Envelope | null {
  if (args.project && args.project.trim().length > 0) return null
  return errEnvelope(
    'USAGE',
    `命令 ${args.command === 'git' ? `git ${args.action}` : args.command} 需要 --project <项目根>`,
    '可用 `shipit projects list` 查看桌面当前已打开的项目'
  )
}

async function planCommand(ctx: CommandContext): Promise<Envelope> {
  const { args, client } = ctx
  const missing = requireProject(args)
  if (missing) return missing
  const body = {
    target: args.target,
    selector: args.selector,
    ...projectPayload(args)
  }
  return toEnvelope(await client.post('/plan', body))
}

/** `/plan` 的 data 形状（服务端 `planHandler`） */
interface PlanPayload {
  projectRoot?: string
  target?: string
  items?: Array<{ relativePath?: string; size?: number; remotePath?: string }>
  skipped?: Array<{ relativePath?: string; reason?: string }>
}

/**
 * `plan` 的人类可读输出：**先给数量**（待上传 / 跳过 / 总计），再逐条列文件。
 *
 * 数量放在最前面是刻意的：计划的首要信息是"这次要传多少"，逐条清单只是佐证。
 */
export function renderPlanText(env: OkEnvelope): string {
  const data = (env.data ?? {}) as PlanPayload
  const items = Array.isArray(data.items) ? data.items : []
  const skipped = Array.isArray(data.skipped) ? data.skipped : []
  const totalBytes = items.reduce((sum, it) => sum + (typeof it?.size === 'number' ? it.size : 0), 0)
  const sizeText = totalBytes > 0 ? `，共 ${formatBytes(totalBytes)}` : ''
  const lines = [
    `${data.projectRoot ?? '(未知项目)'} → ${data.target ?? '(未知目标)'}`,
    `待上传 ${items.length} 个文件${sizeText}${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`
  ]
  for (const item of items) lines.push(`  ${item?.relativePath ?? ''}`)
  for (const skip of skipped) lines.push(`  跳过 ${skip?.relativePath ?? ''}（${skip?.reason ?? ''}）`)
  return lines.join('\n')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

registerCommand('plan', planCommand, renderPlanText)
