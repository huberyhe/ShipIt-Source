import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeAllowedRoots } from './allowed-roots'

/**
 * 回归背景：本模块曾被渲染层调用时抛 `ReferenceError: process is not defined`
 * （默认参数写成 `process.platform`），导致设置页「点确定毫无反应」。
 * 这里模拟"没有 process 的渲染层"，确保模块跨进程可用。
 */
describe('normalizeAllowedRoots（跨进程安全）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('没有 process（渲染层）时不抛错，并按平台信息归一化', () => {
    vi.stubGlobal('process', undefined)
    expect(() => normalizeAllowedRoots(['  D:\\dist\\  '])).not.toThrow()
    // Windows 下去重忽略大小写（与主进程口径一致）
    const win = normalizeAllowedRoots(['D:/x', 'd:/X'], 'win32')
    expect(win).toEqual(['D:/x'])
    // 非 Windows 保留大小写差异
    const linux = normalizeAllowedRoots(['/a', '/A'], 'linux')
    expect(linux).toEqual(['/a', '/A'])
  })

  it('没有 process 且 UA 像 Windows 时按 win32 处理（保住大小写不敏感）', () => {
    vi.stubGlobal('process', undefined)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(normalizeAllowedRoots(['D:/x', 'd:/X'])).toEqual(['D:/x'])
  })

  it('基础归一化：trim / 反斜杠转正斜杠 / 去尾分隔符 / 纯分隔符归为根', () => {
    expect(normalizeAllowedRoots(['  D:\\a\\ ', 'D:/a', '///', ''])).toEqual(['D:/a', '/'])
  })
})
