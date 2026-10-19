/**
 * 渲染层 deploy store（P3 回归）：日志去重与条数上限。
 * 主进程侧有 50 条上限，前端此前没有 —— 长会话会无限增长。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DeployLogEntry } from '../../shared/types'
import { useDeployStore } from './deploy'

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
