/**
 * deploy / status / task 命令（任务 11）。
 *
 * - `deploy` 默认异步：提交即返回 taskId 与队列位置（AC-032）。
 * - `--wait` 由前端轮询到终态：返回逐文件明细与汇总，部分失败退出码 2（AC-033 / AC-036）。
 * - `status` 返回服务端状态、版本与队列快照（AC-015 / AC-034）。
 * - `task <任务ID>` 查询单个任务，未知任务返回 UNKNOWN_TASK（AC-035）。
 */
import type { Envelope } from '../../shared/cli-contract'
import { correctTaskEnvelope } from '../../shared/task-verdict'
import type { TaskSubmitResult } from '../../shared/types'
import { toEnvelope } from '../client'
import { registerCommand, type CommandContext } from '../registry'
import { waitForTask } from '../task-wait'
import { projectPayload, requireProject } from './plan'

/** 提交上传任务；--wait 时轮询到终态 */
async function deployCommand(ctx: CommandContext): Promise<Envelope> {
  const { args, client } = ctx
  const missing = requireProject(args)
  if (missing) return missing
  const submitted = await client.post('/deploy', {
    target: args.target,
    selector: args.selector,
    // 给了 expectFiles 时由服务端比对：不一致直接拒绝提交（不静默换集合）
    ...(args.expectFiles ? { expectFiles: args.expectFiles } : {}),
    ...projectPayload(args)
  })
  const envelope = toEnvelope(submitted)
  if (!envelope.ok || !args.wait) return envelope

  const taskId = (envelope.data as TaskSubmitResult).taskId
  return waitForTask(client, taskId, { timeoutSeconds: args.waitTimeoutSeconds })
}

/** 服务端状态与版本 */
async function statusCommand(ctx: CommandContext): Promise<Envelope> {
  return toEnvelope(await ctx.client.get('/status'))
}

/**
 * 任务查询。
 * 终态判定与 `--wait` 走同一套（被取消但 state=succeeded 的任务必须报 PARTIAL，INV-9）。
 */
async function taskCommand(ctx: CommandContext): Promise<Envelope> {
  const taskId = ctx.args.positionals[0]
  const envelope = toEnvelope(await ctx.client.get(`/tasks/${encodeURIComponent(taskId)}`))
  return correctTaskEnvelope(envelope)
}

registerCommand('deploy', deployCommand)
registerCommand('status', statusCommand)
registerCommand('task', taskCommand)
