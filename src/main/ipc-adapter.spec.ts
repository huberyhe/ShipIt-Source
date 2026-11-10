import { describe, expect, it } from 'vitest'
import { errEnvelope, okEnvelope } from '../shared/cli-contract'
import type { ClientResult } from '../shared/http-client'
import { createRemoteAdapter, unwrapEnvelope } from './ipc-adapter'

describe('main/ipc-adapter', () => {
  it('remote：返回数据解包，失败抛带 code 的 Error', async () => {
    const ok = (data: unknown): ClientResult => ({ ok: true, envelope: okEnvelope(data) })
    const fail = (code: string, message: string): ClientResult => ({
      ok: true,
      envelope: errEnvelope(code as never, message)
    })

    const adapter = createRemoteAdapter({
      get: async (path) => {
        if (path === '/git/status-full') return ok({ changes: [{ relativePath: 'a.ts' }] })
        if (path === '/config') return ok({ deploymentTargets: [{ name: 'dev' }] })
        if (path === '/server/config') return fail('BACKEND_UNAVAILABLE', '服务未发布')
        return ok(null)
      },
      post: async (path) => {
        if (path === '/files/tree') return ok({ name: 'root' })
        return ok(null)
      }
    })

    expect(await adapter.gitStatus('D:/proj')).toMatchObject({ changes: [{ relativePath: 'a.ts' }] })
    expect(await adapter.filesTree('D:/proj')).toMatchObject({ name: 'root' })
    expect(await adapter.targetList()).toEqual([{ name: 'dev' }])

    await expect(adapter.serverConfig()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
  })

  it('unwrapEnvelope：传输失败与服务端失败都抛错', () => {
    expect(() => unwrapEnvelope({ ok: false, error: { code: 'TLS_MISMATCH', message: 'x' } })).toThrow()
    expect(() => unwrapEnvelope({ ok: true, envelope: errEnvelope('USAGE', 'bad') })).toThrow()
    expect(unwrapEnvelope({ ok: true, envelope: okEnvelope({ a: 1 }) })).toEqual({ a: 1 })
  })
})
