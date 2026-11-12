/**
 * 渲染层 deploy store（P3 回归）：日志去重与条数上限。
 * 主进程侧有 50 条上限，前端此前没有 —— 长会话会无限增长。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DeployLogEntry } from '../../shared/types'
import { skipReasonText, summarizeSkips, useDeployStore } from './deploy'

let deliver: ((entry: DeployLogEntry) => void) | null = null

const entry = (taskId: string): DeployLogEntry => ({
  taskId,
  targetName: 'my_dev',
  timestamp: 1,
  totalFiles: 1,
  succeeded: 1,
  failed: 0,
  skipped: 0,
  duration: 1,
  details: [],
  origin: 'cli'
})

beforeEach(() => {
  setActivePinia(createPinia())
  deliver = null
  // 渲染层只用 window.deployApi 做订阅，这里给最小桩即可（无需 jsdom）
  ;(globalThis as unknown as { window: unknown }).window = {
    deployApi: {
      onDeployLogEntry: (callback: (e: DeployLogEntry) => void) => {
        deliver = callback
      },
      onDeployProgress: () => undefined,
      dispatchEvent: () => true
    }
  }
})

/**
 * 预览→确认链路：跳过项必须直接取主进程的判定结果（含真实原因）。
 *
 * 背景：此前用「所选 − 可上传」求差集，原因永远是 null → 已删除的 Git 变更文件
 * 被 UI 说成「未匹配目录映射」（假原因，PRODUCT 原则 4 不允许）。
 */
describe('deploy store：预览采用服务端 skipped', () => {
  const root = 'D:/work/app'
  const targetStub = {
    id: 't1',
    name: 'dev',
    protocol: 'local',
    host: 'D:/dest',
    port: 0,
    username: '',
    mappings: [{ id: 'm1', localPrefix: 'dist/', remotePath: '/out' }]
  }

  function stubPreview(previewDeployFiles: (files: string[], projectRoot: string, target: unknown) => Promise<unknown>) {
    ;(globalThis as unknown as { window: unknown }).window = {
      deployApi: {
        getTargetList: async () => [targetStub],
        loadConfig: async () => ({}),
        previewDeployFiles,
        onDeployLogEntry: () => undefined,
        onDeployProgress: () => undefined,
        dispatchEvent: () => true
      }
    }
  }

  it('服务端给出的 relativePath + reason 原样落到 confirmSkipped（不再差集猜测）', async () => {
    stubPreview(async () => ({
      tasks: [{ localPath: `${root}/dist/a.js`, remotePath: '/out/a.js', relativePath: 'dist/a.js', size: 2 }],
      skipped: [
        { relativePath: 'dist/gone.js', reason: 'missing' },
        { relativePath: 'README.md', reason: 'no-mapping' },
        { relativePath: '../outside/x.js', reason: 'outside-project' }
      ]
    }))

    const store = useDeployStore()
    await store.loadTargets()
    await store.previewDeploy([`${root}/dist/a.js`, `${root}/dist/gone.js`, `${root}/README.md`, `${root}/../outside/x.js`], root)

    expect(store.confirmFiles.map((f) => f.relativePath)).toEqual(['dist/a.js'])
    expect(store.confirmSkipped).toEqual([
      { relativePath: 'dist/gone.js', reason: 'missing' },
      { relativePath: 'README.md', reason: 'no-mapping' },
      { relativePath: '../outside/x.js', reason: 'outside-project' }
    ])
  })

  it('原因文案能区分「无映射」与「文件不存在」（UI 逐条展示与 0 文件说明同源）', () => {
    expect(skipReasonText('missing')).toBe('文件不存在（已删除或未提交）')
    expect(skipReasonText('no-mapping')).toBe('未匹配目录映射')
    expect(skipReasonText('outside-project')).toBe('不在项目目录内')
    expect(skipReasonText('symlink')).toBe('是符号链接，不上传（不跟随链接）')
    expect(skipReasonText(null)).toBe('原因未知')
    expect(summarizeSkips([
      { relativePath: 'a', reason: 'missing' },
      { relativePath: 'b', reason: 'no-mapping' },
      { relativePath: 'c', reason: 'no-mapping' }
    ])).toBe('2 个未匹配目录映射，1 个文件不存在（已删除或未提交）')
    // 链接不是「原因未知」：它有明确原因，且必须能被用户看懂（否则会以为被随机跳过）
    expect(summarizeSkips([
      { relativePath: 'dist/link', reason: 'symlink' },
      { relativePath: 'dist/a', reason: 'missing' }
    ])).toBe('1 个文件不存在（已删除或未提交），1 个是符号链接')
    expect(summarizeSkips([])).toBe('')
  })

  it('兼容旧版返回（只回 UploadTask[]）：不崩，也不编造跳过原因', async () => {
    stubPreview(async () => [
      { localPath: `${root}/dist/a.js`, remotePath: '/out/a.js', relativePath: 'dist/a.js', size: 2 }
    ])

    const store = useDeployStore()
    await store.loadTargets()
    await store.previewDeploy([`${root}/dist/a.js`, `${root}/README.md`], root)

    expect(store.confirmFiles).toHaveLength(1)
    expect(store.confirmSkipped).toEqual([])
  })
})

describe('deploy store（P3 回归）', () => {
  it('同一 taskId 去重，且最多保留 50 条（最新在前）', () => {
    const store = useDeployStore()
    store.listenServerDeployLogs()
    expect(deliver).toBeTypeOf('function')

    deliver?.(entry('T1'))
    deliver?.(entry('T1'))
    expect(store.deployLogs).toHaveLength(1)

    for (let i = 0; i < 60; i++) deliver?.(entry(`X${i}`))

    expect(store.deployLogs).toHaveLength(50)
    expect(store.deployLogs[0].taskId).toBe('X59')
    expect(store.deployLogs.some((log) => log.taskId === 'T1')).toBe(false)
  })
})
