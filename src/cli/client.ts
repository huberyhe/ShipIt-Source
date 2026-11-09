/**
 * CLI / MCP 客户端薄壳。
 *
 * 实现已提取到 `src/shared/http-client.ts`（桌面 main 也复用同一份）；
 * 本文件只保留 CLI/MCP 的既有导出与调用形态，行为不变。
 */
import type { ClientKind } from '../shared/cli-contract'
import { createHttpClient, type HttpClient } from '../shared/http-client'
import type { DiscoveredConnection } from './discover'

export type {
  ClientError,
  ClientResult,
  ClientEndpoint,
  HttpClient,
  HttpClientOptions,
  Query
} from '../shared/http-client'
export { toEnvelope } from '../shared/http-client'

/** CLI/MCP 视角的客户端：在通用客户端之上保留发现结果（用于展示来源与排障） */
export interface ServerClient extends HttpClient {
  readonly connection: DiscoveredConnection
}

/** 由已发现的连接创建客户端（导出与调用点保持不变） */
export function createServerClient (options: {
  connection: DiscoveredConnection
  client: ClientKind
  timeoutMs?: number
}): ServerClient {
  const client = createHttpClient({
    endpoint: {
      host: options.connection.host,
      port: options.connection.port,
      token: options.connection.token,
      fingerprint: options.connection.fingerprint,
      protocolVersion: options.connection.protocolVersion,
      source: options.connection.source,
      file: options.connection.file
    },
    client: options.client,
    timeoutMs: options.timeoutMs
  })
  return Object.assign(client, { connection: options.connection })
}
