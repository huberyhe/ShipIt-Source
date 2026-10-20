/**
 * 选择语义的最小回归集。
 *
 * 这些用例覆盖的正是两棵树曾经各自写错的地方：
 * 区间右端、锚点是否被覆盖、Ctrl+Shift 优先级、锚点消失时的退化、去重键大小写。
 */
import { describe, expect, it } from 'vitest'
import { reduceSelection, resolveSelectionMode, selectionKey, type SelectionState } from './selection'

const empty: SelectionState = { paths: [], anchor: null }
const ORDER = ['A', 'B', 'C', 'D']

describe('resolveSelectionMode', () => {
  it('Shift 优先于 Ctrl（两棵树必须一致）', () => {
    expect(resolveSelectionMode({ shiftKey: true, ctrlKey: true })).toBe('range')
    expect(resolveSelectionMode({ shiftKey: true })).toBe('range')
    expect(resolveSelectionMode({ ctrlKey: true })).toBe('toggle')
    expect(resolveSelectionMode({ metaKey: true })).toBe('toggle')
    expect(resolveSelectionMode({})).toBe('replace')
  })
})

describe('reduceSelection', () => {
  it('replace：替换选区并把锚点设到点击项', () => {
    expect(reduceSelection({ paths: ['X'], anchor: 'X' }, { path: 'B', mode: 'replace' })).toEqual({
      paths: ['B'],
      anchor: 'B'
    })
  })

  it('toggle：加入 / 移除，锚点跟随点击项', () => {
    const on = reduceSelection(empty, { path: 'B', mode: 'toggle' })
    expect(on).toEqual({ paths: ['B'], anchor: 'B' })
    const multi = reduceSelection(on, { path: 'D', mode: 'toggle' })
    expect(multi).toEqual({ paths: ['B', 'D'], anchor: 'D' })
    expect(reduceSelection(multi, { path: 'B', mode: 'toggle' })).toEqual({ paths: ['D'], anchor: 'B' })
  })

  it('range：从锚点到点击行（正向与反向结果相同）', () => {
    const state: SelectionState = { paths: ['B'], anchor: 'B' }
    expect(reduceSelection(state, { path: 'D', mode: 'range', order: ORDER }).paths).toEqual(['B', 'C', 'D'])
    expect(reduceSelection({ paths: ['D'], anchor: 'D' }, { path: 'B', mode: 'range', order: ORDER }).paths).toEqual([
      'B',
      'C',
      'D'
    ])
  })

  it('range：连续 Shift 保持锚点（伸缩而不是重新开始）', () => {
    const first = reduceSelection({ paths: ['B'], anchor: 'B' }, { path: 'D', mode: 'range', order: ORDER })
    expect(first.anchor).toBe('B')
    const second = reduceSelection(first, { path: 'C', mode: 'range', order: ORDER })
    expect(second.paths).toEqual(['B', 'C'])
    expect(second.anchor).toBe('B')
  })

  it('range：无锚点 / 锚点不可见 → 退化为单选（不产生错误区间）', () => {
    expect(reduceSelection(empty, { path: 'C', mode: 'range', order: ORDER })).toEqual({ paths: ['C'], anchor: 'C' })
    expect(
      reduceSelection({ paths: ['Z'], anchor: 'Z' }, { path: 'C', mode: 'range', order: ORDER })
    ).toEqual({ paths: ['C'], anchor: 'C' })
  })
})

describe('selectionKey', () => {
  it('分隔符与 Windows 大小写归一（跨视图去重口径一致）', () => {
    expect(selectionKey('D:\\Work\\App\\a.ts', 'win32')).toBe('d:/work/app/a.ts')
    expect(selectionKey('D:/Work/App/a.ts', 'win32')).toBe('d:/work/app/a.ts')
    expect(selectionKey('/srv/App/a.ts', 'linux')).toBe('/srv/App/a.ts')
  })
})
