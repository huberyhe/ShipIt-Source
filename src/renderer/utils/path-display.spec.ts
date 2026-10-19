import { describe, expect, it } from 'vitest'
import { shortenPath } from './path-display'

describe('shortenPath（状态栏路径紧凑显示）', () => {
  it('短路径原样返回（含盘符与分隔符风格）', () => {
    expect(shortenPath('D:\\work\\app')).toBe('D:\\work\\app')
    expect(shortenPath('/home/me/app')).toBe('/home/me/app')
  })

  it('长路径保留开头盘符与末尾若干段，中间省略', () => {
    const long = 'D:\\ExtWorkspace\\git_gui\\.agents\\runs\\5a347d58\\work\\e2e\\projA'
    const out = shortenPath(long, { maxChars: 40, keepTail: 2 })
    expect(out).toContain('…')
    expect(out.startsWith('D:\\ExtWorkspace')).toBe(true)
    expect(out.endsWith('e2e\\projA')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(40)
  })

  it('结果长度不超过上限（含单段超长名的兜底）', () => {
    const huge = 'D:/a/' + 'x'.repeat(80) + '/verylongfolder/leaf'
    const out = shortenPath(huge, { maxChars: 30, keepTail: 2 })
    expect(out.length).toBeLessThanOrEqual(30)
    expect(out).toContain('…')
  })

  it('POSIX 与 UNC 路径都能处理', () => {
    const posix = '/Users/someone/very/deep/nested/project/leaf'
    expect(shortenPath(posix, { maxChars: 30, keepTail: 2 })).toMatch(/^\/.*….*leaf$/)
    const unc = '\\\\server\\share\\deep\\nested\\project\\leaf'
    const out = shortenPath(unc, { maxChars: 30, keepTail: 2 })
    expect(out).toContain('…')
    expect(out.endsWith('project\\leaf') || out.endsWith('leaf')).toBe(true)
  })

  it('空值不抛错', () => {
    expect(shortenPath('')).toBe('')
    expect(shortenPath('   ')).toBe('')
  })
})
