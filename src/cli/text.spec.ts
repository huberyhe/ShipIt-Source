import { describe, expect, it } from 'vitest'
import { displayWidth, padEndDisplay } from './text'

describe('终端显示宽度', () => {
  it('ASCII 与半角字符按 1 列计', () => {
    expect(displayWidth('git status')).toBe(10)
    expect(displayWidth('--connect <v>')).toBe(13)
  })

  it('中文与全角字符按 2 列计', () => {
    expect(displayWidth('目标名')).toBe(6)
    expect(displayWidth('<目标名>')).toBe(8)
    expect(displayWidth('（全角）')).toBe(8)
  })

  it('padEndDisplay 按显示宽度补齐（中英文混排也对齐）', () => {
    expect(padEndDisplay('<目标名>', 12)).toBe('<目标名>    ') // 显示宽度 8 → 补 4
    expect(padEndDisplay('plan', 12)).toBe('plan        ') // 显示宽度 4 → 补 8
    expect(displayWidth(padEndDisplay('<目标名>', 12))).toBe(12)
    expect(displayWidth(padEndDisplay('plan', 12))).toBe(12)
  })

  it('超宽内容不截断也不补负号', () => {
    expect(padEndDisplay('averyveryverylonglabel', 4)).toBe('averyveryverylonglabel')
    expect(padEndDisplay('中文标签很长', 2)).toBe('中文标签很长')
  })
})
