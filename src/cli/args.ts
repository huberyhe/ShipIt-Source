/**
 * CLI 参数解析（命令面为兼容契约，CON-1 / D-23）。
 *
 * 规则：
 * - 子命令组仅在存在多个动作时使用（`targets list|show`、`git status|log|branches`）；
 *   单动作为叶子命令（`plan`、`deploy`、`status`、`task`、`mcp`）。
 * - 未知命令/未知参数/选择器冲突/参数缺值一律返回 USAGE（零副作用，AC-014）。
 * - 不接受裸端口与裸令牌（CON-7，由连接发现统一拒绝）。
 */
import type { ErrorCode, Selector } from '../shared/cli-contract'
import { isSafeGitRev } from '../shared/git-rev'
import { displayWidth, padEndDisplay } from './text'

export type { Selector }

export type CommandName =
  | 'targets'
  | 'projects'
  | 'plan'
  | 'deploy'
  | 'git'
  | 'status'
  | 'task'
  | 'mcp'
  | 'help'

export const DEFAULT_WAIT_TIMEOUT_SECONDS = 300

/** git log 条数上限（与服务端一致，避免超大查询） */
export const MAX_LOG_LIMIT = 5000

export interface ParseError {
  code: ErrorCode
  message: string
  hint?: string
}

export interface ParsedArgs {
  command: CommandName | null
  /** 子命令组内的动作；单动作命令为 null */
  action: string | null
  /** 位置参数（targets show 的目标名、task 的任务 ID） */
  positionals: string[]
  json: boolean
  target: string | null
  project: string | null
  profile: string | null
  connect: string | null
  wait: boolean
  waitTimeoutSeconds: number
  selector: Selector | null
  /** deploy：只允许上传这一组文件（与 plan 结果比对，防计划之后集合漂移） */
  expectFiles: string[] | null
  branch: string | null
  author: string | null
  limit: number | null
  /** `shipit <组> --help` 时记录组名（帮助只显示该组） */
  helpGroup: string | null
  /** 存在即为用法错误（解析失败） */
  error?: ParseError
}

/** 全部命令（导出供文档核对） */
export const COMMANDS: readonly CommandName[] = [
  'targets',
  'plan',
  'deploy',
  'git',
  'status',
  'task',
  'projects',
  'mcp',
  'help'
]

const GIT_ACTIONS = ['status', 'log'] as const
const PROJECTS_ACTIONS = ['list'] as const

/**
 * 需要项目根的命令（策略 D′：**必须显式指定**）。
 * 用于 CLI 侧快速失败（服务端同样校验，作为 MCP / HTTP 的权威边界）。
 */
export const PROJECT_REQUIRED_COMMANDS: readonly string[] = ['plan', 'deploy', 'git status', 'git log']
const TARGETS_ACTIONS = ['list', 'show', 'ping'] as const

/** 取值型全局/命令参数：命令前的这类参数需要连带吃掉其取值（导出供文档核对） */
export const VALUE_FLAGS = new Set([
  '--target',
  '--project',
  '--profile',
  '--connect',
  '--wait-timeout',
  '--expect-files',
  '--files',
  '--dir',
  '--branch',
  '--author',
  '--limit'
])

/** 布尔型全局/命令参数（导出供文档核对） */
export const BOOL_FLAGS = new Set(['--json', '--wait', '--all-changed', '--last-commit', '--help', '-h'])

const flagName = (token: string): string => (token.includes('=') ? token.slice(0, token.indexOf('=')) : token)

function usage(message: string, hint?: string): ParseError {
  return hint ? { code: 'USAGE', message, hint } : { code: 'USAGE', message }
}

/**
 * 帮助文本（DFX-USE-001）。
 *
 * 段落用数据描述、按**显示宽度**对齐（中文占 2 列），避免手工空格在增删条目后走样。
 */
/** 子命令组 → 可用动作（帮助与解析共用同一张表） */
const SUBCOMMAND_GROUPS: Record<string, readonly string[]> = {
  targets: TARGETS_ACTIONS,
  git: GIT_ACTIONS,
  projects: PROJECTS_ACTIONS
}

/** 帮助里的一个参数/条目分组 */
type HelpGroup = { title: string; entries: ReadonlyArray<readonly [string, string]> }

/** 单条命令的详细帮助（`shipit help <命令>` / `shipit <命令> --help`） */
interface CommandHelp {
  /** 一行简述（顶层列表也用这句） */
  summary: string
  /** 用法行（不含 `shipit ` 前缀，便于统一缩进） */
  usage: string
  /** 该命令独有的参数分组 */
  params?: readonly HelpGroup[]
  /** 说明（前置条件、行为约定） */
  notes?: readonly string[]
  examples?: readonly string[]
}

/** 帮助内容与命令一一对应（新增命令时一并补上，`help` 的用法行不会与实现漂移） */
const COMMAND_HELP: Record<string, CommandHelp> = {
  targets: {
    summary: '上传目标：列表 / 查看 / 连通性测试',
    usage: 'targets list | targets show <目标名> | targets ping <目标名>',
    notes: ['输出不含密码 / 私钥等凭据（凭据仅在被使用时经主进程读取）。'],
    examples: ['shipit targets list', 'shipit targets show my_dev', 'shipit targets ping my_dev']
  },
  plan: {
    summary: '生成待上传计划（不建立远端连接）',
    usage: 'plan --project <项目根> --target <目标名> [选择器]',
    notes: [
      '计划阶段只做本地路径解析与映射匹配，不会连接远端（可安全地先看计划）。',
      '先给数量（待上传 / 跳过 / 体积），再逐条列文件。'
    ],
    examples: [
      'shipit plan --project D:/proj --target my_dev --all-changed',
      'shipit plan --project D:/proj --target my_dev --dir manage'
    ]
  },
  deploy: {
    summary: '提交上传任务（默认异步）',
    usage: 'deploy --project <项目根> --target <目标名> [选择器] [--wait]',
    notes: [
      '默认异步：立刻返回任务 ID，用 `shipit task <任务ID>` 查询进度。',
      '加 `--wait` 等任务结束再返回（结果与退出码按成功/部分失败/失败区分）。',
      '上传任务之间串行执行（同一时刻只跑一个，避免互相抢占远端）。'
    ],
    examples: [
      'shipit deploy --project D:/proj --target my_dev --all-changed',
      'shipit deploy --project D:/proj --target my_dev --files dist/a.js --wait'
    ]
  },
  git: {
    summary: '未提交变更 / 提交历史（只读）',
    usage: 'git status | git log --project <项目根> [--branch <分支>] [--author <提交者>] [--limit <条数>]',
    notes: [
      '`git status`：变更清单，状态标记紧跟文件名（两空格）。',
      '`git log`：默认最近 20 条，带序号；`--limit` 上限 5000。',
      '分支 / 提交者 / hash 参数按白名单校验（首字符不能是 `-`，避免被 git 当成选项）。'
    ],
    examples: [
      'shipit git status --project D:/proj',
      'shipit git log --project D:/proj --limit 5',
      'shipit git log --project D:/proj --branch main --author 张三'
    ]
  },
  status: {
    summary: '服务端状态与版本',
    usage: 'status',
    notes: ['不要求项目根：用于确认桌面版是否在跑、监听端口、队列与当前项目。'],
    examples: ['shipit status', 'shipit status --json']
  },
  projects: {
    summary: '桌面当前已打开的项目',
    usage: 'projects list',
    notes: ['`--project` 到底该填什么时，先看这里（多项目下不会猜"当前项目"）。'],
    examples: ['shipit projects list']
  },
  task: {
    summary: '查询上传任务',
    usage: 'task <任务ID>',
    examples: ['shipit task 3f6c1c2e-8a4b-4c1d-9f2e-2b7a1d0c9e01']
  },
  mcp: {
    summary: '以 stdio 启动 MCP server（供 agent 接入）',
    usage: 'mcp',
    examples: [
      'shipit mcp',
      'npx -y @huberyhe/shipit-mcp mcp   # 宿主里可直接这样拉起',
      'shipit mcp --connect \'{"host":"192.168.1.20","port":4517,"token":"…","protocolVersion":1,"fingerprint":"…"}\''
    ],
    params: [
      {
        title: 'MCP 宿主配置（示例）',
        entries: [
          ['command', 'npx'],
          ['args', '["-y", "@huberyhe/shipit-mcp", "mcp"]']
        ]
      },
      {
        title: '远端连接（跨机器 / 非默认数据目录）',
        entries: [
          ['--connect <连接串>', '桌面版「导出连接串」复制的单行 JSON（含 host/port/token/fingerprint）'],
          ['--profile <名称>', '本机保存的连接配置：<SHIPIT_HOME>/profiles/<名称>.json（未设时 Windows 为 %APPDATA%\\shipit）']
        ]
      },
      {
        title: '暴露的工具（9 个）',
        entries: [
          ['list_targets', '列出上传目标（不含凭据）'],
          ['list_projects', '列出桌面已打开的项目（拿 projectRoot 用）'],
          ['ping_targets', '测试目标连通性'],
          ['plan_deploy', '生成上传计划'],
          ['deploy', '提交上传任务'],
          ['task_status', '查询任务'],
          ['git_status', '未提交变更'],
          ['git_log', '提交历史'],
          ['server_status', '服务端状态']
        ]
      }
    ]
  }
}

/** 顶层帮助里的命令分类（顺序即展示顺序） */
const COMMAND_CATEGORIES: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  { title: '上传流程', commands: ['targets', 'plan', 'deploy'] },
  { title: '查询', commands: ['git', 'status', 'projects', 'task'] },
  { title: '集成', commands: ['mcp'] }
]

/** 顶层帮助里的"常用参数"（完整参数在各命令的 help 里） */
const COMMON_PARAMS: readonly (readonly [string, string])[] = [
  ['--project <项目根>', 'plan / deploy / git 必填（多项目下务必显式指定）'],
  ['--target <目标名>', 'plan / deploy 必填'],
  ['--json', '输出机器可读信封（失败也是信封，退出码不变）'],
  ['--profile / --connect', '远端连接配置（本机保存的 / 直接给连接串）']
]

/** 选择器：plan 与 deploy 共用（互斥，缺省按当前变更） */
const SELECTOR_GROUP: HelpGroup = {
  title: '选择器（plan / deploy 共用，互斥，缺省按当前变更）',
  entries: [
    ['--all-changed', '全部未提交变更'],
    ['--files <路径[,路径]>', '显式文件集合'],
    ['--dir <目录>', '目录'],
    ['--last-commit', '最近一次提交']
  ]
}

function renderGroups(lines: string[], groups: readonly HelpGroup[]): void {
  for (const group of groups) {
    lines.push('', group.title + '：')
    const width = group.entries.reduce((max, [label]) => Math.max(max, displayWidth(label)), 0)
    for (const [label, desc] of group.entries) lines.push('  ' + padEndDisplay(label, width + 2) + desc)
  }
}

/**
 * 帮助文本。
 *
 * @param topic 命令名（`git`、`mcp`…）或子命令组名：给定时只输出该命令的详细用法；
 *              未给定时输出顶层总览（命令按用途分类，并指向 `shipit help <命令>`）。
 */
export function helpText(topic?: string): string {
  const command = topic && COMMAND_HELP[topic] ? topic : undefined
  if (command) return commandHelpText(command, COMMAND_HELP[command])
  if (topic) {
    // 只给了组名但没有独立帮助（理论上不该发生）：退回顶层 + 一行提示
    return ['未找到该命令的帮助：' + topic, '', helpText()].join('\n')
  }
  return topLevelHelpText()
}

function topLevelHelpText(): string {
  const lines = [
    'ShipIt CLI —— 通过本机桌面版执行部署与查询',
    '',
    '用法：',
    '  shipit <命令> [动作] [参数]',
    '  shipit help <命令>               查看某个命令的完整用法（例：shipit help mcp）',
    '  shipit <命令> --help             等价写法'
  ]
  for (const category of COMMAND_CATEGORIES) {
    lines.push('', category.title + '：')
    const rows = category.commands.map((name) => [name, COMMAND_HELP[name]?.summary ?? ''] as const)
    const width = rows.reduce((max, [label]) => Math.max(max, displayWidth(label)), 0)
    for (const [label, desc] of rows) lines.push('  ' + padEndDisplay(label, width + 2) + desc)
  }
  renderGroups(lines, [{ title: '常用参数（完整参数用 shipit help <命令>）', entries: COMMON_PARAMS }])
  lines.push('', '示例：')
  for (const example of [
    'shipit status                          # 桌面版在跑吗',
    'shipit targets list                    # 有哪些上传目标',
    'shipit projects list                   # 该给 --project 填什么',
    'shipit plan --project D:/proj --target my_dev --all-changed',
    'shipit deploy --project D:/proj --target my_dev --wait',
    'shipit mcp                             # 供 agent 接入（见 shipit help mcp）'
  ]) {
    lines.push('  ' + example)
  }
  return lines.join('\n')
}

function commandHelpText(name: string, help: CommandHelp): string {
  const lines = [`${name} —— ${help.summary}`, '', '用法：', `  shipit ${help.usage}`]
  if (help.params) renderGroups(lines, help.params)
  if (name === 'plan' || name === 'deploy') renderGroups(lines, [SELECTOR_GROUP])
  if (name === 'deploy') {
    renderGroups(lines, [
      {
        title: 'deploy 专属参数',
        entries: [
          ['--wait', '等待任务完成后返回结果'],
          ['--wait-timeout <秒>', '等待上限，默认 300'],
          ['--expect-files <路径[,路径]>', '只允许上传这一组文件（与 plan 结果比对，防止集合漂移）']
        ]
      }
    ])
  }
  if (name === 'git') {
    renderGroups(lines, [
      {
        title: 'git log 专属参数',
        entries: [
          ['--branch <分支>', '按分支过滤'],
          ['--author <提交者>', '按提交者过滤'],
          ['--limit <条数>', '默认 20，最大 5000']
        ]
      }
    ])
  }
  renderGroups(lines, [{ title: '通用参数', entries: [
    ['--json', '输出机器可读信封'],
    ['--help', '显示本帮助（等价于 shipit help ' + name + '）']
  ] }])
  if (help.notes?.length) {
    lines.push('', '说明：')
    for (const note of help.notes) lines.push('  · ' + note)
  }
  if (help.examples?.length) {
    lines.push('', '示例：')
    for (const example of help.examples) lines.push('  ' + example)
  }
  return lines.join('\n')
}

function emptyParsed(): ParsedArgs {
  return {
    command: null,
    action: null,
    positionals: [],
    json: false,
    target: null,
    project: null,
      profile: null,
    connect: null,
    wait: false,
    waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
    selector: null,
    expectFiles: null,
    branch: null,
    author: null,
    limit: null,
    helpGroup: null
  }
}

/** 取值型参数：支持 `--key value` 与 `--key=value` */
function takeValue(argv: readonly string[], index: number, name: string): { value?: string; next: number; error?: ParseError } {
  const token = argv[index]
  const eq = token.indexOf('=')
  if (eq >= 0) {
    const value = token.slice(eq + 1)
    if (!value) return { next: index + 1, error: usage(`参数 ${name} 缺少取值`) }
    return { value, next: index + 1 }
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) return { next: index + 1, error: usage(`参数 ${name} 缺少取值`) }
  return { value, next: index + 2 }
}

function positiveInt(raw: string, name: string): { value?: number; error?: ParseError } {
  if (!/^\d+$/.test(raw)) return { error: usage(`参数 ${name} 需为正整数，收到：${raw}`) }
  const value = Number(raw)
  if (value <= 0) return { error: usage(`参数 ${name} 需大于 0，收到：${raw}`) }
  return { value }
}

/** 解析 argv（不含 node 与脚本路径） */
export function parse(argv: readonly string[]): ParsedArgs {
  const result = emptyParsed()
  const args = [...argv]
  // `--json` 先于命令识别：未知命令 / 缺少命令等**早期错误**也要能输出结构化信封，
  // 否则机器调用方传了 --json 却只拿到文本（与参数声明不一致）。
  result.json = args.includes('--json')

  if (args.length === 0) {
    result.command = 'help'
    return result
  }

  // 命令前后的全局参数都支持：先摘出命令之前的全局参数（含其取值），
  // 例如 `shipit --connect conn.json status` 与 `shipit status --connect conn.json` 等价。
  const leading: string[] = []
  let cursor = 0
  while (cursor < args.length) {
    const token = args[cursor]
    const name = flagName(token)
    const known = BOOL_FLAGS.has(name) || VALUE_FLAGS.has(name)
    if (!token.startsWith('-') || !known) break
    if (name === '--help' || name === '-h') {
      result.command = 'help'
      return result
    }
    leading.push(token)
    const takesValue = VALUE_FLAGS.has(name) && !token.includes('=')
    if (takesValue && args[cursor + 1] !== undefined && !args[cursor + 1].startsWith('--')) {
      leading.push(args[cursor + 1])
      cursor += 2
    } else {
      cursor += 1
    }
  }

  const rest = args.slice(cursor)
  const head = rest[0]
  if (head === undefined) {
    result.error = usage('缺少命令', `可用命令：${COMMANDS.filter((c) => c !== 'help').join('、')}`)
    return result
  }
  if (head === 'help') {
    // `shipit help <命令>`：把后续的位置参数当作帮助主题（`shipit help mcp`）
    result.command = 'help'
    const topic = rest.slice(1).find((token) => !token.startsWith('-'))
    if (topic && COMMANDS.includes(topic as CommandName) && topic !== 'help') result.helpGroup = topic
    return result
  }
  if (head.startsWith('-')) {
    result.error = usage(`缺少命令：${head}`, '全局参数需写在命令之前或之后；可用命令：targets、plan、deploy、git、status、task、mcp')
    return result
  }
  if (!COMMANDS.includes(head as CommandName)) {
    result.error = usage(
      `未知命令：${head}`,
      `可用命令：projects list、targets list、targets show、targets ping、plan、deploy、git status、git log、status、task、mcp`
    )
    return result
  }
  result.command = head as CommandName

  // `--help` 出现在任意位置都应当给帮助（如 `shipit targets --help`）：
  // 否则会先被「命令 targets 需要子命令」挡下，用户以为没写帮助
  if (rest.some((token) => token === '--help' || token === '-h')) {
    // `shipit <命令> --help`：只显示该命令的帮助（此前只有三个子命令组能分组，其余落到全量列表）
    result.helpGroup = String(head)
    result.command = 'help'
    return result
  }

  // 命令前的全局参数与命令后的参数一起解析（动作位单独跳过）
  const tokens = [...leading, ...rest.slice(1)]
  /** 动作在 tokens 中的下标（无动作为 -1） */
  let actionIndex = -1
  // 子命令动作（组表见模块级 SUBCOMMAND_GROUPS）
  const groupActions = SUBCOMMAND_GROUPS[String(result.command)]
  if (groupActions) {
    const actions: readonly string[] = groupActions
    const candidate = rest[1]
    if (candidate === undefined || candidate.startsWith('-')) {
      result.error = usage(`命令 ${result.command} 需要子命令（${actions.join(' | ')}）`)
      return result
    }
    if (!actions.includes(candidate)) {
      result.error = usage(`未知子命令：${result.command} ${candidate}`, `可用子命令：${actions.join('、')}`)
      return result
    }
    result.action = candidate
    actionIndex = leading.length
  }

  const filePaths: string[] = []
  let selectorKind: Selector['kind'] | null = null

  const setSelector = (selector: Selector): ParseError | undefined => {
    if (selectorKind !== null) {
      return usage('选择器冲突：--all-changed / --files / --dir / --last-commit 只能给出一个')
    }
    selectorKind = selector.kind
    result.selector = selector
    return undefined
  }

  const rejectUnless = (allowed: CommandName, name: string): ParseError | undefined =>
    result.command === allowed ? undefined : usage(`参数 ${name} 只对 ${allowed} 命令有效`)

  const rejectUnlessOneOf = (allowed: readonly CommandName[], name: string): ParseError | undefined =>
    result.command !== null && allowed.includes(result.command)
      ? undefined
      : usage(`参数 ${name} 只对 ${allowed.join(' / ')} 命令有效`)

  for (let index = 0; index < tokens.length; index++) {
    if (index === actionIndex) continue // 动作位不是参数
    const token = tokens[index]
    const name = flagName(token)

    const booleanFlags = ['--json', '--wait', '--all-changed', '--last-commit', '--help']
    if (booleanFlags.includes(name) && name !== token) {
      // 布尔开关不接受取值（如 --json=true）：静默忽略会掩盖误用
      return { ...result, error: usage(`参数 ${name} 不接受取值：${token}`) }
    }

    switch (name) {
      case '--json':
        result.json = true
        break
      case '--wait': {
        const bad = rejectUnless('deploy', '--wait')
        if (bad) return { ...result, error: bad }
        result.wait = true
        break
      }
      case '--all-changed': {
        const bad = rejectUnlessOneOf(['plan', 'deploy'], '--all-changed')
        if (bad) return { ...result, error: bad }
        const conflict = setSelector({ kind: 'all-changed' })
        if (conflict) return { ...result, error: conflict }
        break
      }
      case '--last-commit': {
        const bad = rejectUnlessOneOf(['plan', 'deploy'], '--last-commit')
        if (bad) return { ...result, error: bad }
        const conflict = setSelector({ kind: 'last-commit' })
        if (conflict) return { ...result, error: conflict }
        break
      }
      case '--target':
      case '--project':
      case '--profile':
      case '--connect':
      case '--wait-timeout':
      case '--expect-files':
      case '--files':
      case '--dir':
      case '--branch':
      case '--author':
      case '--limit': {
        if (name === '--wait-timeout') {
          const bad = rejectUnless('deploy', '--wait-timeout')
          if (bad) return { ...result, error: bad }
        }
        if (name === '--branch' || name === '--author' || name === '--limit') {
          const bad = result.command === 'git' && result.action === 'log' ? undefined : usage(`参数 ${name} 只对 git log 命令有效`)
          if (bad) return { ...result, error: bad }
        }
        if ((name === '--files' || name === '--dir') && result.command !== 'plan' && result.command !== 'deploy') {
          return { ...result, error: usage(`参数 ${name} 只对 plan / deploy 命令有效`) }
        }
        if (name === '--expect-files' && result.command !== 'deploy') {
          return { ...result, error: usage('参数 --expect-files 只对 deploy 命令有效') }
        }

        const taken = takeValue(tokens, index, name)
        if (taken.error) return { ...result, error: taken.error }
        index = taken.next - 1
        const value = taken.value as string

        if (name === '--target') result.target = value
        else if (name === '--project') result.project = value
        else if (name === '--profile') result.profile = value
        else if (name === '--connect') result.connect = value
        else if (name === '--files') {
          const paths = value.split(',').map((p) => p.trim()).filter((p) => p.length > 0)
          // 显式给了 --files 却没有有效路径，不能降级成「当前全部变更」
          if (paths.length === 0) {
            return { ...result, error: usage('参数 --files 需要至少一个路径') }
          }
          filePaths.push(...paths)
        } else if (name === '--expect-files') {
          const paths = value
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
          if (paths.length === 0) {
            return { ...result, error: usage('参数 --expect-files 需要至少一个路径') }
          }
          result.expectFiles = paths
        } else if (name === '--dir') {
          const dir = value.trim()
          if (dir.length === 0) {
            return { ...result, error: usage('参数 --dir 需要非空目录') }
          }
          const conflict = setSelector({ kind: 'dir', path: dir })
          if (conflict) return { ...result, error: conflict }
                   } else if (name === '--branch') {
              // 与"只读查询无副作用"的承诺一致：非法分支名（可能被 git 当成选项，如 --output=<path>）
              // 在 CLI 侧就拒绝，不把它送到服务端
              if (!isSafeGitRev(value)) {
                return { ...result, error: usage('参数 --branch 不是合法的分支名（不得以 - 开头）') }
              }
              result.branch = value
            } else if (name === '--author') {
              if (/[\r\n\u0000]/.test(value)) {
                return { ...result, error: usage('参数 --author 含非法字符（不得包含换行或空字符）') }
              }
              result.author = value
            }
        else if (name === '--limit') {
          const parsed = positiveInt(value, '--limit')
          if (parsed.error) return { ...result, error: parsed.error }
          if ((parsed.value as number) > MAX_LOG_LIMIT) {
            return { ...result, error: usage(`参数 --limit 超出上限（最大 ${MAX_LOG_LIMIT}）`) }
          }
          result.limit = parsed.value as number
        } else if (name === '--wait-timeout') {
          const parsed = positiveInt(value, '--wait-timeout')
          if (parsed.error) return { ...result, error: parsed.error }
          result.waitTimeoutSeconds = parsed.value as number
        }
        break
      }
      case '--help':
      case '-h':
        result.command = 'help'
        return result
      default:
        if (token.startsWith('-')) {
          // 未知参数回显时**遮蔽疑似凭据的值**：`--token=明文` 这类写法会把口令带进 stderr/日志/CI 记录。
        // （裸 --token 会被 CON-7 明确拒绝，但"写错成 --token=xxx"当时会原样回显）
        const masked = /^--(token|password|passwd|secret|key|apikey|api-key|auth)[=:]/i.test(token)
          ? token.replace(/^([^=:]+)[=:].*$/, '$1=<已隐藏>')
          : token
        return { ...result, error: usage(`未知参数：${masked}`, '使用 shipit --help 查看可用命令与参数') }
        }
        result.positionals.push(token)
    }
  }

  if (filePaths.length > 0) {
    const conflict = setSelector({ kind: 'files', paths: filePaths })
    if (conflict) return { ...result, error: conflict }
  }

  // 命令级校验
  switch (result.command) {
    case 'targets':
      if (result.action === 'list' && result.positionals.length > 0) {
        return { ...result, error: usage('targets list 不接受位置参数') }
      }
      if (result.action === 'show' || result.action === 'ping') {
        // 目标名用位置参数给出（与 --target 区分，避免两种写法混淆）
        if (result.target) {
          return { ...result, error: usage(`目标名请用位置参数给出：shipit targets ${result.action} <目标名>`) }
        }
        if (result.positionals.length !== 1) {
          return { ...result, error: usage(`targets ${result.action} 需要且仅需要一个目标名`) }
        }
      }
      break
    case 'plan':
    case 'deploy':
      if (!result.target) {
        return { ...result, error: usage(`${result.command} 需要 --target <目标名>`) }
      }
      // 多余位置参数此前被静默忽略（`shipit deploy --target t dist/` 不报错也不生效）：
      // 对一个会覆盖远端文件的工具，误用必须报用法错误
      if (result.positionals.length > 0) {
        return {
          ...result,
          error: usage(
            `${result.command} 不接受位置参数：${result.positionals.join(' ')}`,
            '文件范围请用 --files <路径[,路径]> 或 --dir <目录> 选择器给出'
          )
        }
      }
      break
    case 'task':
      if (result.positionals.length !== 1) {
        return { ...result, error: usage('task 需要且仅需要一个任务 ID') }
      }
      break
    case 'status':
    case 'mcp':
      if (result.positionals.length > 0) {
        return { ...result, error: usage(`${result.command} 不接受位置参数`) }
      }
      break
    default:
      break
  }

  return result
}
