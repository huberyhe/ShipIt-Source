/**
 * CLI 测试基座：启动一个真实 TLS 服务端，并按连接发现路径驱动 CLI。
 *
 * 目的：命令级用例走真实 HTTP/TLS 与真实信封，避免用桩掩盖契约问题。
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLocalServer, type Handlers, type LocalServer } from '../../main/services/local-server'
import { defaultServerConfig } from '../../main/services/server-config'
import type { Envelope } from '../../shared/cli-contract'
import { createServerClient, toEnvelope } from '../client'
import { runCli } from '../index'

import { PROTOCOL_VERSION } from '../../shared/cli-contract'

export const TEST_TOKEN = '0123456789abcdef'

export interface Harness {
  dataDir: string
  port: number
  fingerprint: string
  /** 监听状态引用：供服务端状态处理器读取（随服务启动/停止更新） */
  runtime: RuntimeRef
  /** 运行 CLI（通过 SHIPIT_HOME 指向测试数据目录，模拟零配置发现） */
  run(argv: string[]): Promise<RunOutput>
  /** 直接以 CLI 客户端身份请求服务端：用于构造 CLI 无法表达的输入（如服务端侧校验） */
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Envelope>
  stop(): Promise<void>
}

export interface RunOutput {
  exitCode: number
  stdout: string
  stderr: string
  /** stdout 或 stderr 中的 JSON 信封（解析不到为 null） */
  json: any
}

export interface RuntimeRef {
  listening: boolean
  port: number | null
  bound: string
}

/** 处理器工厂：需要读取监听状态时用工厂形式（fn 内用 rt() 取实时值） */
export type HandlersSource = Partial<Handlers> | ((rt: () => RuntimeRef) => Partial<Handlers>)

/** 启动测试服务端（可注入处理器；未注入的接口按「未启用」处理） */
export async function startHarness(source: HandlersSource = {}): Promise<Harness> {
  const runtime: RuntimeRef = { listening: false, port: null, bound: '' }
  const handlers: Partial<Handlers> = typeof source === 'function' ? source(() => runtime) : source
  const dataDir = mkdtempSync(join(tmpdir(), 'shipit-harness-'))
  const server: LocalServer = createLocalServer({
    config: { ...defaultServerConfig(), enabled: true, port: 0, tokenMode: 'custom', token: TEST_TOKEN },
    dataDir,
    handlers
  })
  const started = await server.start()
  if (!started.listening) {
    rmSync(dataDir, { recursive: true, force: true })
    throw new Error(`测试服务端启动失败：${started.error?.message ?? '未知原因'}`)
  }

  runtime.listening = true
  runtime.port = started.port
  runtime.bound = started.bound

  return {
    dataDir,
    port: started.port,
    fingerprint: started.fingerprint,
    runtime,
    async run(argv: string[]): Promise<RunOutput> {
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await runCli(argv, {
        env: { SHIPIT_HOME: dataDir },
        io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) }
      })
      const outText = stdout.join('')
      const errText = stderr.join('')
      let json: any = null
      for (const text of [outText, errText]) {
        const trimmed = text.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          json = JSON.parse(trimmed)
        } catch {
          /* 非 JSON 输出，忽略 */
        }
      }
      return { exitCode, stdout: outText, stderr: errText, json }
    },
    async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Envelope> {
      const client = createServerClient({
        connection: {
          port: started.port,
          token: TEST_TOKEN,
          protocolVersion: PROTOCOL_VERSION,
          fingerprint: started.fingerprint,
          source: 'shipit-home',
          file: join(dataDir, 'server.json')
        },
        client: 'cli'
      })
      const result = method === 'POST' ? await client.post(path, body) : await client.get(path)
      return toEnvelope(result)
    },

    async stop(): Promise<void> {
      runtime.listening = false
      runtime.port = null
      await server.stop().catch(() => undefined)
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}
