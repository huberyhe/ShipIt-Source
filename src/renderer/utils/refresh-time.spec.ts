import { describe, expect, it } from 'vitest'
import { formatClock, formatRefreshAge, formatStamp } from './refresh-time'

/** 固定基准时刻，避免用例依赖真实时钟 */
const NOW = new Date(2026, 10, 6, 15, 30, 0) // 2026-11-06 15:30:00

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms)
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatRefreshAge（表头刷新时间文案）', () => {
  it('1 分钟内都是「刚刚刷新」', () => {
    expect(formatRefreshAge(ago(0), NOW)).toBe('刚刚刷新')
    expect(formatRefreshAge(ago(59 * SECOND), NOW)).toBe('刚刚刷新')
  })

  it('满 1 分钟进位到分钟，按整数分钟向下取整', () => {
    expect(formatRefreshAge(ago(MINUTE), NOW)).toBe('1分钟前刷新')
    expect(formatRefreshAge(ago(2 * MINUTE), NOW)).toBe('2分钟前刷新')
    expect(formatRefreshAge(ago(125 * SECOND), NOW)).toBe('2分钟前刷新')
    expect(formatRefreshAge(ago(59 * MINUTE + 59 * SECOND), NOW)).toBe('59分钟前刷新')
  })

  it('满 1 小时进位到小时', () => {
    expect(formatRefreshAge(ago(HOUR), NOW)).toBe('1小时前刷新')
    expect(formatRefreshAge(ago(5 * HOUR), NOW)).toBe('5小时前刷新')
    expect(formatRefreshAge(ago(23 * HOUR + 59 * MINUTE), NOW)).toBe('23小时前刷新')
  })

  it('满 1 天进位到天', () => {
    expect(formatRefreshAge(ago(DAY), NOW)).toBe('1天前刷新')
    expect(formatRefreshAge(ago(29 * DAY), NOW)).toBe('29天前刷新')
  })

  it('超过 30 天改说日期（相对时长已无新鲜度含义）', () => {
    expect(formatRefreshAge(ago(30 * DAY), NOW)).toBe('2026-10-07 刷新')
  })

  it('未来时刻（时钟回拨）按刚刚处理，不出现负数', () => {
    expect(formatRefreshAge(new Date(NOW.getTime() + 5 * MINUTE), NOW)).toBe('刚刚刷新')
  })
})

describe('formatStamp / formatClock（精确时刻）', () => {
  it('补零到秒，并带完整日期', () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4, 5))).toBe('03:04:05')
    expect(formatStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05')
  })
})
