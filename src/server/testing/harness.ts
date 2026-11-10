/** 后端进程测试基座：spawn 真实 dist-server，按 type 等待 ready。 */
import { fork, type ChildProcess } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHttpClient, type ClientResult, type HttpClient } from '../../shared/http-client'

export function withTimeout<T> (promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms))
  ])
}

export interface SpawnOptions {
  appVersion?: string
  enabled?: boolean
  parentPid?: number
  entry?: string
}

export interface ServerProcess {
  child: ChildProcess
  dataDir: string
  configPath: string
  ready: any
  states: any[]
  client: HttpClient
  waitExit(ms: number): Promise<number>
  close(): Promise<void>
}

export async function spawnServer (options: SpawnOptions = {}): Promise<ServerProcess> {
  const dir = mkdtempSync(join(tmpdir(), 'shipit-srv-'))
  const configPath = join(dir, 'deploy-config.json')
  writeFileSync(configPath, JSON.stringify({
    server: {
      enabled: options.enabled ?? false,
      port: 0,
      bind: 'local',
      tokenMode: 'custom',
      token: '0123456789abcdef'
    }
  }))

  const entry = options.entry ?? join(process.cwd(), 'dist-server/index.js')
  const child = fork(
    entry,
    [
      '--config', configPath,
      '--app-version', options.appVersion ?? '0.0.0',
      '--data-dir', dir,
      '--parent-pid', String(options.parentPid ?? process.pid)
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  )

  const states: any[] = []
  const ready = await withTimeout(new Promise<any>((resolve, reject) => {
    let buffer = ''
    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          try {
            const message = JSON.parse(line)
            if (message.type === 'ready') resolve(message)
            else if (message.type === 'state') states.push(message)
            else if (message.type === 'fatal') reject(new Error(message.message))
          } catch {
            // 忽略非 JSON 行
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    child.stderr!.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))
    child.once('exit', (code) => reject(new Error(`后端提前退出（code=${code}）`)))
  }), 8000, 'ready')

  const client = createHttpClient({
    endpoint: {
      host: '127.0.0.1',
      port: ready.admin.port,
      token: ready.admin.token,
      fingerprint: ready.admin.fingerprint,
      protocolVersion: 1
    },
    client: 'cli'
  })

  // 提取成局部函数：写在对象字面量里时，async 方法内的 `this` 会被推断成
  // `ServerProcess | PromiseLike<ServerProcess>`（Promise resolve 的 thenable 上下文），
  // 导致 `this.waitExit` 在类型层面不存在。
  const waitExit = (ms: number): Promise<number> =>
    withTimeout(new Promise<number>((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode)
      child.once('exit', (code) => resolve(code ?? -1))
    }), ms, 'exit')

  return {
    child,
    dataDir: dir,
    configPath,
    ready,
    states,
    client,
    waitExit,
    async close () {
      child.kill()
      await waitExit(5000).catch(() => -1)
    }
  }
}

export type { ClientResult }
