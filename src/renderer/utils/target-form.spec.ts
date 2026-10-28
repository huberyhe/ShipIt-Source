/**
 * 目标表单校验的回归用例（纯函数，node 环境可跑）。
 *
 * 覆盖点：缺项顺序与协议分支、脚本/命令二选一、空白的判定、红框按 key 映射、
 * 提示文案去重、测试结果回退文案。
 */
import { describe, expect, it } from 'vitest'
import { invalidFrom, missingFields, testResultHint, validationMessage, type TargetFormInput } from './target-form'

const base = (over: Partial<TargetFormInput> = {}): TargetFormInput => ({
  name: 'dev',
  host: 'ftp.example.com',
  username: 'root',
  protocol: 'sftp',
  postUploadKind: 'none',
  postUploadScript: '',
  postUploadCommand: '',
  ...over
})

describe('missingFields', () => {
  it('sftp 全空：名称、主机、用户名，顺序稳定', () => {
    const missing = missingFields({ ...base(), name: '', host: '', username: '' })
    expect(missing.map((f) => f.label)).toEqual(['名称', '主机', '用户名'])
  })

  it('local 协议：不要求用户名，主机文案是「本地根目录」', () => {
    const missing = missingFields(base({ protocol: 'local', host: '', username: '' }))
    expect(missing.map((f) => f.label)).toEqual(['本地根目录'])
  })

  it('选了脚本但内容为空 → 多出「脚本文件」', () => {
    const missing = missingFields(base({ postUploadKind: 'script', postUploadScript: '   ' }))
    expect(missing.map((f) => f.label)).toEqual(['脚本文件'])
  })

  it('选了命令但内容为空 → 多出「命令」', () => {
    const missing = missingFields(base({ postUploadKind: 'command', postUploadCommand: '' }))
    expect(missing).toEqual([{ key: 'postUpload', label: '命令' }])
  })

  it('不执行时：脚本/命令为空也不报', () => {
    expect(missingFields(base({ postUploadKind: 'none' }))).toEqual([])
  })

  it('纯空白按缺项处理（与 trim 一致）', () => {
    expect(missingFields(base({ name: '   ' })).map((f) => f.key)).toEqual(['name'])
  })
})

describe('invalidFrom', () => {
  it('按 key 映射红框，与文案无关', () => {
    const invalid = invalidFrom([{ key: 'host', label: '本地根目录' }])
    expect(invalid).toEqual({ name: false, host: true, username: false, postUpload: false })
  })

  it('脚本与命令都归到 postUpload 一个位上（互斥，不会同时出现）', () => {
    expect(invalidFrom([{ key: 'postUpload', label: '脚本文件' }]).postUpload).toBe(true)
    expect(invalidFrom([{ key: 'postUpload', label: '命令' }]).postUpload).toBe(true)
  })
})

describe('validationMessage', () => {
  it('无缺项返回 null（不显示提示）', () => {
    expect(validationMessage([])).toBeNull()
  })

  it('拼接文案并按文案去重（脚本+命令不会同时出现，防御性保留）', () => {
    expect(validationMessage([{ key: 'name', label: '名称' }, { key: 'postUpload', label: '命令' }])).toBe(
      '请填写必填项：名称、命令'
    )
  })
})

describe('testResultHint', () => {
  it('成功', () => {
    expect(testResultHint({ success: true })).toEqual({ tone: 'success', text: '连接成功', title: '连接成功' })
  })

  it('失败但无原因时回退「连接失败」', () => {
    expect(testResultHint({ success: false }).text).toBe('连接失败')
  })

  it('失败带原因时原样展示', () => {
    expect(testResultHint({ success: false, error: '连接被拒绝' })).toEqual({
      tone: 'error',
      text: '连接被拒绝',
      title: '连接被拒绝'
    })
  })
})
