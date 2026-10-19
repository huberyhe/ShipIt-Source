import { describe, expect, it } from 'vitest'
import { emit, renderResult, exitCodeOf, ok, PROTOCOL_VERSION } from './output'
import { displayWidth } from './text'

describe('退出码归类完整性（表驱动后加一道运行期守卫）', () => {
  it('每个 ErrorCode 都有归类（漏归类在类型层已不可能，这里再守一道）', async () => {
    const { ERROR_CODES, EXIT_CLASS_OF } = await import('../shared/cli-contract')
    expect(Object.keys(EXIT_CLASS_OF).sort()).toEqual([...ERROR_CODES].sort())
    for (const code of ERROR_CODES) expect(EXIT_CLASS_OF[code]).toBeTruthy()
  })

  it('保留类别（NO_MAPPING / EMPTY_RESULT）当前无生产者：若将来启用，请同步更新契约注释与本用例', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const root = path.join(__dirname, '..')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          const text = fs.readFileSync(full, 'utf-8')
          if (text.includes("'NO_MAPPING'") || text.includes("'EMPTY_RESULT'")) hits.push(full)
        }
      }
    }
    walk(root)
    // 只有契约自身定义它们（按设计：保留但未使用）
    expect(hits.map((f) => path.relative(root, f).replace(/\\/g, '/'))).toEqual(['shared/cli-contract.ts'])
  })
})

describe('output', () => {
  it('AC-013 成功输出含 ok/data/meta 且不含凭据字段', () => {
    const r = renderResult({ ok: true, data: [{ name: 'my_dev' }], meta: { target: 'my_dev' } })
    expect(r.json).toContain('"ok":true')
    expect(r.json).not.toMatch(/password|token|privateKey/i)
  })

  it('AC-014 / DFX-USE-005 用法错误映射退出码 1（失败可判定）', () => {
    expect(exitCodeOf('USAGE')).toBe(1)
  })

  it('AC-020 后端不可用映射退出码 3', () => {
    expect(exitCodeOf('BACKEND_UNAVAILABLE')).toBe(3)
  })

  it('AC-021 协议不匹配映射退出码 3 且可判定', () => {
    const r = renderResult({ ok: false, error: { code: 'PROTOCOL_MISMATCH', message: '协议版本不一致' } })
    expect(exitCodeOf('PROTOCOL_MISMATCH')).toBe(3)
    expect(r.json).toContain('PROTOCOL_MISMATCH')
  })

  it('AC-022 配置/目标类错误映射退出码 4（用法类为 1）', () => {
    expect(exitCodeOf('NO_TARGET')).toBe(4)
    expect(exitCodeOf('PLAN_STALE')).toBe(4)
    // 策略 D′：项目根缺失属用法类
    expect(exitCodeOf('USAGE')).toBe(1)
    expect(exitCodeOf('UNKNOWN_TASK')).toBe(4)
  })

  it('P2 回归 队列类新错误码属环境类（退出码 3）', () => {
    expect(exitCodeOf('QUEUE_FULL')).toBe(3)
    expect(exitCodeOf('TASK_TIMEOUT')).toBe(3)
  })

  it('P2 回归 计划过期属配置/状态类（退出码 4）', () => {
    expect(exitCodeOf('PLAN_STALE')).toBe(4)
  })

  it('CON-1 协议版本常量为正整数（前后端共享）', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true)
    expect(PROTOCOL_VERSION).toBeGreaterThan(0)
  })
})

describe('人类可读输出（默认通道）', () => {
  it('P3 回归 表格按显示宽度对齐（中文单元格不会挤掉后续列）', () => {
    const env = ok({
      rows: [
        { 名称: '中文名称', 结果: 'ok' },
        { 名称: 'ab', 结果: 'failed' }
      ]
    })

    const lines = renderResult(env)
      .text.split('\n')
      .filter((line) => line.includes('结果') || line.includes('ok') || line.includes('failed'))
    expect(lines).toHaveLength(3)

    // 第二列在所有行里的**显示列偏移**必须一致（用 String.length 对齐时中文行会提前）
    const offsets = lines.map((line) => {
      const at = line.indexOf('结果') >= 0 ? line.indexOf('结果') : line.includes('ok') ? line.indexOf('ok') : line.indexOf('failed')
      return displayWidth(line.slice(0, at))
    })
    expect(new Set(offsets).size).toBe(1)
  })

  it('对象数组渲染为对齐表格（不出现 JSON）', () => {
    const r = renderResult({
      ok: true,
      data: [
        { name: 'my_dev', protocol: 'sftp', port: 22, mappingCount: 1 },
        { name: 'staging', protocol: 'local', port: 0, mappingCount: 3 }
      ]
    })
    expect(r.text).not.toContain('{')
    const lines = r.text.split('\n')
    expect(lines[0]).toMatch(/name\s+protocol\s+port\s+mappingCount/)
    expect(lines[1]).toMatch(/^[-\s]+$/)
    expect(lines[2]).toMatch(/^my_dev\s+sftp\s+22\s+1$/)
    expect(lines[3]).toMatch(/^staging\s+local\s+0\s+3$/)
  })

  it('嵌套对象缩进展开，嵌套数组用逗号连接', () => {
    const r = renderResult({
      ok: true,
      data: { projectRoot: 'D:/a', items: [{ relativePath: 'dist/a.js', size: 10 }], tags: ['x', 'y'], empty: [] }
    })
    expect(r.text).toContain('projectRoot: D:/a')
    expect(r.text).toContain(
      ['items:', '  relativePath  size', '  ------------  ----', '  dist/a.js     10'].join('\n')
    )
    expect(r.text).toContain('tags: x, y')
    expect(r.text).toContain('empty: (空)')
    expect(r.text).not.toContain('{"')
  })

  it('单元格过宽时退回块状展示（不截断信息）', () => {
    const long = 'D:/very/long/path/that/exceeds/the/table/cell/limit/out/dist/app.js'
    const r = renderResult({ ok: true, data: [{ relativePath: long, status: 'success' }] })
    expect(r.text).toContain(`- ${long}`)
    expect(r.text).toContain('status: success')
    expect(r.text).not.toContain('…')
  })

  it('嵌套对象字段按 k=v 压平（表格单元格里的 mapping 等）', () => {
    const r = renderResult({
      ok: true,
      data: [{ relativePath: 'dist/a.js', mapping: { localPrefix: 'dist/', remotePath: 'out/dist' } }]
    })
    expect(r.text).toContain('localPrefix=dist/, remotePath=out/dist')
  })

  it('空数组显示 (空)；null 显示 -', () => {
    expect(renderResult({ ok: true, data: [] }).text).toBe('(空)')
    expect(renderResult({ ok: true, data: { currentProject: null } }).text).toBe('currentProject: -')
  })
})

describe('错误输出（默认通道同样是给人看的）', () => {
  it('失败信封渲染为 [错误类别] 说明 + 提示（不出现 JSON）', () => {
    const r = renderResult({
      ok: false,
      error: { code: 'USAGE', message: '未知命令：nope', hint: '可用命令：targets、plan、deploy' }
    })
    expect(r.text).toBe('[USAGE] 未知命令：nope\n提示：可用命令：targets、plan、deploy')
    expect(r.text).not.toContain('{')
    expect(r.json).toContain('"ok":false')
  })

  it('无 hint 时不输出提示行', () => {
    const r = renderResult({ ok: false, error: { code: 'USAGE', message: '错误信息' } })
    expect(r.text).toBe('[USAGE] 错误信息')
  })

  it('部分失败的明细（data）一并渲染，不被藏进 JSON', () => {
    const r = renderResult({
      ok: false,
      error: { code: 'PARTIAL', message: '部分文件上传失败：成功 1 / 失败 1', hint: '失败明细见 data.details' },
      data: {
        taskId: 'T1',
        summary: { totalFiles: 2, succeeded: 1, failed: 1 },
        details: [
          { relativePath: 'dist/a.js', status: 'success' },
          { relativePath: 'dist/b.js', status: 'failed', error: '权限不足' }
        ]
      }
    })
    expect(r.text).toContain('[PARTIAL] 部分文件上传失败：成功 1 / 失败 1')
    expect(r.text).toContain('提示：失败明细见 data.details')
    expect(r.text).toContain('dist/b.js')
    expect(r.text).toContain('权限不足')
    expect(r.text).not.toContain('{')
  })
})

describe('emit 通道与 --json 对齐', () => {
  const capture = (): { io: { stdout: (s: string) => void; stderr: (s: string) => void }; stdout: string[]; stderr: string[] } => {
    const stdout: string[] = []
    const stderr: string[] = []
    return { io: { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) }, stdout, stderr }
  }
  const failure = { ok: false as const, error: { code: 'USAGE' as const, message: '未知命令：nope', hint: '可用命令：plan' } }
  const success = { ok: true as const, data: { port: 4517 } }

  it('不加 --json：成功走 stdout（文本）、失败走 stderr（文本，非 JSON）', () => {
    const a = capture()
    expect(emit(success, { stdout: a.io.stdout, stderr: a.io.stderr })).toBe(0)
    expect(a.stdout.join('')).toBe('port: 4517')
    expect(a.stderr.join('')).toBe('')

    const b = capture()
    expect(emit(failure, { stdout: b.io.stdout, stderr: b.io.stderr })).toBe(1)
    expect(b.stdout.join('')).toBe('')
    expect(b.stderr.join('')).toContain('[USAGE]')
    expect(b.stderr.join('')).not.toContain('{"')
  })

  it('加 --json：成功走 stdout（信封）、失败走 stderr（信封）', () => {
    const a = capture()
    emit(success, { json: true, stdout: a.io.stdout, stderr: a.io.stderr })
    expect(JSON.parse(a.stdout.join('').trim())).toMatchObject({ ok: true, data: { port: 4517 } })
    expect(a.stderr.join('')).toBe('')

    const b = capture()
    emit(failure, { json: true, stdout: b.io.stdout, stderr: b.io.stderr })
    expect(b.stdout.join('')).toBe('')
    expect(JSON.parse(b.stderr.join('').trim())).toMatchObject({ ok: false, error: { code: 'USAGE' } })
  })
})
