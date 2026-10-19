/**
 * 变更状态映射的回归用例。
 *
 * 这层是纯函数：两套历史词汇表（单词 / git 字母）都在这里收敛，
 * 任何一侧改动（新增状态、改短标记）都必须先让这里通过。
 */
import { describe, expect, it } from 'vitest'
import { statusClassOf, statusShort } from './change-status'

describe('change-status', () => {
  it('单词与 git 字母给出一致的短标记', () => {
    expect(statusShort('modified')).toBe('M')
    expect(statusShort('M')).toBe('M')
    expect(statusShort('added')).toBe('A')
    expect(statusShort('A')).toBe('A')
    expect(statusShort('deleted')).toBe('D')
    expect(statusShort('untracked')).toBe('?')
    expect(statusShort('?')).toBe('?')
    expect(statusShort('renamed')).toBe('R')
    expect(statusShort('R')).toBe('R')
  })

  it('大小写不敏感', () => {
    expect(statusShort('modified')).toBe(statusShort('MODIFIED'))
    expect(statusClassOf('m')).toBe('status-modified')
  })

  it('类名统一为 status-*（两套视图共用一套 CSS）', () => {
    expect(statusClassOf('modified')).toBe('status-modified')
    expect(statusClassOf('A')).toBe('status-added')
    expect(statusClassOf('D')).toBe('status-deleted')
    expect(statusClassOf('renamed')).toBe('status-renamed')
    expect(statusClassOf('?')).toBe('status-untracked')
  })

  it('未知取值不猜：短标记原样、类名为空串', () => {
    expect(statusShort('copied')).toBe('copied')
    expect(statusClassOf('copied')).toBe('')
  })
})
