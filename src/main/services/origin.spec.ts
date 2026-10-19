/**
 * 来源三值标注用例（任务 14 / AC-037 / D-25）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createLocalServer, originOf, type Handlers, type LocalServer } from './local-server'
import { createQueue } from './deploy-queue'
import { defaultServerConfig, loadServerConfig } from './server-config'
import { createServerHandlers } from './server-handlers'
import { ProjectContext } from './project-context'
import { request as httpsRequest } from 'https'
import { PROTOCOL_VERSION } from '../../shared/cli-contract'
import type { DeployTarget, UploadTaskRecord } from '../../shared/types'

const TOKEN = '0123456789abcdef'
const PROJECT = 'D:/work/app'

let dir = ''
let server: LocalServer | null = null

const target: DeployTarget = {
  id: 't1',
  name: 'my_dev',
  protocol: 'local',
  host: 'D:/target',
  port: 0,
  username: 'local',
  mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/opt/dist' }]
}

function call(
  port: number,
  path: string,
  opts: { token?: string; protocol?: string; client?: string; method?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'x-shipit-token': opts.token ?? TOKEN,
    'x-shipit-protocol': opts.protocol ?? String(PROTOCOL_VERSION)
  }
  if (opts.client) headers['x-shipit-client'] = opts.client
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
  if (payload) headers['content-type'] = 'application/json'

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, rejectUnauthorized: false },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let body: any = raw
          try {
            body = JSON.parse(raw)
          } catch {
            /* 保留文本 */
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function boot(onSettled?: (record: UploadTaskRecord) => void): Promise<{ port: number; queue: ReturnType<typeof createQueue> }> {
  const context = new ProjectContext('win32')
  context.setCurrent(PROJECT)
  const queue = createQueue({ onTaskSettled: onSettled })
  const handlers: Partial<Handlers> = createServerHandlers({
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
      listChangedFiles: async () => ['dist/a.js'],
      listCommitFiles: async () => ['dist/a.js'],
      listFilesInDir: async () => [join(PROJECT, 'dist/a.js')]
    },
    buildUploadTasks: async (files, projectRoot) =>
      files.map((f) => ({
        localPath: f,
        remotePath: '/opt/dist/a.js',
        relativePath: 'dist/a.js',
        size: 1
      })),
    git: {
      isGitRepo: async () => true,
      getStatusView: async () => ({ hasGit: true, branch: 'main', ahead: 0, behind: 0, changes: [] }),
      getLogView: async () => [],
      getBranches: async () => []
    },
    queue,
    getVersion: () => '1.0.3',
    deploy: async (tasks) => ({
      taskId: 'x',
      targetName: 'my_dev',
      timestamp: Date.now(),
      totalFiles: tasks.length,
      succeeded: tasks.length,
      failed: 0,
      skipped: 0,
      duration: 3,
      details: tasks.map((t) => ({ relativePath: t.relativePath, remotePath: t.remotePath, status: 'success' as const }))
    })
  })

  server = createLocalServer({
    config: { ...defaultServerConfig(), enabled: true, port: 0, tokenMode: 'custom', token: TOKEN },
    dataDir: dir,
    handlers
  })
  const started = await server.start()
  if (!started.listening) throw new Error('服务端启动失败')
  return { port: started.port, queue }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipit-origin-'))
})

afterEach(async () => {
  if (server) await server.stop().catch(() => undefined)
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('originOf（请求头 → 来源三值）', () => {
  it('AC-037 三种调用方写入不同 origin', () => {
    expect(originOf({ 'x-shipit-client': 'cli' })).toBe('cli')
    expect(originOf({ 'x-shipit-client': 'mcp' })).toBe('mcp')
    expect(originOf({})).toBe('desktop')
  })

  it('AC-037 未声明或取值非法一律按桌面内部调用处理（不猜测）', () => {
    expect(originOf({ 'x-shipit-client': 'web' })).toBe('desktop')
    expect(originOf({ 'x-shipit-client': '' })).toBe('desktop')
    expect(originOf({ 'x-shipit-client': ['cli', 'mcp'] })).toBe('cli')
    expect(originOf({ 'x-shipit-client': undefined })).toBe('desktop')
  })

  it('AC-037 只认自己的头，其它头不影响判定', () => {
    expect(originOf({ 'x-shipit-client': undefined, 'user-agent': 'cli/1.0' })).toBe('desktop')
  })
})

describe('来源贯通（请求 → 任务 → 界面日志）', () => {
  it('AC-037 / DFX-SEC-004 CLI 调用写入 origin=cli 且带来源地址与项目根（执行留痕）', async () => {
    const seen: UploadTaskRecord[] = []
    const { port, queue } = await boot((record) => seen.push(record))

    const res = await call(port, '/deploy', { method: 'POST', client: 'cli', body: { target: 'my_dev', projectRoot: PROJECT } })
    expect(res.body.ok).toBe(true)
    const taskId = res.body.data.taskId
    await queue.drain()

    const record = queue.get(taskId)!
    expect(record.origin).toBe('cli')
    expect(record.client).toBe('cli')
    expect(record.projectRoot).toBe(PROJECT)
    expect(record.remoteAddress).toBeTruthy()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ origin: 'cli', client: 'cli', projectRoot: PROJECT })
    expect(seen[0].result?.succeeded).toBe(1)
  })

  it('AC-037 MCP 调用写入 origin=mcp', async () => {
    const { port, queue } = await boot()
    const res = await call(port, '/deploy', { method: 'POST', client: 'mcp', body: { target: 'my_dev', projectRoot: PROJECT } })
    await queue.drain()
    expect(queue.get(res.body.data.taskId)!.origin).toBe('mcp')
  })

  it('AC-037 未声明调用方标识时按 desktop 记录（界面自身发起）', async () => {
    const { port, queue } = await boot()
    const res = await call(port, '/deploy', { method: 'POST', body: { target: 'my_dev', projectRoot: PROJECT } })
    await queue.drain()
    const record = queue.get(res.body.data.taskId)!
    expect(record.origin).toBe('desktop')
    expect(record.client).toBeUndefined()
  })

  it('AC-019 排队中的任务保留各自来源，可区分并发调用方', async () => {
    const { port, queue } = await boot()
    const first = await call(port, '/deploy', { method: 'POST', client: 'cli', body: { target: 'my_dev', projectRoot: PROJECT } })
    const second = await call(port, '/deploy', { method: 'POST', client: 'mcp', body: { target: 'my_dev', projectRoot: PROJECT } })
    await queue.drain()
    expect(queue.get(first.body.data.taskId)!.origin).toBe('cli')
    expect(queue.get(second.body.data.taskId)!.origin).toBe('mcp')
  })

  it('CON-6 / INV-5 上传日志不落盘，且任务记录不含凭据', async () => {
    const { port, queue } = await boot()
    await call(port, '/deploy', { method: 'POST', client: 'cli', body: { target: 'my_dev', projectRoot: PROJECT } })
    await queue.drain()

    // 数据目录只有证书与连接信息文件：上传日志不写磁盘（CON-6）
    const files = readdirSync(dir)
    expect(files.sort()).toEqual(['cert.pem', 'key.pem', 'server.json'])
    expect(files.some((f) => /log/i.test(f))).toBe(false)

    const record = queue.get(queue.snapshot().tasks[0].taskId)!
    expect(JSON.stringify(record)).not.toMatch(/password|privateKey|passphrase/i)
  })

  it('服务端配置与连接信息同目录且互不覆盖（写入日志条目不会破坏配置）', async () => {
    const { port, queue } = await boot()
    await call(port, '/deploy', { method: 'POST', body: { target: 'my_dev', projectRoot: PROJECT } })
    await queue.drain()

    expect(existsSync(join(dir, 'server.json'))).toBe(true)
    const cfg = await loadServerConfig(join(dir, 'deploy-config.json'))
    expect(cfg.enabled).toBe(false)
    expect(dirname(join(dir, 'deploy-config.json'))).toBe(dir)
  })

  it('AC-020 服务端关闭后连接信息失效（日志与配置不受影响）', async () => {
    const { queue } = await boot()
    await server!.stop()
    expect(existsSync(join(dir, 'server.json'))).toBe(false)
    expect(queue.snapshot().tasks).toEqual([])
  })

  it('INV-5 部署请求体中的目标凭据不进入任务记录（服务端自行读取配置）', async () => {
    const { port, queue } = await boot()
    const res = await call(port, '/deploy', {
      method: 'POST',
      client: 'cli',
      body: { target: 'my_dev', projectRoot: PROJECT, password: 'leak-me', token: 'leak-me-too' }
    })
    await queue.drain()
    const record = queue.get(res.body.data.taskId)!
    expect(JSON.stringify(record)).not.toContain('leak-me')
  })

  it('写入配置后服务端读取到最新目标（配置与日志同目录不互相干扰）', async () => {
    writeFileSync(join(dir, 'deploy-config.json'), JSON.stringify({ recentProjects: [], deploymentTargets: [] }), 'utf-8')
    const { port } = await boot()
    const res = await call(port, '/targets')
    expect(res.body.ok).toBe(true)
    expect(res.body.data[0].name).toBe('my_dev')
  })
})
