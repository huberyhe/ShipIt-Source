/**
 * 服务端处理器绑定完整性（实现收敛守卫）。
 *
 * 路由表里存在但未绑定处理器的接口，线上会返回「接口未启用」——这类缺口不会报错，
 * 只会在使用某个命令时才发现。这里按路由表逐条核对，确保 9 个接口全部有实现。
 */
import { describe, expect, it, vi } from 'vitest'
import { createServerHandlers, pickBool, pickRaw, type ServerHandlerDeps } from './server-handlers'
import { ROUTES } from './local-server'
import { createQueue, QueueError } from './deploy-queue'
import type { DeployTarget } from '../../shared/types'

const target: DeployTarget = {
  id: 't1',
  name: 'my_dev',
  protocol: 'local',
  host: 'D:/target',
  port: 0,
  username: 'local',
  mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/opt/dist' }]
}

function deps(over: Partial<ServerHandlerDeps> = {}): ServerHandlerDeps {
  return {
    loadTargets: async () => [target],
    testConnection: async () => ({ success: true }),
    resolveProject: () => ({ ok: true, project: { projectRoot: 'D:/work/app', mismatch: false } }),
    projectContext: { currentProject: () => null },
    listProjects: async () => [],
    projectScope: () => ({ enforce: false, allowedRoots: [] }),
    activeSessions: () => [],
    
    
    selection: {
      isGitRepo: async () => true,
      listChangedFiles: async () => ['dist/a.js'],
      listCommitFiles: async () => ['dist/a.js'],
      listFilesInDir: async () => ['D:/work/app/dist/a.js']
    },
    buildUploadTasks: async (files, projectRoot) =>
      files.map((f) => ({ localPath: f, remotePath: '/opt/dist/a.js', relativePath: 'dist/a.js', size: 1 })),
    git: {
      isGitRepo: async () => true,
      getStatusView: async () => ({ hasGit: true, branch: 'main', ahead: 0, behind: 0, changes: [] }),
      getLogView: async () => [],
      getBranches: async () => []
    },
    queue: createQueue(),
    getVersion: () => '1.0.3',
    deploy: async (tasks) => ({
      taskId: 'x',
      targetName: 'my_dev',
      timestamp: 1,
      totalFiles: tasks.length,
      succeeded: tasks.length,
      failed: 0,
      skipped: 0,
      duration: 1,
      details: []
    }),
    ...over
  }
}

describe('服务端接口绑定完整性', () => {
  it('路由表中的每个接口都有处理器（无「接口未启用」缺口）', () => {
    const handlers = createServerHandlers(deps(), () => ({ listening: true, port: 4517, bound: '127.0.0.1' }))
    for (const route of ROUTES) {
      expect(handlers[route.handler], `未绑定处理器：${route.method} ${route.path}`).toBeTypeOf('function')
    }
    expect(ROUTES).toHaveLength(10)
  })

  it('DFX-TST-001 可离线测试：每个处理器都能以注入桩调用并返回信封（不抛异常）', async () => {
    const handlers = createServerHandlers(deps())
    for (const route of ROUTES) {
      const handler = handlers[route.handler]
      if (!handler) throw new Error(`缺少处理器：${route.handler}`)
      const envelope = await handler({
        method: route.method,
        path: route.path,
        params: { id: '00000000-0000-0000-0000-000000000000' },
        query: new URLSearchParams(
          route.handler === 'task' ? {} : { target: 'my_dev', name: 'my_dev', projectRoot: 'D:/work/app' }
        ),
        body: { target: 'my_dev', selector: { kind: 'files', paths: ['dist/a.js'] } },
        origin: 'cli',
        remoteAddress: '127.0.0.1'
      })
      expect(envelope, `处理器未返回信封：${route.handler}`).toHaveProperty('ok')
    }
  })

  it('参数读取兼容 GET query 与 POST body（含布尔字符串）', () => {
    const ctx = (query: Record<string, string>, body?: unknown): Parameters<typeof pickRaw>[0] => ({
      method: 'GET',
      path: '/x',
      params: {},
      query: new URLSearchParams(query),
      body,
      origin: 'cli',
      remoteAddress: '127.0.0.1'
    })

    expect(pickRaw(ctx({}, { selector: { kind: 'dir', path: 'dist' } }), 'selector')).toEqual({ kind: 'dir', path: 'dist' })
    expect(pickRaw(ctx({ limit: '20' }), 'limit')).toBe('20')
    // 布尔解析仍在用（例如 deploy 的 wait）；这里用同类开关验证
    expect(pickBool(ctx({ wait: 'true' }), 'wait')).toBe(true)
    expect(pickBool(ctx({}, { wait: true }), 'wait')).toBe(true)
    expect(pickBool(ctx({}, {}), 'wait')).toBe(false)
  })

  it('处理器不会把上传逻辑复制一份：deploy 走注入的执行体（DFX-REUSE-001）', async () => {
    const spy = vi.fn(async (tasks: unknown[]) => ({
      taskId: 'x',
      targetName: 'my_dev',
      timestamp: 1,
      totalFiles: (tasks as unknown[]).length,
      succeeded: (tasks as unknown[]).length,
      failed: 0,
      skipped: 0,
      duration: 1,
      details: []
    }))
    const queue = createQueue()
    const handlers = createServerHandlers(deps({ deploy: spy as never, queue }))
    const envelope = await handlers.deploy!({
      method: 'POST',
      path: '/deploy',
      params: {},
      query: new URLSearchParams(),
      body: { target: 'my_dev', selector: { kind: 'files', paths: ['dist/a.js'] } },
      origin: 'mcp',
      remoteAddress: '10.0.0.9'
    })
    expect(envelope.ok).toBe(true)
    await queue.drain()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(queue.snapshot().tasks[0]).toMatchObject({ origin: 'mcp', remoteAddress: '10.0.0.9' })
  })

  it('P2 回归 空上传集合的文案区分「文件不存在」与「未命中映射」', async () => {
    // Windows 下 path.join 会产出反斜杠：比较前统一成正斜杠
    const isMissing = (abs: string): boolean => abs.replace(/\\/g, '/').endsWith('dist/gone.js')
    const handlers = createServerHandlers(
      deps({
        selection: {
          isGitRepo: async () => true,
          listChangedFiles: async () => ['dist/gone.js', 'README.md'],
          listCommitFiles: async () => [],
          listFilesInDir: async () => [],
          exists: async (abs) => !isMissing(abs)
        },
        buildUploadTasks: async () => []
      })
    )

    const envelope = await handlers.deploy!({
      method: 'POST',
      path: '/deploy',
      params: {},
      query: new URLSearchParams(),
      body: { target: 'my_dev', selector: { kind: 'all-changed' } },
      origin: 'cli',
      remoteAddress: '10.0.0.9'
    })

    expect(envelope.ok).toBe(false)
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('EMPTY_SELECTION')
      expect(envelope.error.message).toContain('1 个文件不存在')
      expect(envelope.error.message).toContain('1 个未命中目录映射')
    }
  })

  it('P2 回归 队列满时按信封如实上报 QUEUE_FULL（不当成服务端故障）', async () => {
    const full = deps({
      queue: {
        ...createQueue(),
        submit: () => {
          throw new QueueError('QUEUE_FULL', '队列积压已达上限（20 个等待中）：请等待既有任务完成后再提交')
        }
      }
    })
    const handlers = createServerHandlers(full)

    const envelope = await handlers.deploy!({
      method: 'POST',
      path: '/deploy',
      params: {},
      query: new URLSearchParams(),
      body: { target: 'my_dev', selector: { kind: 'files', paths: ['dist/a.js'] } },
      origin: 'cli',
      remoteAddress: '10.0.0.9'
    })

    expect(envelope.ok).toBe(false)
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('QUEUE_FULL')
      expect(envelope.error.hint).toBeTruthy()
    }
  })
})

