import { readFileSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnServer, type ServerProcess } from './testing/harness'

const processes: ServerProcess[] = []

afterEach(async () => {
  for (const proc of processes.splice(0)) await proc.close().catch(() => undefined)
})

function targets (proc: ServerProcess): any[] {
  const config = JSON.parse(readFileSync(proc.configPath, 'utf-8'))
  return config.deploymentTargets ?? []
}

describe('F1 凭据编辑契约（A1/A2/A3/A8 的后端断言）', () => {
  it('keep 保留、set 覆盖、clear 清除；切换私钥后密码不共存', async () => {
    const proc = await spawnServer({ enabled: false })
    processes.push(proc)
    const client = proc.client

    // 建目标 + 设置密码
    const added = await client.post('/targets/add', {
      target: { name: 'dev', protocol: 'sftp', host: '127.0.0.1', port: 22, username: 'u', mappings: [] },
      secrets: { password: { op: 'set', value: 'p1' } }
    })
    expect(added.ok && added.envelope.ok).toBe(true)
    expect(targets(proc)[0].password).toBe('p1')

    const id = targets(proc)[0].id

    // A1：只改名 + keep → 密码仍在（原实现的浅 merge 会清空）
    await client.post('/targets/update', {
      id,
      updates: { name: 'dev2' },
      secrets: { password: { op: 'keep' } }
    })
    expect(targets(proc)[0].name).toBe('dev2')
    expect(targets(proc)[0].password).toBe('p1')

    // A2：set 新密码
    await client.post('/targets/update', {
      id,
      updates: {},
      secrets: { password: { op: 'set', value: 'p2' } }
    })
    expect(targets(proc)[0].password).toBe('p2')

    // A3：显式清除
    await client.post('/targets/update', {
      id,
      updates: {},
      secrets: { password: { op: 'clear' } }
    })
    expect(targets(proc)[0].password).toBeUndefined()

    // A8：切到私钥认证（密码 clear + 私钥 set），两者不共存
    await client.post('/targets/update', {
      id,
      updates: { privateKeyPath: '/tmp/id_rsa' },
      secrets: { password: { op: 'clear' } }
    })
    expect(targets(proc)[0].password).toBeUndefined()
    expect(targets(proc)[0].privateKeyPath).toBe('/tmp/id_rsa')

    // A7：任何响应都不回显明文
    const detail = await client.get('/targets/detail', { name: 'dev2' })
    if (!detail.ok || !detail.envelope.ok) throw new Error('detail 应成功')
    const view = detail.envelope.data as Record<string, unknown>
    expect(view.password).toBeUndefined()
    expect(view.hasPassword).toBe(false)
  }, 30_000)
})
