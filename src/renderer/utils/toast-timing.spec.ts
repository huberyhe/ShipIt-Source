import { describe, expect, it } from 'vitest'
import { remainingMs, toastDurationMs } from './toast-timing'

describe('toast 停留时长', () => {
  it('错误提示停留更久（需阅读/复制），成功提示短暂', () => {
    expect(toastDurationMs('error')).toBeGreaterThan(toastDurationMs('success'))
    expect(toastDurationMs('error')).toBe(12_000)
    expect(toastDurationMs('success')).toBe(4_000)
  })

  it('悬停后按剩余时长续时', () => {
    expect(remainingMs(0, 12_000)).toBe(12_000)
    expect(remainingMs(3_000, 12_000)).toBe(9_000)
    expect(remainingMs(12_000, 12_000)).toBe(0)
    expect(remainingMs(20_000, 12_000)).toBe(0) // 已超时不为负
    expect(remainingMs(-100, 12_000)).toBe(12_000) // 异常输入按未计时处理
  })
})
