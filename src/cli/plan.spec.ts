/**
 * plan 命令级用例（任务 9）：零连接（INV-1）与项目策略 D（INV-10）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectContext } from '../main/services/project-context'
import { createServerHandlers } from '../main/services/server-handlers'
import type { DeployTarget, UploadTask } from '../shared/types'
import { startHarness, type Harness } from './testing/harness'
import { stubServerDeps } from './testing/deps'

const target: DeployTarget = {
  id: 't1',
  name: 'my_dev',
  protocol: 'sftp',
  host: '10.0.0.5',
  port: 22,
  username: 'deployer',
  password: 'secret-password',
  mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/opt/app/dist' }]
}

const PROJECT = 'D:/work/app'

interface BootOptions {
  currentProject?: string | null
  changedFiles?: string[]
  commitFiles?: string[]
  dirFiles?: string[]
  isGitRepo?: boolean
  tasks?: (files: string[], projectRoot: string, target: DeployTarget) => Promise<UploadTask[]>
  exists?: (abs: string) => Promise<boolean>
  onConnect?: () => void
}

let harness: Harness | null = null

async function boot(options: BootOptions = {}): Promise<Harness> {
  const context = new ProjectContext('win32')
  context.setCurrent(options.currentProject === undefined ? PROJECT : options.currentProject)

  const changed = options.changedFiles ?? ['dist/a.js', 'dist/b.css']
  const buildUploadTasks =
    options.tasks ??
    (async (files: string[], projectRoot: string, t: DeployTarget): Promise<UploadTask[]> =>
      files
        .filter((f) => f.replace(/\\/g, '/').includes('/dist/'))
        .map((f) => ({
          localPath: f,
          remotePath: `/opt/app/dist/${f.replace(/\\/g, '/').split('/').pop()}`,
          relativePath: f.replace(/\\/g, '/').replace(`${projectRoot}/`, ''),
          size: 12
        })))

  const handlers = createServerHandlers(
    stubServerDeps({
      loadTargets: async () => [target],
      testConnection: async () => {
        options.onConnect?.()
        return { success: true }
      },
      resolveProject: (input) => context.resolve(input),
      selection: {
        isGitRepo: async () => options.isGitRepo ?? true,
        listChangedFiles: async () => changed,
        listCommitFiles: async () => options.commitFiles ?? ['dist/a.js'],
        listFilesInDir: async () => options.dirFiles ?? [`${PROJECT}/dist/a.js`],
        exists: options.exists
      },
      buildUploadTasks
    })
  )

  harness = await startHarness(handlers)
  return harness
}

afterEach(async () => {
  if (harness) await harness.stop()
  harness = null
})

describe('plan', () => {
  it('AC-005 / DFX-SEC-006 计划阶段不建立远端连接（覆盖前可预检）', async () => {
    const onConnect = vi.fn()
    const h = await boot({ onConnect })
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--json'])
    expect(out.exitCode).toBe(0)
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('AC-005 返回计划项与命中映射，meta 回显项目根', async () => {
    const h = await boot()
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--json'])
    expect(out.json.data.items).toEqual([
      { relativePath: 'dist/a.js', remotePath: '/opt/app/dist/a.js', size: 12, mapping: { localPrefix: 'dist/', remotePath: '/opt/app/dist' } },
      { relativePath: 'dist/b.css', remotePath: '/opt/app/dist/b.css', size: 12, mapping: { localPrefix: 'dist/', remotePath: '/opt/app/dist' } }
    ])
    expect(out.json.meta).toMatchObject({ projectRoot: PROJECT, count: 2 })
  })

  it('AC-006 未命中映射的文件进入跳过集合且不阻断其他文件（INV-3）', async () => {
    const h = await boot({ changedFiles: ['dist/a.js', 'README.md'] })
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.items).toHaveLength(1)
    expect(out.json.data.skipped).toEqual([{ relativePath: 'README.md', reason: 'no-mapping' }])
  })

  it('P3 回归 全部未命中映射时与 deploy 口径一致（EMPTY_SELECTION，明细仍在 data）', async () => {
    const h = await boot({ changedFiles: ['README.md'] })
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--json'])

    expect(out.json.error.code).toBe('EMPTY_SELECTION')
    expect(out.json.data.items).toEqual([])
    expect(out.json.data.skipped).toEqual([{ relativePath: 'README.md', reason: 'no-mapping' }])
  })

  it('P2 回归 不存在的选中文件标 missing（不再一律 no-mapping）', async () => {
    const h = await boot({
      changedFiles: ['dist/a.js', 'README.md', 'src/gone.ts'],
      // src/gone.ts 不存在；README.md 存在但未命中映射
      exists: async (abs) => !abs.includes('gone')
    })

    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--json'])

    expect(out.exitCode).toBe(0)
    expect(out.json.data.skipped).toContainEqual({ relativePath: 'src/gone.ts', reason: 'missing' })
    expect(out.json.data.skipped).toContainEqual({ relativePath: 'README.md', reason: 'no-mapping' })
  })

  it('AC-006 无变更（选择器为空）返回 EMPTY_SELECTION 与退出码 3', async () => {
    const h = await boot({ changedFiles: [] })
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--json'])
    expect(out.exitCode).toBe(3)
    expect(out.json.error.code).toBe('EMPTY_SELECTION')
  })

  it('AC-005 --files 显式文件集合可用（不依赖 Git）', async () => {
    const h = await boot({ isGitRepo: false })
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--files', 'dist/a.js', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.items.map((i: { relativePath: string }) => i.relativePath)).toEqual(['dist/a.js'])
  })

  it('策略 D′ 桌面未打开项目时，显式 --project 仍可生成计划（CI 场景）', async () => {
    const h = await boot({ currentProject: null })
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.meta).toMatchObject({ projectRoot: PROJECT })
  })
  it('AC-002 目标不存在返回 NO_TARGET', async () => {
    const h = await boot()
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'nope', '--json'])
    expect(out.exitCode).toBe(4)
    expect(out.json.error.code).toBe('NO_TARGET')
  })

  it('P1-2 非法选择器返回 USAGE（不降级为“全部变更”）', async () => {
    const h = await boot()
    for (const selector of [{ kind: 'dirs' }, { kind: 'dir', path: '' }, { kind: 'files', paths: [] }, 'files']) {
      const envelope = await h.request('POST', '/plan', { target: 'my_dev', selector, projectRoot: PROJECT })
      expect(envelope.ok, `selector=${JSON.stringify(selector)}`).toBe(false)
      if (envelope.ok) continue
      expect(envelope.error.code).toBe('USAGE')
      expect(envelope.error.message).toContain('选择器非法')
    }

    // 缺省（不传 selector）仍然按当前变更执行，不受影响
    const absent = await h.request('POST', '/plan', { target: 'my_dev', projectRoot: PROJECT })
    expect(absent.ok).toBe(true)
  })

  it('AC-006 --dir 选择器按目录收集文件', async () => {
    const h = await boot({ dirFiles: ['D:/work/app/dist/x.js', 'D:/work/app/dist/y.js'] })
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--dir', 'dist', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.items.map((i: { relativePath: string }) => i.relativePath)).toEqual(['dist/x.js', 'dist/y.js'])
  })

  it('AC-006 --last-commit 选择器取最近一次提交的文件', async () => {
    const h = await boot({ commitFiles: ['dist/a.js'] })
    const out = await h.run(['plan', '--project', PROJECT, '--target', 'my_dev', '--last-commit', '--json'])
    expect(out.exitCode).toBe(0)
    expect(out.json.data.items.map((i: { relativePath: string }) => i.relativePath)).toEqual(['dist/a.js'])
  })
})
