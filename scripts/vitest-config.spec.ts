/**
 * 测试配置守卫（P2 回归）：并发上限必须对**实际使用的池**生效。
 *
 * 背景：Vitest 2 的默认池是 `forks`。此前只写了 `poolOptions.threads.maxThreads = 6`
 * 而没有声明 `pool: 'threads'`，上限被静默忽略 —— 命令级用例（会起真实 TLS 服务端）
 * 会按机器 CPU 数无上限并行，正是注释里想避免的互相抢资源。
 */
import { describe, expect, it } from 'vitest'
import config from '../vitest.config'

interface TestConfigShape {
  pool?: string
  poolOptions?: Record<string, Record<string, number> | undefined>
  include?: string[]
}

const test = (config as { test?: TestConfigShape }).test ?? {}

describe('vitest 配置（P2 回归）', () => {
  it('显式声明 pool，且只为所选池配置并发参数', () => {
    const pool = test.pool
    expect(['threads', 'forks']).toContain(pool)

    // 只为真正使用的池配置：否则「看起来设置了上限」但实际不生效
    expect(Object.keys(test.poolOptions ?? {})).toEqual([pool])
  })

  it('所选池声明了 worker 上限', () => {
    const pool = test.pool as string
    const options = (test.poolOptions ?? {})[pool]
    const max = pool === 'threads' ? options?.maxThreads : options?.maxForks

    expect(typeof max).toBe('number')
    expect(max as number).toBeGreaterThan(0)
  })

  it('include 同时覆盖 src 与 scripts 下的用例', () => {
    const include = test.include ?? []
    expect(include.some((pattern) => pattern.startsWith('src/'))).toBe(true)
    expect(include.some((pattern) => pattern.startsWith('scripts/'))).toBe(true)
  })
})
