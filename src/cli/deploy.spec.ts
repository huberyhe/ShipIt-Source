/**
 * deploy / status / task 命令级用例（任务 11）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectContext } from '../main/services/project-context'
import { createServerHandlers } from '../main/services/server-handlers'
import { createQueue, type DeployQueue } from '../main/services/deploy-queue'
import type { DeployResult, DeployTarget, UploadTask } from '../shared/types'
import { verdictOf } from '../shared/task-verdict'
import { startHarness, type Harness } from './testing/harness'
import { notUsedDep } from './testing/deps'

const PROJECT = 'D:/work/app'

const target: DeployTarget = {
  id: 't1',
  name: 'my_dev',
  protocol: 'local',
  host: 'D:/deploy-target',
  port: 0,
  username: 'local',
  mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/opt/app/dist' }]
}

interface BootOptions {
  /** 桌面当前项目；null 表示桌面未打开项目 */
  currentProject?: string | null
  partial?: boolean
  slowMs?: number
  connectError?: string
  changedFiles?: string[]
  /** 确定性门控：open 之前上传不结束（用于断言「运行中 / 排队中」这类瞬时状态） */
  gate?: { promise: Promise<void> }
}

/** 创建确定性门控 */
function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

let harness: Harness | null = null
let queue: DeployQueue | null = null

async function boot(options: BootOptions = {}): Promise<Harness> {
  const context = new ProjectContext('win32')
  context.setCurrent(options.currentProject === undefined ? PROJECT : options.currentProject)
  const liveQueue = createQueue()
  queue = liveQueue

  const buildUploadTasks = async (files: string[], projectRoot: string, t: DeployTarget): Promise<UploadTask[]> =>
    files
      .filter((f) => f.replace(/\\/g, '/').includes('/dist/'))
      .map((f) => ({
        localPath: f,
        remotePath: `/opt/app/dist/${f.replace(/\\/g, '/').split('/').pop()}`,
        relativePath: f.replace(/\\/g, '/').replace(`${projectRoot}/`, ''),
        size: 10
      }))

  const deploy = async (
    tasks: UploadTask[],
    t: DeployTarget,
    onProgress: (current: number, total: number, file: string) => void
  ): Promise<DeployResult> => {
    if (options.connectError) throw new Error(options.connectError)
    if (options.gate) await options.gate.promise // 门未开则一直处于「上传中」
    const result: DeployResult = {
      taskId: 'x',
      targetName: t.name,
      timestamp: 1,
      totalFiles: tasks.length,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      duration: 1,
      details: []
    }
    for (let i = 0; i < tasks.length; i++) {
      if (options.slowMs) await new Promise((r) => setTimeout(r, options.slowMs))
      onProgress(i + 1, tasks.length, tasks[i].relativePath)
      const fail = options.partial && i === tasks.length - 1
      if (fail) result.failed++
      else result.succeeded++
      result.details.push({
        relativePath: tasks[i].relativePath,
        remotePath: tasks[i].remotePath,
        status: fail ? 'failed' : 'success',
        ...(fail ? { error: '权限不足' } : {})
      })
    }
    return result
  }

  const handlers = (rt: () => { listening: boolean; port: number | null; bound: string }) =>
    createServerHandlers(
      {
        loadTargets: async () => [target],
        testConnection: async () => ({ success: true }),
        resolveProject: (input) => context.resolve(input),
        projectContext: { currentProject: () => context.getCurrent() },
        listProjects: async () => {
        
        
          const current = context.getCurrent()
          return current ? [{ path: current, name: 'app', windowId: 1, focused: true }] : []
        },
        projectScope: () => ({ enforce: false, allowedRoots: [] }),
        activeSessions: () => [],
        selection: {
          isGitRepo: async () => true,
          listChangedFiles: async () => options.changedFiles ?? ['dist/a.js', 'dist/b.css'],
          listCommitFiles: async () => ['dist/a.js'],
          listFilesInDir: async () => [`${PROJECT}/dist/a.js`]
        },
        buildUploadTasks,
        // 闭包内引用已收窄的非空实例：外层 `queue` 会在 afterEach 里被置空，闭包中看不到收窄
        queue: liveQueue,
        getVersion: () => '1.0.3',
        // 本组用例不涉 Git 路由：桩成抛错，若被调用立即暴露
        git: {
          isGitRepo: () => notUsedDep('git.isGitRepo'),
          getStatusView: () => notUsedDep('git.getStatusView'),
          getLogView: () => notUsedDep('git.getLogView'),
          getBranches: () => notUsedDep('git.getBranches')
        },
        deploy
      },
      rt
    )

  harness = await startHarness(handlers)
  return harness
}

afterEach(async () => {
  if (queue) await queue.drain()
  if (harness) await harness.stop()
  harness = null
  queue = null
})

describe('deploy', () => {
  it('AC-032 默认异步：输出含 taskId 且退出码 0', async () => {
    const h = await boot()
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.taskId).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.json.data).toMatchObject({ position: 1, totalFiles: 2, target: 'my_dev', projectRoot: PROJECT })
  })

  it('AC-037 任务记录来源标注为 cli（由前端声明，不猜测）', async () => {
    const h = await boot()
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--json'])
    const task = await h.run(['task', out.json.data.taskId, '--json'])
    expect(task.json.data.origin).toBe('cli')
    expect(task.json.data.client).toBe('cli')
  })

  it('AC-032 提交后立即退出，任务在服务端继续执行', async () => {
    // 用门控代替时间窗：门未开时任务不可能结束，因此「CLI 已返回但任务仍 running」是确定性判据
    const gate = deferred()
    const h = await boot({ gate })
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--json'])

    expect(out.exitCode).toBe(0)
    expect(out.json.data.taskId).toMatch(/^[0-9a-f-]{36}$/)
    expect(queue!.get(out.json.data.taskId)!.state).toBe('running') // 未等待完成

    gate.open()
    await queue!.drain()
    expect(queue!.get(out.json.data.taskId)!.state).toBe('succeeded')
  })

  it('AC-007 --wait 返回逐文件状态与汇总计数，总数等于计划项数量', async () => {
    const h = await boot()
    const plan = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--json'])
    const planned = plan.json.data.items.length

    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--wait', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.summary.totalFiles).toBe(planned)
    expect(out.json.data.details).toHaveLength(planned)
    // 汇总与明细一致
    const succeeded = out.json.data.details.filter((d: { status: string }) => d.status === 'success').length
    const failed = out.json.data.details.filter((d: { status: string }) => d.status === 'failed').length
    expect(out.json.data.summary.succeeded).toBe(succeeded)
    expect(out.json.data.summary.failed).toBe(failed)
    expect(succeeded + failed).toBe(planned)
  })

  it('AC-033 --wait 返回逐文件明细与汇总', async () => {
    const h = await boot()
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--wait', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.summary).toMatchObject({ totalFiles: 2, succeeded: 2, failed: 0 })
    expect(out.json.data.details).toHaveLength(2)
  })

  it('AC-033 / INV-9 部分失败返回 PARTIAL 与退出码 2，且带失败明细（不做远端回滚）', async () => {
    const h = await boot({ partial: true })
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--wait', '--json'])
    expect(out.exitCode).toBe(2)
    expect(out.json.error.code).toBe('PARTIAL')
    expect(out.json.data.summary).toMatchObject({ totalFiles: 2, succeeded: 1, failed: 1 })
    expect(out.json.data.details.some((d: { error?: string }) => d.error === '权限不足')).toBe(true)
  })

  it('AC-036 --wait 超时返回 WAIT_TIMEOUT 与退出码 3，且不取消任务', async () => {
    const h = await boot({ slowMs: 1500, changedFiles: ['dist/a.js', 'dist/b.css'] })
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--wait', '--wait-timeout', '1', '--json'])
    expect(out.exitCode).toBe(3)
    expect(out.json.error.code).toBe('WAIT_TIMEOUT')
    expect(out.json.error.hint).toContain('shipit task')
    await queue!.drain()
    expect(queue!.snapshot().tasks.every((t) => t.state === 'succeeded')).toBe(true)
  })

  it('INV-9 上传被取消时按 PARTIAL 报告（不报告为整体成功）', () => {
    const record = {
      taskId: 'T1',
      state: 'succeeded' as const,
      progress: { current: 1, total: 3, file: 'dist/a.js' },
      createdAt: 1,
      origin: 'desktop' as const,
      target: 'my_dev',
      projectRoot: PROJECT,
      totalFiles: 3,
      cancelled: true,
      result: {
        taskId: 'T1',
        targetName: 'my_dev',
        timestamp: 1,
        totalFiles: 3,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        duration: 1,
        cancelled: true,
        details: [{ relativePath: 'dist/a.js', remotePath: '/opt/dist/a.js', status: 'success' as const }]
      }
    }
    const env = verdictOf(record)
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('PARTIAL')
    expect(env.error.message).toContain('剩余 2 个未处理')
    expect(JSON.stringify(env)).toContain('"cancelled":true')
  })

  it('AC-033 / INV-9 未被取消且无失败时仍为成功', () => {
    const env = verdictOf({
      taskId: 'T2',
      state: 'succeeded',
      progress: { current: 1, total: 1, file: 'a' },
      createdAt: 1,
      origin: 'cli',
      target: 'my_dev',
      projectRoot: PROJECT,
      totalFiles: 1,
      result: {
        taskId: 'T2',
        targetName: 'my_dev',
        timestamp: 1,
        totalFiles: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        duration: 1,
        details: []
      }
    })
    expect(env.ok).toBe(true)
  })

  it('AC-020 执行体抛错 → 任务失败，--wait 返回连接类错误与退出码 3', async () => {
    const h = await boot({ connectError: '认证失败' })
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--wait', '--json'])
    expect(out.exitCode).toBe(3)
    expect(out.json.error.message).toContain('认证失败')
  })

  it('AC-006 全部未命中映射返回 EMPTY_SELECTION 且不提交任务', async () => {
    const h = await boot({ changedFiles: ['README.md'] })
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--json'])
    expect(out.exitCode).toBe(3)
    expect(out.json.error.code).toBe('EMPTY_SELECTION')
    expect(queue!.snapshot().tasks).toHaveLength(0)
  })

  it('AC-019 上传进行中再次提交进入队列且不取消前一个', async () => {
    const gate = deferred()
    const h = await boot({ gate })
    const first = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--json'])
    const second = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--json'])
    const secondTask = queue!.get(second.json.data.taskId)!
    expect(secondTask.state).toBe('queued')
    expect(queue!.get(first.json.data.taskId)!.state).toBe('running')
    gate.open()
    await queue!.drain()
    expect(queue!.get(first.json.data.taskId)!.state).toBe('succeeded')
    expect(queue!.get(second.json.data.taskId)!.state).toBe('succeeded')
  })

  it('策略 D′ 未传 --project 时 deploy 被阻止（USAGE / 退出码 1，且不产生任务）', async () => {
    const h = await boot()
    const out = await h.run(['deploy', '--target', 'my_dev', '--json'])
    expect(out.exitCode).toBe(1)
    expect(out.json.error.code).toBe('USAGE')
    expect(queue!.snapshot().tasks).toHaveLength(0)
  })
  it('策略 D′ 桌面焦点在别的项目时，按 --project 执行（不会误发到焦点项目）', async () => {
    // 这是 D′ 的核心价值：焦点项目 = /focused，但请求明确要求 PROJECT
    const h = await boot({ currentProject: '/focused' })
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--json'])
    expect(out.exitCode).toBe(0)
    const tasks = queue!.snapshot().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].projectRoot).toBe(PROJECT)
  })
})

describe('status 与 task', () => {
  it('AC-015 status 返回服务端状态、版本与协议版本', async () => {
    const h = await boot()
    const out = await h.run(['status', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data).toMatchObject({ listening: true, port: h.port, version: '1.0.3', protocolVersion: 1 })
    expect(out.json.data.currentProject).toBe(PROJECT)
    expect(out.json.data.projects).toEqual([{ path: PROJECT, name: 'app', windowId: 1, focused: true }])
  })

  it('AC-034 status 返回队列快照（taskId / 状态 / 进度 / 来源）', async () => {
    const gate = deferred()
    const h = await boot({ gate })
    await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--json'])
    const out = await h.run(['status', '--json'])
    const task = out.json.data.queue.tasks[0]
    expect(task).toMatchObject({ state: 'running', origin: 'cli', target: 'my_dev' })
    expect(out.json.data.queue.state).toBe('running')
    expect(out.json.meta.runningTaskId).toBe(task.taskId)
    gate.open()
    await queue!.drain()
  })

  it('AC-034 task 详情含状态与逐文件明细', async () => {
    const h = await boot()
    const deploy = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--wait', '--json'])
    const out = await h.run(['task', deploy.json.data.taskId, '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.state).toBe('succeeded')
    expect(out.json.data.result.details).toHaveLength(2)
  })

  it('AC-035 未知任务返回 UNKNOWN_TASK 与退出码 4', async () => {
    const h = await boot()
    const out = await h.run(['task', '00000000-0000-0000-0000-000000000000', '--json'])
    expect(out.exitCode).toBe(4)
    expect(out.json.error.code).toBe('UNKNOWN_TASK')
  })

  it('AC-015 status 人类可读输出含版本与队列信息', async () => {
    const h = await boot()
    const out = await h.run(['status'])
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('1.0.3')
    expect(out.stdout).toContain('queue')
  })

  it('P2 回归 --expect-files 与 plan 结果一致时照常提交，并在响应里回传实际文件集合', async () => {
    const h = await boot({ changedFiles: ['dist/a.js'] })
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--expect-files', 'dist/a.js', '--json'])

    expect(out.exitCode).toBe(0)
    expect(out.json.data.files).toEqual(['dist/a.js'])
    await queue!.drain()
    expect(queue!.snapshot().tasks).toHaveLength(1)
  })

  it('P2 回归 --expect-files 与当前集合不一致时拒绝提交（PLAN_STALE，退出码 4，不入队）', async () => {
    const h = await boot()
    const out = await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--expect-files', 'dist/other.js', '--json'])

    expect(out.exitCode).toBe(4)
    expect(out.json.error.code).toBe('PLAN_STALE')
    expect(out.json.error.hint).toContain('plan')
    // 关键：不静默换集合上传
    expect(queue!.snapshot().tasks).toHaveLength(0)
  })

  it('DFX-PERF-005 命令结束即退出：不留未清理且仍 ref 的定时器', async () => {
    const h = await boot()
    const created = new Set<NodeJS.Timeout>()
    const cleared = new Set<NodeJS.Timeout>()
    const realSetTimeout = globalThis.setTimeout
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      ...args: unknown[]
    ) => {
      const timer = (realSetTimeout as (...a: unknown[]) => NodeJS.Timeout)(...args)
      created.add(timer)
      return timer
    }) as unknown as typeof globalThis.setTimeout)
    const realClearTimeout = globalThis.clearTimeout
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer?: NodeJS.Timeout) => {
      if (timer) cleared.add(timer)
      return (realClearTimeout as (t?: NodeJS.Timeout) => void)(timer)
    }) as typeof globalThis.clearTimeout)

    await h.run(['deploy', '--project', PROJECT, '--target', 'my_dev', '--json'])

    setSpy.mockRestore()
    clearSpy.mockRestore()

    // 允许“已 unref”或“已清理”的定时器；只禁止既没清、还 ref 着的那种（它会拖住进程退出）。
    // 上传看门狗就属于前者：unref 且任务结束时被 clearTimeout 清掉。
    const lingering = [...created].filter((t) => !cleared.has(t) && t.hasRef())
    expect(lingering).toHaveLength(0)
    await queue!.drain()
  })
})
