import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { errEnvelope, okEnvelope } from '../shared/cli-contract'
import type { ClientResult } from '../shared/http-client'
import { createEmbeddedAdapter, createRemoteAdapter, unwrapEnvelope } from './ipc-adapter'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir (): string {
  const dir = mkdtempSync(join(tmpdir(), 'shipit-adapter-'))
  dirs.push(dir)
  return dir
}

describe('main/ipc-adapter', () => {
  it('embedded：文件树与配置读走进程内服务', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.txt'), 'hello')

    const adapter = createEmbeddedAdapter({
      files: {
        buildTree: async (root) => ({ name: 'root', path: root, children: [] }),
        expandDirectory: async () => [],
        collectFilesForUpload: async () => []
      },
      git: {
        hasAnyRepository: async () => true,
        getBranches: async () => [],
        getAuthors: async () => [],
        getStatusView: async () => ({ changes: [] }),
        getLogView: async () => [],
        getFileDiff: async () => '',
        getCommitFiles: async () => []
      },
      configStore: {
        load: async () => ({ deploymentTargets: [{ name: 'dev' }] }),
        patchOwned: async () => undefined,
        addTarget: async () => undefined,
        updateTarget: async () => undefined,
        removeTarget: async () => undefined,
        reorderTargets: async () => undefined,
        addMapping: async () => undefined,
        updateMapping: async () => undefined,
        removeMapping: async () => undefined
      },
      serverConfig: async () => ({ enabled: false }),
      serverStatus: () => ({ listening: false }),
      serverConfigSave: async () => ({ enabled: false }),
      serverTokenRotate: async () => ({ token: 'new' }),
      serverExport: async () => ({ port: 4517 })
    })

    expect(await adapter.filesTree(dir)).toMatchObject({ name: 'root' })
    expect(await adapter.targetList()).toEqual([{ name: 'dev' }])
    expect(await adapter.serverStatus()).toEqual({ listening: false })
    expect(await adapter.configSave({ theme: 'dark' })).toEqual({ deploymentTargets: [{ name: 'dev' }] })
    expect(await adapter.targetRemove('t1')).toBeNull()
  })

  it('remote：返回数据解包，失败抛带 code 的 Error', async () => {
    const ok = (data: unknown): ClientResult => ({ ok: true, envelope: okEnvelope(data) })
    const fail = (code: string, message: string): ClientResult => ({
      ok: true,
      envelope: errEnvelope(code as never, message)
    })

    const adapter = createRemoteAdapter({
      get: async (path) => {
        if (path === '/git/status') return ok({ changes: [{ relativePath: 'a.ts' }] })
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
