import { describe, expect, it } from 'vitest'
import { userMessage } from './report-error'

describe('userMessage（给用户看的错误文案）', () => {
  it('剥掉 Electron IPC 的包装串', () => {
    const err = new Error(
      "Error invoking remote method 'deploy:upload': Error: Timed out while waiting for handshake"
    )
    const text = userMessage(err)
    expect(text).toContain('连接超时')
    // 不能再把 "remote method" 这种实现细节甩给用户
    expect(text).not.toContain('remote method')
  })

  it('常见 errno 换成人话，并保留原始串供排查', () => {
    expect(userMessage(new Error('connect ECONNREFUSED 10.0.0.1:22'))).toContain('拒绝连接')
    expect(userMessage(new Error('ENOENT: no such file or directory'))).toContain('文件不存在')
    expect(userMessage(new Error('All configured authentication methods failed'))).toContain('认证失败')
  })

  it('未知错误原样返回（不吞掉）', () => {
    expect(userMessage(new Error('目标名已存在：prod'))).toBe('目标名已存在：prod')
  })

  it('空值安全', () => {
    expect(userMessage(undefined)).toBe('')
    expect(userMessage(null)).toBe('')
  })

  it('非 Error 的字符串也能处理', () => {
    expect(userMessage('ECONNRESET')).toContain('连接被中断')
  })
})
