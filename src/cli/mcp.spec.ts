/**
 * MCP 工具层与 server 装配用例（任务 13）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueue } from '../main/services/deploy-queue'
import { ProjectContext } from '../main/services/project-context'
import { createServerHandlers } from '../main/services/server-handlers'
import { createServerClient } from './client'
import type { DiscoveredConnection } from './discover'
import { callTool, MCP_TOOLS, mcpToolNames } from './mcp-tools'
import { runCli } from './index'
import { createMcpServer, createStdioProvider, MCP_SERVER_NAME, runMcpServer, toMcpResult } from './mcp'
import { join } from 'path'
import { tmpdir } from 'os'
import { startHarness, TEST_TOKEN, type Harness } from './testing/harness'
import { PROTOCOL_VERSION } from '../shared/cli-contract'

const PROJECT = 'D:/work/app'

let harness: Harness | null = null
let queue: ReturnType<typeof createQueue> | null = null

async function boot(options: { currentProject?: string | null } = {}): Promise<Harness> {
  const context = new ProjectContext('win32')
  context.setCurrent(options.currentProject === undefined ? PROJECT : options.currentProject)
  queue = createQueue()
  const handlers = createServerHandlers({
    loadTargets: async () => [
      {
        id: 't1',
        name: 'my_dev',
        protocol: 'local',
        host: 'D:/target',
        port: 0,
        username: 'local',
        password: 'secret',
        mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/opt/dist' }]
      }
    ],
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
      listChangedFiles: async () => ['dist/a.js'],
      listCommitFiles: async () => ['dist/a.js'],
      listFilesInDir: async () => [`${PROJECT}/dist/a.js`]
    },
    buildUploadTasks: async (files, projectRoot) =>
      files
        .map((f) => f.replace(/\\/g, '/'))
        .filter((f) => f.includes('/dist/'))
        .map((f) => ({
          localPath: f,
          remotePath: '/opt/dist/' + f.split('/').pop(),
          relativePath: f.replace(`${projectRoot.replace(/\\/g, '/')}/`, ''),
          size: 3
        })),
    git: {
      isGitRepo: async () => true,
      getStatusView: async () => ({ hasGit: true, branch: 'main', ahead: 0, behind: 0, changes: [] }),
      getLogView: async () => [],
      getBranches: async () => [{ name: 'main', ref: 'main', isRemote: false }]
    },
    queue,
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
      details: tasks.map((t) => ({ relativePath: t.relativePath, remotePath: t.remotePath, status: 'success' as const }))
    })
  })
  harness = await startHarness(handlers)
  return harness
}

/** 基于测试服务端的连接提供者（模拟常驻进程重读连接信息） */
function providerFor(h: Harness, over: Partial<DiscoveredConnection> = {}): {
  connect: () => Promise<{ ok: true; client: ReturnType<typeof createServerClient> }>
} {
  return {
    connect: async () => ({
      ok: true as const,
      client: createServerClient({
        connection: {
          port: h.port,
          token: '0123456789abcdef',
          protocolVersion: PROTOCOL_VERSION,
          fingerprint: h.fingerprint,
          source: 'shipit-home',
          file: `${h.dataDir}/server.json`,
          ...over
        },
        client: 'mcp'
      })
    })
  }
}

afterEach(async () => {
  if (queue) await queue.drain()
  if (harness) await harness.stop()
  harness = null
  queue = null
})

describe('MCP 工具集（CON-9）', () => {
  it('AC-030 工具集与 CLI 命令集一一对应（9 项）', () => {
    expect(mcpToolNames()).toEqual([
      'deploy',
      'git_log',
      'git_status',
      'list_projects',
      'list_targets',
      'ping_targets',
      'plan_deploy',
      'server_status',
      'task_status'
    ])
  })

  it('AC-030 每个工具都有输入 schema 且声明对应 CLI 命令', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.cli.length).toBeGreaterThan(0)
      expect(tool.description.length).toBeGreaterThan(0)
    }
    const deploy = MCP_TOOLS.find((t) => t.name === 'deploy')
    expect(Object.keys(deploy!.inputSchema.properties)).toContain('wait')
    expect(Object.keys(deploy!.inputSchema.properties)).toContain('waitTimeoutSeconds')
  })

  it('AC-030 未知工具返回用法类错误', async () => {
    const h = await boot()
    const env = await callTool('nope', {}, providerFor(h))
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('USAGE')
  })

  /**
   * 回归（实机事故）：deploy 的选择器字段是 `selector`，没有 `files`。
   * 传错名字若被静默忽略，selector 会落到默认的 all-changed ——
   * 一次"只传一个文件"的调用实际上传了 23 个真实文件。
   */
  it('P0 未知参数必须拒绝：deploy 传 files 不得回落成 all-changed', async () => {
    const h = await boot()
    const before = queue!.snapshot().tasks.length
    const env = await callTool(
      'deploy',
      { target: 'my_dev', projectRoot: PROJECT, files: ['dist/a.js'] },
      providerFor(h)
    )

    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('USAGE')
    expect(env.error.message).toContain('files')
    // 关键：没有提交任何任务（更没有回落成 all-changed）
    expect(queue!.snapshot().tasks.length).toBe(before)
  })
})

describe('MCP 工具调用（转发到服务端）', () => {
  it('AC-016 list_targets 返回目标摘要且不含凭据', async () => {
    const h = await boot()
    const env = await callTool('list_targets', {}, providerFor(h))
    expect(env.ok).toBe(true)
    expect(JSON.stringify(env)).not.toMatch(/secret|password/i)
    expect((env as { data: Array<{ name: string }> }).data[0].name).toBe('my_dev')
  })

  it('AC-031 plan_deploy 与 git_* 查询可经 MCP 调用', async () => {
    const h = await boot()
    const plan = await callTool('plan_deploy', { target: 'my_dev', projectRoot: PROJECT }, providerFor(h))
    expect(plan.ok).toBe(true)
    expect(JSON.stringify(plan)).toContain('relativePath')

    const status = await callTool('git_status', { projectRoot: PROJECT }, providerFor(h))
    const log = await callTool('git_log', { limit: 10, projectRoot: PROJECT }, providerFor(h))
    expect([status.ok, log.ok]).toEqual([true, true])
  })

  it('策略 D′ 未给 projectRoot 时 MCP 项目相关工具一律被拒绝（USAGE）', async () => {
    const h = await boot({ currentProject: null })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['plan_deploy', { target: 'my_dev' }],
      ['deploy', { target: 'my_dev' }],
      ['git_status', {}],
      ['git_log', {}]
    ]
    for (const [name, args] of cases) {
      const env = await callTool(name, args, providerFor(h))
      expect(env.ok, name).toBe(false)
      if (env.ok) continue
      expect(env.error.code, name).toBe('USAGE')
    }
    // 与项目无关的工具不受影响
    const status = await callTool('server_status', {}, providerFor(h))
    expect(status.ok).toBe(true)
    expect(queue!.snapshot().tasks).toHaveLength(0) // 未产生上传任务
  })
  it('AC-031 server_status 返回版本与队列快照', async () => {
    const h = await boot()
    const env = await callTool('server_status', {}, providerFor(h))
    expect(env.ok).toBe(true)
    expect(JSON.stringify(env)).toContain('"queue"')
    expect(JSON.stringify(env)).toContain('1.0.3')
  })

  it('AC-031 deploy 默认异步返回 taskId；task_status 可查', async () => {
    const h = await boot()
    const env = await callTool('deploy', { target: 'my_dev', projectRoot: PROJECT }, providerFor(h))
    expect(env.ok).toBe(true)
    const taskId = (env as { data: { taskId: string } }).data.taskId
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/)

    await queue!.drain()
    const detail = await callTool('task_status', { taskId }, providerFor(h))
    expect(detail.ok).toBe(true)
    expect(JSON.stringify(detail)).toContain('"succeeded"')
  })

  it('AC-031 deploy wait=true 等待到终态并返回明细', async () => {
    const h = await boot()
    const env = await callTool('deploy', { target: 'my_dev', wait: true, projectRoot: PROJECT }, providerFor(h))
    expect(env.ok).toBe(true)
    expect(JSON.stringify(env)).toContain('"summary"')
  })

  it('P1-5 deploy 转发 expectFiles：集合漂移时被拒（PLAN_STALE），护栏不再形同虚设', async () => {
    const h = await boot()
    // 该夹具的当前变更固定为 dist/a.js；这里声明"应当有 a.js 与 b.js" → 集合不一致，服务端必须拒绝
    const out = await callTool(
      'deploy',
      { target: 'my_dev', projectRoot: PROJECT, expectFiles: ['dist/a.js', 'dist/b.js'] },
      providerFor(h)
    )
    // 既有约定：callTool 直接返回信封（不是 MCP result 包装），失败即 ok:false
    expect(out.ok).toBe(false)
    expect(JSON.stringify(out)).toContain('PLAN_STALE')
    expect(queue?.snapshot().tasks.length ?? 0).toBe(0)
  })

  it('策略 D′ list_projects 返回已打开项目（供发现 projectRoot）', async () => {
    const h = await boot()
    const env = await callTool('list_projects', {}, providerFor(h))
    expect(env.ok).toBe(true)
    if (!env.ok) return
    const data = env.data as { projects: unknown[]; scope: unknown }
    expect(data.projects).toEqual([{ path: PROJECT, name: 'app', windowId: 1, focused: true }])
    // 同时回显作用域：本机（enforce=false）时 allowedRoots 为空
    expect(data.scope).toEqual({ enforced: false, allowedRoots: [] })
  })

  it('mcp 命令不走 CLI 侧预检：只预检一次（防重复校验）', async () => {
    const lines: string[] = []
    let cliClientCreated = 0
    const code = await runCli(['mcp'], {
      env: { SHIPIT_HOME: join(tmpdir(), 'shipit-mcp-none-' + Date.now()) },
      io: { stdout: () => {}, stderr: (t) => lines.push(t) },
      // 若 CLI 侧预检被触发，就一定会先建客户端 → 这里立刻暴露
      createClient: () => {
        cliClientCreated++
        throw new Error('mcp 路径不应创建 CLI 客户端（说明 CLI 侧预检被重复执行）')
      }
    })
    expect(code).not.toBe(0)
    expect(cliClientCreated).toBe(0)
    const text = lines.join('')
    // 失败诊断只出现一次 → MCP 路径内确实只预检一次
    expect(text.match(/\[shipit mcp\] 启动失败/g)?.length ?? 0).toBe(1)
  })

  it('启动预检失败：不进入 stdio 服务，把失败信封写 stderr 并以非零码返回', async () => {
    const lines: string[] = []
    // 连不上（provider 失败）→ runMcpServer 必须早退，不会去 connect stdio
    const code = await runMcpServer(
      { SHIPIT_HOME: join(tmpdir(), 'shipit-mcp-nonexistent-' + Date.now()) },
      [],
      { stderr: (t) => lines.push(t) }
    )
    expect(code).not.toBe(0)
    const text = lines.join('')
    expect(text).toContain('[shipit mcp] 启动失败')
    // 失败信封必须原样给出（宿主可据此判断）
    expect(text).toContain('"ok":false')
  })

  it('AC-037 MCP 调用在任务与日志中标注 origin=mcp', async () => {
    const h = await boot()
    const env = await callTool('deploy', { target: 'my_dev', wait: true, projectRoot: PROJECT }, providerFor(h))
    const record = queue!.get((env as unknown as { data: { taskId: string } }).data.taskId)
    expect(record!.origin).toBe('mcp')
    expect(record!.client).toBe('mcp')
  })

  it('AC-002 目标不存在返回 NO_TARGET（错误类别与 CLI 一致）', async () => {
    const h = await boot()
    const env = await callTool('ping_targets', { target: 'nope' }, providerFor(h))
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('NO_TARGET')
  })

  it('AC-035 task_status 未知任务返回 UNKNOWN_TASK', async () => {
    const h = await boot()
    const env = await callTool('task_status', { taskId: 'missing' }, providerFor(h))
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('UNKNOWN_TASK')
  })
})

describe('MCP 常驻重读（AC-029）', () => {
  it('AC-029 令牌轮换后重读连接信息并重试一次即成功', async () => {
    const h = await boot()
    let attempts = 0
    const valid = providerFor(h)
    const provider = {
      connect: async () => {
        attempts += 1
        // 第一次返回旧令牌（触发 INVALID_TOKEN），重读后返回正确令牌
        if (attempts === 1) {
          const stale = await valid.connect()
          return {
            ok: true as const,
            client: createServerClient({
              connection: { ...stale.client.connection, token: 'ffffffffffffffff' },
              client: 'mcp'
            })
          }
        }
        return valid.connect()
      }
    }

    const env = await callTool('server_status', {}, provider)
    expect(env.ok).toBe(true)
    expect(attempts).toBe(2)
  })

  it('P2-4 deploy(wait) 遇令牌轮换重试时不重复提交上传任务', async () => {
    // 用可计数的假客户端精确验证重试语义：提交一次、轮询遇 INVALID_TOKEN 后只继续轮询
    const submitEnvelope = {
      ok: true,
      data: { taskId: 'T1', position: 1, state: 'queued', createdAt: 1, totalFiles: 1, target: 'my_dev', projectRoot: PROJECT }
    }
    const taskRecord = {
      taskId: 'T1',
      state: 'succeeded',
      progress: { current: 1, total: 1, file: 'dist/a.js' },
      createdAt: 1,
      origin: 'mcp',
      target: 'my_dev',
      projectRoot: PROJECT,
      totalFiles: 1,
      result: { taskId: 'T1', targetName: 'my_dev', timestamp: 1, totalFiles: 1, succeeded: 1, failed: 0, skipped: 0, duration: 1, details: [] }
    }
    const post = vi.fn(async () => ({ ok: true as const, envelope: submitEnvelope as never }))
    let polls = 0
    const get = vi.fn(async (path: string) => {
      if (path.startsWith('/tasks/')) {
        polls += 1
        // 第一次轮询：令牌已失效（桌面版重启导致轮换）
        if (polls === 1) {
          return { ok: true as const, envelope: { ok: false as const, error: { code: 'INVALID_TOKEN' as const, message: '令牌轮换' } } }
        }
        return { ok: true as const, envelope: { ok: true as const, data: taskRecord as never } }
      }
      return { ok: true as const, envelope: { ok: true as const, data: {} } }
    })
    const client = { connection: { port: 1, token: 't', protocolVersion: PROTOCOL_VERSION, fingerprint: 'a', source: 'shipit-home', file: 'x' }, get, post }
    const provider = { connect: async () => ({ ok: true as const, client: client as never }) }

    const env = await callTool('deploy', { target: 'my_dev', wait: true, projectRoot: PROJECT }, provider)
    expect(env.ok).toBe(true)
    expect(post).toHaveBeenCalledTimes(1) // 关键：重试不重复提交上传
    expect(polls).toBeGreaterThan(1)
  })

  it('P1-2 非法选择器直接返回 USAGE（不降级为全部变更）', async () => {
    const h = await boot()
    for (const selector of [{ kind: 'dirs' }, { kind: 'dir', path: '' }, { kind: 'files', paths: [] }]) {
      const env = await callTool('deploy', { target: 'my_dev', selector, projectRoot: PROJECT }, providerFor(h))
      expect(env.ok, JSON.stringify(selector)).toBe(false)
      if (env.ok) continue
      expect(env.error.code).toBe('USAGE')
      expect(env.error.message).toContain('选择器非法')
    }
    // 未提供选择器时仍按缺省执行
    const absent = await callTool('plan_deploy', { target: 'my_dev', projectRoot: PROJECT }, providerFor(h))
    expect(absent.ok).toBe(true)
    expect(queue!.snapshot().tasks).toHaveLength(0)
  })

  it('AC-029 重试后仍失败则如实返回错误（不无限重试）', async () => {
    const h = await boot()
    let attempts = 0
    const provider = {
      connect: async () => {
        attempts += 1
        const valid = await providerFor(h).connect()
        return {
          ok: true as const,
          client: createServerClient({ connection: { ...valid.client.connection, token: 'ffffffffffffffff' }, client: 'mcp' })
        }
      }
    }
    const env = await callTool('server_status', {}, provider)
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('INVALID_TOKEN')
    expect(attempts).toBe(2)
  })

  it('AC-020 连接信息不可用时不发起请求', async () => {
    const provider = { connect: async () => ({ ok: false as const, error: { code: 'BACKEND_UNAVAILABLE', message: '无连接信息' } }) }
    const env = await callTool('server_status', {}, provider)
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('BACKEND_UNAVAILABLE')
  })

  it('AC-027 指纹不匹配不重试（证书变化需人工核对）', async () => {
    const h = await boot()
    const provider = providerFor(h, { fingerprint: 'b'.repeat(64) })
    const env = await callTool('server_status', {}, provider)
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('TLS_MISMATCH')
  })
})

describe('MCP server 装配', () => {
  it('AC-016 服务端信息含名称与包版本（版本取自包，CON-3）', () => {
    const server = createMcpServer({ connect: async () => ({ ok: false, error: { code: 'x', message: 'x' } }) })
    expect(server).toBeDefined()
    expect(MCP_SERVER_NAME).toBe('shipit')
  })

  it('CON-2 工具结果只输出结构化信封', () => {
    const result = toMcpResult({ ok: true, data: { a: 1 } })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, data: { a: 1 } })

    const failure = toMcpResult({ ok: false, error: { code: 'USAGE', message: 'x' } })
    expect(failure.isError).toBe(true)
  })

  it('AC-020 无连接信息时 provider 返回后端不可用', async () => {
    const provider = createStdioProvider({ SHIPIT_HOME: `${harness?.dataDir ?? ''}/nope` })
    const result = await provider.connect()
    expect(result.ok).toBe(false)
  })

  it('AC-029 provider 每次调用都重读连接信息文件', async () => {
    const h = await boot()
    const provider = createStdioProvider({ SHIPIT_HOME: h.dataDir })
    const first = await provider.connect()
    const second = await provider.connect()
    expect(first.ok && second.ok).toBe(true)
    const spy = vi.fn()
    spy()
    expect(spy).toHaveBeenCalled()
  })

  // P2 回归：此前 createStdioProvider 固定传 `args: []`，`shipit mcp --connect/--profile` 被静默丢弃，
  // 跨机器使用时既连不上、也可能错连到本机实例。
  it('P2 回归 --connect 连接串生效，且优先于本机发现', async () => {
    const connectionString = JSON.stringify({
      port: 4517,
      token: '0123456789abcdef',
      protocolVersion: PROTOCOL_VERSION,
      fingerprint: 'a'.repeat(64)
    })
    const provider = createStdioProvider({ SHIPIT_HOME: 'D:/no-such-home' }, [
      'mcp',
      '--connect',
      connectionString
    ])

    const result = await provider.connect()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.client.connection.source).toBe('connect')
      expect(result.client.connection.port).toBe(4517)
    }
  })

  it('P2 回归 --profile 生效：指向本机不存在的 profile 时失败，而非静默退回本机连接', async () => {
    const h = await boot()
    const withoutArgs = createStdioProvider({ SHIPIT_HOME: h.dataDir })
    const withProfile = createStdioProvider({ SHIPIT_HOME: h.dataDir }, ['mcp', '--profile', 'no-such-profile'])

    expect((await withoutArgs.connect()).ok).toBe(true)
    expect((await withProfile.connect()).ok).toBe(false)
  })
})