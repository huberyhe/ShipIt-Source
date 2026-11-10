import { describe, expect, it } from 'vitest'
import type { DeployTarget } from '../shared/types'
import { applySecrets, cloneSecrets, mergeDraftTarget, toTargetView } from './target-secrets'

const base: DeployTarget = {
  id: 't1',
  name: 'dev',
  protocol: 'sftp',
  host: '10.0.0.1',
  port: 22,
  username: 'u',
  password: 'secret',
  passphrase: 'pp',
  mappings: []
}

describe('server/target-secrets', () => {
  it('A5：已存目标 + 改主机、密码留空 → 沿用已存密码', () => {
    const merged = mergeDraftTarget(base, { host: '10.0.0.2', password: '' })
    expect(merged.host).toBe('10.0.0.2')
    expect(merged.password).toBe('secret')
    expect(merged.passphrase).toBe('pp')
  })

  it('A6：新目标（无已存）直接使用草稿值', () => {
    const merged = mergeDraftTarget(undefined, { name: 'new', host: '1.2.3.4', password: 'draft' })
    expect(merged.password).toBe('draft')
    expect(merged.host).toBe('1.2.3.4')
  })

  it('草稿里显式填了新密码时以草稿为准', () => {
    const merged = mergeDraftTarget(base, { password: 'new-pass' })
    expect(merged.password).toBe('new-pass')
  })

  it('keep / set / clear 与脱敏视图', () => {
    expect(applySecrets(base, { password: { op: 'keep' } }).password).toBe('secret')
    expect(applySecrets(base, { password: { op: 'set', value: 'x' } }).password).toBe('x')
    expect(applySecrets(base, { password: { op: 'clear' } }).password).toBeUndefined()

    const view = toTargetView(base)
    expect(view.hasPassword).toBe(true)
    expect(view.hasPassphrase).toBe(true)
    // 断言“视图里不再携带凭据”：先转 unknown 再断言索引，否则 TS 会因 TargetView 无索引签名报 TS2352
    const viewAsRecord = view as unknown as Record<string, unknown>
    expect(viewAsRecord.password).toBeUndefined()
    expect(viewAsRecord.passphrase).toBeUndefined()
  })

  it('复制沿用源目标的秘密', () => {
    const cloned = cloneSecrets(base, { ...base, id: 't2', name: 'copy' })
    expect(cloned.password).toBe('secret')
    expect(cloned.passphrase).toBe('pp')
    expect(cloned.name).toBe('copy')
  })
})
