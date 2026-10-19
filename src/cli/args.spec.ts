import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { helpText, parse } from './args'
import { displayWidth } from './text'
import './commands'
import { registeredCommandKeys } from './registry'
import { PROJECT_REQUIRED_COMMANDS } from './args'

describe('args: 命令面（D-23）', () => {
  it('AC-001 targets list 解析出命令与子命令', () => {
    expect(parse(['targets', 'list'])).toMatchObject({ command: 'targets', action: 'list' })
  })

  it('AC-001 targets show 目标名 取位置参数', () => {
    expect(parse(['targets', 'show', 'my_dev'])).toMatchObject({
      command: 'targets',
      action: 'show',
      positionals: ['my_dev']
    })
  })

  it('AC-014 缺少必需参数返回用法错误', () => {
    expect(parse(['deploy']).error?.code).toBe('USAGE')
    expect(parse(['plan']).error?.code).toBe('USAGE')
    expect(parse(['targets', 'show']).error?.code).toBe('USAGE')
    expect(parse(['task']).error?.code).toBe('USAGE')
    expect(parse(['git']).error?.code).toBe('USAGE')
    expect(parse(['targets']).error?.code).toBe('USAGE')
  })

  it('AC-014 未知命令返回用法错误并提示可用命令', () => {
    const r = parse(['frobnicate'])
    expect(r.error?.code).toBe('USAGE')
    expect(r.error?.hint).toContain('targets list')
  })

  it("--json 对早期错误同样生效（未知命令也能拿到信封）", () => {
    const r = parse(["nope", "--json"])
    expect(r.error?.code).toBe("USAGE")
    expect(r.json).toBe(true)
    // 未声明 --json 时不误报为结构化输出
    expect(parse(["nope"]).json).toBe(false)
  })

  it('AC-014 未知参数返回用法错误（不静默忽略）', () => {
    expect(parse(['status', '--nope']).error?.code).toBe('USAGE')
    expect(parse(['status', 'extra']).error?.code).toBe('USAGE')
  })

  it('单动作命令为叶子命令：mcp 不设 serve 层级', () => {
    expect(parse(['mcp'])).toMatchObject({ command: 'mcp', action: null })
  })
})

describe('args: 横切参数', () => {
  it('P3 回归 --help 出现在任意位置都给帮助（不再先被「缺少子命令」挡下）', () => {
    expect(parse(['targets', '--help']).command).toBe('help')
    expect(parse(['targets', 'show', 'dev', '--help']).command).toBe('help')
    expect(parse(['git', '-h']).command).toBe('help')
  })

  it('P3 回归 多余位置参数报用法错误（不再静默忽略）', () => {
    const bad = parse(['deploy', '--target', 'my_dev', 'dist/'])
    expect(bad.error?.code).toBe('USAGE')
    expect(bad.error?.message).toContain('位置参数')
    expect(bad.error?.hint).toContain('--files')

    // 正常用法不受影响
    expect(parse(['plan', '--target', 'my_dev']).error).toBeUndefined()
    expect(parse(['deploy', '--target', 'my_dev', '--wait']).error).toBeUndefined()
  })

  it('P2 回归 --expect-files 只对 deploy 有效，逗号分隔解析为数组', () => {
    const ok = parse(['deploy', '--target', 'my_dev', '--expect-files', 'dist/a.js,dist/b.css'])
    expect(ok.error).toBeUndefined()
    expect(ok.expectFiles).toEqual(['dist/a.js', 'dist/b.css'])

    const empty = parse(['deploy', '--expect-files', ' , '])
    expect(empty.error?.code).toBe('USAGE')

    const wrongCommand = parse(['plan', '--expect-files', 'dist/a.js'])
    expect(wrongCommand.error?.code).toBe('USAGE')
    expect(wrongCommand.error?.message).toContain('deploy')
  })

  it('解析 --json / --target / --project / --profile / --connect', () => {
    const r = parse([
      'plan',
      '--target',
      'my_dev',
      '--project',
      '/repo',
      '--profile',
      'peer',
      '--connect',
      '/tmp/conn.json',
      '--json'
    ])
    expect(r.error).toBeUndefined()
    expect(r).toMatchObject({
      command: 'plan',
      target: 'my_dev',
      project: '/repo',
      profile: 'peer',
      connect: '/tmp/conn.json',
      json: true
    })
  })

  it('P1-4 全局参数可写在命令之前（与文档示例一致）', () => {
    const cases: Array<[string[], Record<string, unknown>]> = [
      [['--connect', '/tmp/conn.json', 'status'], { command: 'status', connect: '/tmp/conn.json' }],
      [['--connect=/tmp/conn.json', 'status', '--json'], { command: 'status', connect: '/tmp/conn.json', json: true }],
      [['--profile', 'peer', 'targets', 'list'], { command: 'targets', action: 'list', profile: 'peer' }],
      [['--json', '--project', '/repo', 'git', 'status'], { command: 'git', action: 'status', project: '/repo', json: true }],
      [['--json', 'targets', 'ping', 'my_dev'], { command: 'targets', action: 'ping', positionals: ['my_dev'], json: true }],
      [['--wait', '--target', 't', 'deploy'], { command: 'deploy', wait: true, target: 't' }],
      [['--json', '--project', '/x', 'plan', '--target', 't'], {
        command: 'plan',
        project: '/x',
        target: 't'
      }]
    ]
    for (const [argv, expected] of cases) {
      const r = parse(argv)
      expect(r.error, argv.join(' ')).toBeUndefined()
      expect(r, argv.join(' ')).toMatchObject(expected)
    }
  })

  it('P1-4 命令前后两种写法等价（同一结果）', () => {
    const before = parse(['--connect', 'c.json', '--json', 'targets', 'show', 'my_dev'])
    const after = parse(['targets', 'show', 'my_dev', '--json', '--connect', 'c.json'])
    expect(before.error).toBeUndefined()
    expect(before.connect).toBe(after.connect)
    expect(before.positionals).toEqual(after.positionals)
    expect(before.action).toBe(after.action)
  })

  it('P1-4 命令前参数取不到值时按用法错误处理', () => {
    expect(parse(['--connect']).error?.code).toBe('USAGE')
    expect(parse(['--profile']).error?.code).toBe('USAGE')
    expect(parse(['--json']).error?.code).toBe('USAGE') // 只有全局开关、没有命令
  })

  it('支持 --key=value 形式', () => {
    const r = parse(['plan', '--target=my_dev', '--project=/repo'])
    expect(r).toMatchObject({ target: 'my_dev', project: '/repo' })
  })

  it('AC-014 --wait 与 --wait-timeout 只对 deploy 有效', () => {
    const ok = parse(['deploy', '--target', 't', '--wait', '--wait-timeout', '60'])
    expect(ok).toMatchObject({ wait: true, waitTimeoutSeconds: 60 })
    expect(parse(['status', '--wait']).error?.code).toBe('USAGE')
  })

  it('AC-014 等待上限默认 300 秒，取值必须为正整数', () => {
    expect(parse(['deploy', '--target', 't']).waitTimeoutSeconds).toBe(300)
    expect(parse(['deploy', '--target', 't', '--wait-timeout', '0']).error?.code).toBe('USAGE')
    expect(parse(['deploy', '--target', 't', '--wait-timeout', 'abc']).error?.code).toBe('USAGE')
  })

  it('AC-014 git log 专用参数只对 git log 有效', () => {
    const r = parse(['git', 'log', '--branch', 'main', '--author', 'me', '--limit', '20'])
    expect(r).toMatchObject({ command: 'git', action: 'log', branch: 'main', author: 'me', limit: 20 })
    expect(parse(['git', 'status', '--branch', 'main']).error?.code).toBe('USAGE')
    expect(parse(['git', 'log', '--limit', 'x']).error?.code).toBe('USAGE')
  })
})

describe('args: 选择器（互斥，缺省不推断）', () => {
  it('支持 all-changed / files / dir / last-commit 四种选择器', () => {
    expect(parse(['deploy', '--target', 't', '--all-changed']).selector).toEqual({ kind: 'all-changed' })
    expect(parse(['deploy', '--target', 't', '--dir', 'dist']).selector).toEqual({ kind: 'dir', path: 'dist' })
    expect(parse(['deploy', '--target', 't', '--last-commit']).selector).toEqual({ kind: 'last-commit' })
    expect(parse(['deploy', '--target', 't', '--files', 'a.txt,b.txt']).selector).toEqual({
      kind: 'files',
      paths: ['a.txt', 'b.txt']
    })
  })

  it('--files 可重复给出并保持顺序', () => {
    expect(parse(['deploy', '--target', 't', '--files', 'a.txt', '--files', 'b.txt']).selector).toEqual({
      kind: 'files',
      paths: ['a.txt', 'b.txt']
    })
  })

  it('P1-2 显式空值的选择器按用法错误处理（不降级为全部变更）', () => {
    for (const argv of [
      ['deploy', '--target', 't', '--files', ''],
      ['deploy', '--target', 't', '--files', ' , '],
      ['plan', '--target', 't', '--dir', ''],
      ['plan', '--target', 't', '--dir', '   ']
    ]) {
      const r = parse(argv)
      expect(r.error?.code, argv.join(' ')).toBe('USAGE')
      expect(r.selector).toBeNull()
    }
  })

  it('P3-12 布尔开关不接受取值（--json=true 之类必须报错）', () => {
    for (const argv of [
      ['status', '--json=true'],
      ['plan', '--target', 't', '--all-changed=1'],
      ['deploy', '--target', 't', '--wait=yes']
    ]) {
      const r = parse(argv)
      expect(r.error?.code, argv.join(' ')).toBe('USAGE')
      expect(r.error?.message).toContain('不接受取值')
    }
  })

  it('P3-12 --limit 超出上限报用法错误', () => {
    expect(parse(['git', 'log', '--limit', '5000']).error).toBeUndefined()
    const r = parse(['git', 'log', '--limit', '5001'])
    expect(r.error?.code).toBe('USAGE')
    expect(r.error?.message).toContain('超出上限')
  })

  it('AC-014 选择器冲突返回用法错误', () => {
    expect(parse(['deploy', '--target', 't', '--all-changed', '--dir', 'dist']).error?.code).toBe('USAGE')
    expect(parse(['plan', '--target', 't', '--files', 'a.txt', '--last-commit']).error?.code).toBe('USAGE')
  })

  it('缺省不推断：未给选择器时为 null，由服务端按当前变更处理', () => {
    expect(parse(['plan', '--target', 't']).selector).toBeNull()
  })
})

describe('args: targets ping 与 help', () => {
  it('AC-014 targets ping 需要位置参数给出目标名（--target 不适用于该动作）', () => {
    const r = parse(['targets', 'ping', 'my_dev'])
    expect(r.error).toBeUndefined()
    expect(r).toMatchObject({ command: 'targets', action: 'ping', positionals: ['my_dev'] })
    expect(parse(['targets', 'ping']).error?.code).toBe('USAGE')
    expect(parse(['targets', 'ping', 'a', 'b']).error?.code).toBe('USAGE')
    expect(parse(['targets', 'ping', '--target', 'my_dev']).error?.code).toBe('USAGE')
  })

  it('P3-14 git branches 已下线（不再作为可用动作）', () => {
    const r = parse(['git', 'branches'])
    expect(r.error?.code).toBe('USAGE')
  })
  it('P3-15 帮助里每个段落的说明列按显示宽度对齐（中英混排也不错位）', () => {
    // 遍历顶层与**每条命令**的帮助：参数已下移到各命令帮助，只看顶层样本太少
    const lines = ['targets', 'plan', 'deploy', 'git', 'status', 'projects', 'task', 'mcp']
      .map((cmd) => helpText(cmd))
      .concat([helpText()])
      .join('\n')
      .split('\n')
    let column: number | null = null
    let checked = 0
    for (const line of lines) {
      if (line === '' || !line.startsWith('  ')) {
        column = null // 段落边界：重置基准
        continue
      }
      const run = / {2,}/.exec(line.slice(2))
      if (!run) continue // 示例行（整行就是命令），不参与对齐检查
      const descStart = 2 + run.index + run[0].length
      const start = displayWidth(line.slice(0, descStart))
      if (column === null) column = start
      else expect(start, line).toBe(column)
      checked += 1
    }
    expect(checked).toBeGreaterThan(20)
  })
  it('DFX-USE-001 顶层 --help 枚举全部命令，并指向逐命令帮助；无参数时输出帮助', () => {
    expect(parse(['--help']).command).toBe('help')
    expect(parse([]).command).toBe('help')
    const text = helpText()
    // 顶层：命令名 + 通用参数 + 逐命令帮助入口（完整参数下移到各命令的 help，避免顶层过长）
    for (const token of ['targets', 'plan', 'deploy', 'git', 'status', 'projects', 'task', 'mcp']) {
      expect(text).toContain(token)
    }
    for (const token of ['--json', '--project', '--target', '--help']) expect(text).toContain(token)
    expect(text).toContain('shipit help <命令>')
  })

  it('每条命令都有独立帮助（`shipit help <命令>` / `shipit <命令> --help`），且含用法与示例', () => {
    for (const cmd of ['targets', 'plan', 'deploy', 'git', 'status', 'projects', 'task', 'mcp']) {
      const text = helpText(cmd)
      expect(text, cmd).toContain(`shipit ${cmd}`)
      expect(text, cmd).toContain('用法：')
      expect(text, cmd).toContain('示例：')
      // 两个入口等价：`shipit help <cmd>` 与 `shipit <cmd> --help` 都要落到该命令的帮助
      expect(parse(['help', cmd]).helpGroup).toBe(cmd)
      expect(parse([cmd, '--help']).helpGroup).toBe(cmd)
    }
    // 命令独有的参数只出现在它自己的帮助里
    expect(helpText('deploy')).toContain('--wait')
    expect(helpText('deploy')).toContain('--expect-files')
    expect(helpText('git')).toContain('--branch')
    expect(helpText('git')).toContain('--limit')
    expect(helpText('plan')).toContain('--all-changed')
    expect(helpText('mcp')).toContain('@huberyhe/shipit-mcp')
  })
})

describe('策略 D′：项目相关命令必须显式指定项目（多窗口下焦点会漂移）', () => {
  it('plan/deploy/git 未带 --project 时被判为需要项目', () => {
    for (const argv of [['plan', '--target', 't'], ['deploy', '--target', 't'], ['git', 'status'], ['git', 'log']]) {
      const r = parse(argv)
      expect(r.error).toBeUndefined()
      const key = r.action ? `${r.command} ${r.action}` : String(r.command)
      expect(PROJECT_REQUIRED_COMMANDS).toContain(key)
      expect(r.project).toBeNull()
    }
  })

  it('带 --project 时正常解析（命令前/后都可以）', () => {
    expect(parse(['plan', '--target', 't', '--project', '/repo']).project).toBe('/repo')
    expect(parse(['--project', '/repo', 'git', 'status']).project).toBe('/repo')
  })

  it('项目无关的命令不需要 --project', () => {
    for (const key of ['targets list', 'projects list', 'status', 'task']) {
      expect(PROJECT_REQUIRED_COMMANDS).not.toContain(key)
    }
  })

  it('--allow-project-mismatch 已移除（策略 D′ 没有"放行"概念）', () => {
    const r = parse(['plan', '--target', 't', '--project', '/repo', '--allow-project-mismatch'])
    expect(r.error?.code).toBe('USAGE')
  })
})

describe('P1-15 未知参数回显不得泄漏疑似凭据', () => {
  it('--token=明文 被遮蔽', () => {
    const r = parse(['status', '--token=SUPERSECRET123456'])
    expect(r.error?.message).toContain('--token=<已隐藏>')
    expect(r.error?.message).not.toContain('SUPERSECRET')
  })

  it('其它疑似凭据参数名同样遮蔽（password / key / secret）', () => {
    for (const flag of ['--password=p@ss', '--api-key=abc', '--secret=xyz']) {
      const r = parse(['status', flag])
      expect(r.error?.message).not.toContain(flag.split('=')[1])
    }
  })

  it('普通未知参数仍完整回显（可读性不受影响）', () => {
    const r = parse(['status', '--weird=x'])
    expect(r.error?.message).toContain('--weird=x')
  })
})

describe('P1-13 用法错误先于连接发现（诊断不随环境漂移）', () => {
  it('漏 --project 时：无论有没有连接信息，都应报 USAGE（而不是 BACKEND_UNAVAILABLE）', async () => {
    const { runCli } = await import('./index')
    const lines: string[] = []
    // SHIPIT_HOME 指向不存在的目录 → 必然"读不到连接信息"
    const code = await runCli(['git', 'status'], {
      env: { SHIPIT_HOME: join(tmpdir(), 'shipit-no-such-' + Date.now()) },
      io: { stdout: () => {}, stderr: (t) => lines.push(t) }
    })
    expect(code).toBe(1)
    const text = lines.join('')
    expect(text).toContain('USAGE')
    expect(text).toContain('--project')
    expect(text).not.toContain('BACKEND_UNAVAILABLE')
  })
})

describe('命令面登记完整性（实现收敛）', () => {
  it('DFX-OPS-005 核心动作命令行化：所有产信封的命令均已登记实现（无未实现占位）', () => {
    // mcp 走 stdio 特殊路径（stdout 只承载协议消息，不经信封输出），因此不在登记表中
    expect(registeredCommandKeys()).toEqual([
      'deploy',
      'git log',
      'git status',
      'plan',
      'projects list',
      'status',
      'targets list',
      'targets ping',
      'targets show',
      'task'
    ])
  })

  it('帮助文本枚举的命令都能被解析（命令面与文档一致）', () => {
    const commands = [
      ['targets', 'list'],
      ['targets', 'show', 'my_dev'],
      ['targets', 'ping', 'my_dev'],
      ['plan', '--target', 't'],
      ['deploy', '--target', 't'],
      ['git', 'status'],
      ['git', 'log'],
      ['status'],
      ['task', 'abc'],
      ['mcp']
    ]
    for (const argv of commands) {
      expect(parse(argv).error).toBeUndefined()
    }
  })
})
