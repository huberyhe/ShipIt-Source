/**
 * MCP stdio server（`shipit mcp`）。
 *
 * - 工具集与 CLI 命令一一对应（CON-9 / AC-030），实现在 `mcp-tools.ts`（可离线测试）。
 * - 常驻进程：每次工具调用前重读连接信息，令牌或指纹变化时重读一次并重试一次（AC-029）。
 * - stdout 只用于 MCP 协议消息，诊断信息一律写 stderr。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Envelope } from '../shared/cli-contract'
import { createServerClient } from './client'
import { discoverConnection } from './discover'
import { callTool, MCP_TOOLS, type McpConnectionProvider } from './mcp-tools'
import { preflightProvider } from './preflight'
import { exitCodeOf } from '../shared/cli-contract'
import { packageVersion } from './version'

export const MCP_SERVER_NAME = 'shipit'

/** 连接提供者：每次调用前重读连接信息文件并新建客户端 */
export function createStdioProvider(
  env: Record<string, string | undefined>,
  /** 建连参数（`--connect` / `--profile` 等）：MCP 与 CLI 共用同一套连接发现 */
  args: readonly string[] = []
): McpConnectionProvider {
  return {
    async connect() {
      const discovered = discoverConnection({ env, args })
      if (!discovered.ok) return { ok: false, error: discovered.error }
      return { ok: true, client: createServerClient({ connection: discovered.connection, client: 'mcp' }) }
    }
  }
}

/** 工具调用结果 → MCP 文本内容（结构化信封原样返回，CON-2） */
export function toMcpResult(envelope: Envelope): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError: !envelope.ok
  }
}

export function createMcpServer(provider: McpConnectionProvider): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: packageVersion() },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: `${tool.description}（对应 CLI：shipit ${tool.cli}）`,
      inputSchema: tool.inputSchema
    }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const envelope = await callTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      provider
    )
    return toMcpResult(envelope)
  })

  return server
}

/**
 * 以 stdio 启动 MCP server（长期运行直到对端关闭）。
 *
 * **启动前必须预检**：连不上 / 认证不过 / 协议版本不一致 → 把失败信封写 stderr 并以非零码退出。
 * 这样 MCP 宿主能立刻看到"服务不可用"，而不是以为已就绪、等第一次工具调用才失败
 * （对宿主与用户都更糟：表现为"工具调了没反应"）。
 *
 * 返回值即进程退出码（0 = 已就绪并开始服务）。
 */
export async function runMcpServer(
  env: Record<string, string | undefined>,
  args: readonly string[] = [],
  io: { stderr: (text: string) => void } = { stderr: (text) => process.stderr.write(`${text}\n`) }
): Promise<number> {
  const provider = createStdioProvider(env, args)

  const ready = await preflightProvider(provider)
  if (!ready.ok) {
    // stdout 只能有协议消息，因此诊断一律走 stderr（宿主通常会把 stderr 展示给用户）
    io.stderr(`[shipit mcp] 启动失败：${ready.error.message}`)
    if (ready.error.hint) io.stderr(`[shipit mcp] 提示：${ready.error.hint}`)
    io.stderr(JSON.stringify(ready.envelope))
    return exitCodeOf(ready.error.code)
  }
  io.stderr(`[shipit mcp] 已连接桌面版 ${ready.serverVersion}（协议 v${ready.protocolVersion}）`)

  const server = createMcpServer(provider)
  await server.connect(new StdioServerTransport())
  return 0
}