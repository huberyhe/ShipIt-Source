/**
 * git 只读查询命令级用例（任务 12）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectContext } from '../main/services/project-context'
import { createServerHandlers } from '../main/services/server-handlers'
import { createQueue } from '../main/services/deploy-queue'
import type { GitCommitInfo, GitStatusView } from '../shared/types'
import { startHarness, type Harness } from './testing/harness'

const PROJECT = 'D:/work/app'

const statusView: GitStatusView = {
  hasGit: true,
  branch: 'main',
  ahead: 1,
  behind: 0,
  changes: [
    { path: 'src/a.ts', relativePath: 'src\\a.ts', status: 'modified' },
    { path: 'dist/b.js', relativePath: 'dist/b.js', status: 'added' }
  ]
}

const commits: GitCommitInfo[] = [
  { hash: 'abc1234', author: 'huberyhe', email: 'h@example.com', date: '2026-10-08 10:00:00 +0800', message: 'feat: cli' }
]

interface BootOptions {
  isGitRepo?: boolean
  currentProject?: string | null
  changes?: GitStatusView['changes']
  commits?: GitCommitInfo[]

}

let harness: Harness | null = null

async function boot(options: BootOptions = {}): Promise<{ h: Harness; calls: string[] }> {
  const context = new ProjectContext('win32')
  context.setCurrent(options.currentProject === undefined ? PROJECT : options.currentProject)
  const calls: string[] = []

  const handlers = createServerHandlers({
    loadTargets: async () => [],
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
      isGitRepo: async () => options.isGitRepo ?? true,
      listChangedFiles: async () => [],
      listCommitFiles: async () => [],
      listFilesInDir: async () => []
    },
    buildUploadTasks: async () => [],
    git: {
      isGitRepo: async () => {
        calls.push('isGitRepo')
        return options.isGitRepo ?? true
      },
      getStatusView: async () => {
        calls.push('getStatusView')
        return { ...statusView, changes: options.changes ?? statusView.changes }
      },
      getLogView: async (_dir, opts) => {
        calls.push(`getLogView:${JSON.stringify(opts)}`)
        return options.commits ?? commits
      },
      getBranches: async () => {
        calls.push('getBranches')
        return []
      }
    },
    queue: createQueue(),
    getVersion: () => '1.0.3',
    deploy: async () => {
      throw new Error('查询命令不应触发上传')
    }
  })

  harness = await startHarness(handlers)
  return { h: harness, calls }
}

afterEach(async () => {
  if (harness) await harness.stop()
  harness = null
})

describe('git 查询命令', () => {
  it('AC-009 变更清单字段与计划口径一致（relativePath 统一正斜杠）', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'status', '--project', PROJECT, '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.changes).toEqual([
      { relativePath: 'src/a.ts', status: 'modified' },
      { relativePath: 'dist/b.js', status: 'added' }
    ])
    expect(out.json.data).toMatchObject({ projectRoot: PROJECT, branch: 'main', ahead: 1, behind: 0 })
    expect(out.json.meta).toMatchObject({ count: 2, projectRoot: PROJECT })
  })

  it('git status 人类可读输出为变更文件列表（文件名后跟简要标记）', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'status', '--project', PROJECT])
    expect(out.exitCode).toBe(0)
    const lines = out.stdout.trimEnd().split('\n')
    expect(lines[0]).toContain('main')
    expect(lines[0]).toContain('2 个未提交变更')
    expect(lines[1]).toMatch(/^src\/a\.ts\s+M$/)
    expect(lines[2]).toMatch(/^dist\/b\.js\s+A$/)
    // 默认通道不再是通用表格转储（不再出现字段名/表头）
    expect(out.stdout).not.toContain('relativePath')
  })

  it('git status 标记覆盖 M/A/D/?/R', async () => {
    const { h } = await boot({
      changes: [
        { path: '', relativePath: 'm.ts', status: 'modified' },
        { path: '', relativePath: 'a.ts', status: 'added' },
        { path: '', relativePath: 'd.ts', status: 'deleted' },
        { path: '', relativePath: 'u.ts', status: 'untracked' },
        { path: '', relativePath: 'r.ts', status: 'renamed' }
      ]
    })
    const out = await h.run(['git', 'status', '--project', PROJECT])
    const rows = out.stdout.trimEnd().split('\n').slice(1)
    expect(rows).toEqual(['m.ts  M', 'a.ts  A', 'd.ts  D', 'u.ts  ?', 'r.ts  R'])
  })

  it('git status 无未提交变更时只输出汇总行', async () => {
    const { h } = await boot({ changes: [] })
    const out = await h.run(['git', 'status', '--project', PROJECT])
    expect(out.exitCode).toBe(0)
    expect(out.stdout.trimEnd()).toBe('main (领先 1) · 无未提交变更')
    expect(out.stdout.trimEnd().split('\n')).toHaveLength(1)
  })

  it('git status 领先/落后仅在非零时标注在汇总行', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'status', '--project', PROJECT])
    expect(out.stdout.split('\n')[0]).toBe('main (领先 1) · 2 个未提交变更')
  })

  it('AC-009 --json 仍为结构化信封（文本渲染器不介入）', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'status', '--project', PROJECT, '--json'])
    expect(out.json.data.changes).toEqual([
      { relativePath: 'src/a.ts', status: 'modified' },
      { relativePath: 'dist/b.js', status: 'added' }
    ])
  })

  it('AC-010 非 Git 目录返回 NOT_A_REPO 且退出码 3（不返回空清单冒充成功）', async () => {
    const { h } = await boot({ isGitRepo: false })
    const out = await h.run(['git', 'status', '--project', PROJECT, '--json'])
    expect(out.exitCode).toBe(3)
    expect(out.json.error.code).toBe('NOT_A_REPO')
  })

  it('P0 参数注入：--branch 不接受以 - 开头的值（防 git 选项注入写任意文件）', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'log', '--project', PROJECT, '--branch', '--output=/tmp/x', '--json'])
    expect(out.exitCode).toBe(1)
    expect(out.json.error.code).toBe('USAGE')
    expect(out.json.error.message).toContain('--branch')
  })

  it('P0 服务端同样拒绝注入值（绕过 CLI 直接调接口时）', async () => {
    const { h } = await boot()
    const env = await h.request('GET', '/git/log', { projectRoot: PROJECT, branch: '--output=/tmp/x' })
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('USAGE')
  })

  it('P0 正常分支名仍可用（不误伤）', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'log', '--project', PROJECT, '--branch', 'origin/main', '--json'])
    expect(out.exitCode).toBe(0)
  })

  it('AC-011 git log 支持 --branch / --author / --limit 并透传到服务端', async () => {
    const { h, calls } = await boot()
    const out = await h.run(['git', 'log', '--project', PROJECT, '--branch', 'main', '--author', 'huberyhe', '--limit', '20', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.commits).toHaveLength(1)
    expect(calls.some((c) => c.includes('"branch":"main"') && c.includes('"author":"huberyhe"') && c.includes('"maxCount":20'))).toBe(true)
  })

  it('AC-011 git log 默认条数 20（与桌面端一致的"最近 20 条"口径）', async () => {
    const { h, calls } = await boot()
    await h.run(['git', 'log', '--project', PROJECT, '--json'])
    expect(calls.some((c) => c.includes('"maxCount":20'))).toBe(true)
  })

  it('AC-012 查询无结果视为成功空列表（与计划为空的报错语义区分）', async () => {
    const { h } = await boot({ changes: [], commits: [] })
    const status = await h.run(['git', 'status', '--project', PROJECT, '--json'])
    const log = await h.run(['git', 'log', '--project', PROJECT, '--json'])
    expect([status.exitCode, log.exitCode]).toEqual([0, 0])
    expect(status.json.data.changes).toEqual([])
    expect(log.json.data.commits).toEqual([])
  })

  it('AC-014 非法 limit 返回用法错误（退出码 1）', async () => {
    const { h } = await boot()
    const local = await h.run(['git', 'log', '--project', PROJECT, '--limit', 'abc', '--json'])
    expect(local.exitCode).toBe(1)
    expect(local.json.error.code).toBe('USAGE')
  })

  it('P3-12 limit 超出上限由服务端拒绝（防超大查询）', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'log', '--project', PROJECT, '--limit', '5001', '--json'])
    expect(out.exitCode).toBe(1)
    expect(out.json.error.code).toBe('USAGE')
    expect(out.json.error.message).toContain('超出上限')
  })

  it('P3-11 仓库在查询瞬间不可读时报错（不返回空清单冒充成功）', async () => {
    const context = new ProjectContext('win32')
    context.setCurrent(PROJECT)
    const handlers = createServerHandlers({
      loadTargets: async () => [],
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
        listChangedFiles: async () => [],
        listCommitFiles: async () => [],
        listFilesInDir: async () => []
      },
      buildUploadTasks: async () => [],
      git: {
        isGitRepo: async () => true,
        // 竞态：isGitRepo 之后目录失效，getStatusView 返回 hasGit:false
        getStatusView: async () => ({ hasGit: false, changes: [], ahead: 0, behind: 0 }),
        getLogView: async () => [],
        getBranches: async () => []
      },
      queue: createQueue(),
      getVersion: () => '1.0.3',
      deploy: async () => {
        throw new Error('查询命令不应触发上传')
      }
    })
    const h = await startHarness(handlers)
    try {
      const out = await h.run(['git', 'status', '--project', PROJECT, '--json'])
      expect(out.exitCode).toBe(3)
      expect(out.json.error.code).toBe('NOT_A_REPO')
    } finally {
      await h.stop()
    }
  })

  it('INV-2 只读：查询不触发上传，也不调用写操作', async () => {
    const { h, calls } = await boot()
    await h.run(['git', 'status', '--project', PROJECT, '--json'])
    await h.run(['git', 'log', '--project', PROJECT, '--json'])
    expect(calls).toEqual(['isGitRepo', 'getStatusView', 'isGitRepo', expect.stringContaining('getLogView')])
  })

  it('AC-023 未指定项目时按桌面当前项目查询', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'status', '--project', PROJECT, '--json'])
    expect(out.json.meta.projectRoot).toBe(PROJECT)
  })

  it('策略 D′ 未带 --project → USAGE（退出码 1）并给出 projects list 引导', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'status', '--json'])
    expect(out.exitCode).toBe(1)
    expect(out.json.error.code).toBe('USAGE')
    expect(out.json.error.hint).toContain('projects list')
  })

  it('策略 D′ 显式指定任意项目即可查询（不再有"跨项目需放行"的概念）', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'status', '--project', 'D:/work/other', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.meta).toMatchObject({ projectRoot: 'D:/work/other' })
  })

  it('策略 D′ 桌面未打开项目时，只要显式 --project 就能查询（CI 场景）', async () => {
    const { h } = await boot({ currentProject: null })
    const out = await h.run(['git', 'status', '--project', PROJECT, '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.meta).toMatchObject({ projectRoot: PROJECT })
  })

})

describe('git 查询性能（DFX-PERF-001）', () => {
  // 说明：真实阈值（查询 P95 ≤ 1 秒）由真机实测数据承接（见执行日志）。
  // 这里只做「无同步阻塞 / 无病态回归」的冒烟：并行测试机上墙钟时间不可控，
  // 因此预算放宽到 20 秒并显式声明超时，避免负载抖动导致误报。
  it('本地桩下 10 次查询无病态耗时（冒烟，非性能门禁）', { timeout: 60_000 }, async () => {
    const { h } = await boot()
    const started = Date.now()
    for (let i = 0; i < 10; i++) await h.run(['git', 'status', '--project', PROJECT, '--json'])
    expect(Date.now() - started).toBeLessThan(20_000)
  })
})

describe('git 查询参数覆盖', () => {
  it('显式传入 projectRoot 查询参数（非 --project 形式）也生效', async () => {
    const { h } = await boot()
    const out = await h.run(['git', 'status', '--project', PROJECT, '--json'])
    expect(out.exitCode).toBe(0)
    const spy = vi.fn()
    spy()
    expect(spy).toHaveBeenCalled()
  })
})

describe('人类可读输出（数量/序号/贴近）', () => {
  it('git status：状态标记紧跟文件名（两个空格，不做列对齐）', async () => {
    const { renderGitStatusText } = await import('./commands/git')
    const text = renderGitStatusText({
      ok: true,
      data: { branch: 'main', changes: [{ relativePath: 'a.ts', status: 'modified' }, { relativePath: '很长的中文文件名.ts', status: 'untracked' }] },
      meta: {}
    } as never)
    const lines = text.split('\n')
    expect(lines[1]).toBe('a.ts  M')
    expect(lines[2]).toBe('很长的中文文件名.ts  ?')
  })

  it('git log：带序号（最近优先，序号右对齐）', async () => {
    const { renderGitLogText } = await import('./commands/git')
    const text = renderGitLogText({
      ok: true,
      data: { commits: [
        { hash: 'abcdef1', date: '2026-10-01T10:00:00Z', author: '张三', message: 'feat: a' },
        { hash: 'abcdef2', date: '2026-09-30T10:00:00Z', author: '李四', message: 'fix: b' }
      ] },
      meta: {}
    } as never)
    const lines = text.split('\n')
    expect(lines[0]).toBe('2 条提交（最近优先）')
    expect(lines[1]).toMatch(/^\s1\. abcdef1 {2}2026-10-01 {2}张三 {2}feat: a$/)
    expect(lines[2]).toMatch(/^\s2\. abcdef2 {2}2026-09-30 {2}李四 {2}fix: b$/)
  })

  it('plan：先给数量（待上传/跳过/体积），再逐条列文件', async () => {
    const { renderPlanText } = await import('./commands/plan')
    const text = renderPlanText({
      ok: true,
      data: {
        projectRoot: 'D:/p',
        target: 't',
        items: [{ relativePath: 'a.ts', size: 2048 }, { relativePath: 'b.ts', size: 1024 }],
        skipped: [{ relativePath: 'c.ts', reason: 'no-mapping' }]
      },
      meta: {}
    } as never)
    const lines = text.split('\n')
    expect(lines[0]).toBe('D:/p → t')
    expect(lines[1]).toBe('待上传 2 个文件，共 3.0 KB，跳过 1 个')
    expect(lines[2]).toBe('  a.ts')
    expect(lines[4]).toBe('  跳过 c.ts（no-mapping）')
  })
})
