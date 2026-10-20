/**
 * 文档完整性用例（任务 16 / DFX-DEP-005）。
 *
 * 文档是交付物：命令面、服务端开关、跨机器注意事项与排查表必须与实现同步，
 * 缺失或过期即让用例失败，避免「代码改了文档没改」。
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { BOOL_FLAGS, COMMANDS, helpText, VALUE_FLAGS } from './args'
import { mcpToolNames } from './mcp-tools'

const ROOT = join(__dirname, '..', '..')
const doc = readFileSync(join(ROOT, 'docs', 'CLI-README.md'), 'utf-8')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf-8')
const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf-8')

describe('使用文档（DFX-DEP-005）', () => {
  it('P3 回归 每个 CLI 命令与参数都在文档里出现过（与 args.ts 同源，防漂移）', () => {
    const text = doc + readme

    for (const command of COMMANDS) {
      expect(text).toContain(command)
    }
    // `-h` 只是 --help 的别名，文档里不需要单列
    for (const flag of [...VALUE_FLAGS, ...BOOL_FLAGS].filter((f) => f !== '-h')) {
      expect(text).toContain(flag)
    }
  })

  it('P3 回归 deploy 的全部取值型参数都写进了文档（防文档漂移）', () => {
    const text = doc + readme
    for (const flag of ['--wait-timeout', '--expect-files', '--files', '--dir', '--all-changed', '--last-commit']) {
      expect(text).toContain(flag)
    }
  })

  it('文档覆盖命令面与服务端开关说明', () => {
    for (const token of [
      'shipit deploy',
      'shipit mcp',
      'shipit plan',
      'shipit status',
      'shipit task',
      '--wait-timeout',
      '--all-changed',
      '开启本地服务',
      '指纹',
      '令牌'
    ]) {
      expect(doc).toContain(token)
    }
  })

  it('文档列出全部退出码与常见错误类别', () => {
    for (const token of ['`BACKEND_UNAVAILABLE`', '`PROTOCOL_MISMATCH`', '`INVALID_TOKEN`', '`TLS_MISMATCH`', '`PARTIAL`']) {
      expect(doc).toContain(token)
    }
    expect(doc).toContain('| 2 | 部分失败')
    expect(doc).toContain('| 4 | 配置与目标类')
  })

  it('文档给出三种安装形态（随包入口 / npx / MCP 宿主配置）', () => {
    expect(doc).toContain('<安装目录>/cli/index.js')
    expect(doc).toContain('npx @huberyhe/shipit-mcp')
    expect(doc).toContain('mcpServers')
  })

  it('文档说明凭据明文风险与跨机器注意事项', () => {
    expect(doc).toContain('含令牌明文')
    expect(doc).toContain('项目与文件都在服务端所在机器')
  })

  it('文档覆盖端口占用与指纹变更排查', () => {
    expect(doc).toContain('PORT_IN_USE')
    expect(doc).toContain('证书轮换')
  })

  it('文档与 CLI 帮助口径一致（命令面未漂移）', () => {
    // 顶层帮助只列**命令名**（动作与参数下移到各命令帮助，避免顶层过长）；
    // 因此这里检查：顶层列命令，且每个命令的帮助里给出其全部动作。
    const top = helpText()
    const actions: Record<string, readonly string[]> = {
      targets: ['targets list', 'targets show', 'targets ping'],
      projects: ['projects list'],
      git: ['git status', 'git log']
    }
    for (const [command, list] of Object.entries(actions)) {
      expect(top, command).toContain(command)
      const one = helpText(command)
      for (const action of list) {
        expect(one, action).toContain(action.split(' ')[1])
        expect(doc, action).toContain(action)
      }
    }
    for (const command of ['plan', 'deploy', 'status', 'task', 'mcp']) {
      expect(top, command).toContain(command)
      expect(helpText(command), command).toContain('用法：')
      expect(doc, command).toContain(`shipit ${command}`)
    }
    // 顶层要给出"如何查看某命令帮助"的入口（否则用户找不到详细参数）
    expect(top).toContain('shipit help <命令>')
    expect(doc).toContain('shipit help')
  })

  it('文档与 MCP 工具集口径一致（9 项未漂移）', () => {
    for (const tool of mcpToolNames()) {
      expect(doc).toContain(tool)
    }
    expect(mcpToolNames()).toHaveLength(9)
  })

  it('README 提供 CLI / MCP 入口说明并链接使用文档', () => {
    expect(readme).toContain('## CLI 与 MCP（agent 接入）')
    expect(readme).toContain('docs/CLI-README.md')
    expect(readme).toContain('@huberyhe/shipit-mcp')
  })

  it('CLAUDE.md 记录 CLI / 服务端约定（执行位置、契约来源、发布）', () => {
    expect(claude).toContain('## CLI / MCP 与服务端约定')
    expect(claude).toContain('src/main/services/server-handlers.ts')
    expect(claude).toContain('npm run publish:cli')
  })
})
