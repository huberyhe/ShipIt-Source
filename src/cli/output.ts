/**
 * CLI 输出外壳：统一的 `--json` 信封渲染 + 人类可读输出 + 退出码。
 *
 * 与桌面服务端共享契约常量来自 `src/shared/cli-contract.ts`（铁律 1：契约单一来源）。
 */
import { displayWidth, padEndDisplay } from './text'
import {
  errEnvelope,
  exitCodeOf,
  okEnvelope,
  PROTOCOL_VERSION,
  type Envelope,
  type ErrorCode,
  type ErrEnvelope,
  type OkEnvelope
} from '../shared/cli-contract'

export { exitCodeOf, PROTOCOL_VERSION }
export type { Envelope, ErrorCode, ErrEnvelope, OkEnvelope }

export interface RenderedResult {
  /** 机器可读信封（--json 时原样输出） */
  json: string
  /** 人类可读摘要（默认输出） */
  text: string
  /** 进程退出码 */
  exitCode: number
}

/** 构造成功信封（共享实现） */
export const ok = okEnvelope

/** 构造失败信封（共享实现） */
export const fail = errEnvelope

/**
 * 人类可读输出（默认通道）。
 *
 * 目标是"不看到 JSON"：
 * - 失败 → `[错误类别] 说明`（+ `提示：…` + 明细），写 stderr
 * - 对象 → `字段: 值` 逐行；嵌套对象缩进展开
 * - 对象数组 → 对齐表格（值过宽时自动退回块状，避免截断丢信息）
 * - 标量数组 → 逗号连接；空数组显示 (空)
 * 需要机器可读时加 `--json`（结构化信封，字段为兼容契约）。
 */
const MAX_TABLE_CELL = 40

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.length === 0 ? '(空)' : value.map((v) => formatScalar(v)).join(', ')
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${formatScalar(v)}`)
      .join(', ')
  }
  return String(value)
}

function isRowArray(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
  )
}

/** 对象数组 → 对齐表格；任一单元格过宽则退回块状（不截断） */
function renderTable(rows: Array<Record<string, unknown>>, indent: string): string[] {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const cells = rows.map((row) => columns.map((c) => formatScalar(row[c])))
  // 列宽必须同时容纳表头与所有单元格，否则表头会撑破列宽导致错位
  // 列宽按**显示宽度**算：中文占 2 列，用 String.length 会让表头/分隔线整体错位
  const widths = columns.map((c, i) =>
    Math.max(displayWidth(c), ...cells.map((row) => displayWidth(row[i])))
  )

  if (widths.some((w) => w > MAX_TABLE_CELL)) {
    return rows.flatMap((row) => [
      `${indent}- ${formatScalar(row[columns[0]])}`,
      ...columns.slice(1).map((c) => `${indent}  ${c}: ${formatScalar(row[c])}`)
    ])
  }

  // 行尾不补空格（避免无意义的尾随空白）
  const trimEnd = (line: string): string => line.replace(/\s+$/, '')
  const header = trimEnd(columns.map((c, i) => padEndDisplay(c, widths[i])).join('  '))
  const separator = widths.map((w) => '-'.repeat(w)).join('  ')
  const body = cells.map((row) => trimEnd(row.map((cell, i) => padEndDisplay(cell, widths[i])).join('  ')))
  return [indent + header, indent + separator, ...body.map((line) => indent + line)]
}

function renderField(key: string, value: unknown, indent: string): string[] {
  if (isRowArray(value)) return [`${indent}${key}:`, ...renderTable(value, indent + '  ')]
  if (Array.isArray(value)) {
    return [`${indent}${key}: ${value.length === 0 ? '(空)' : value.map((v) => formatScalar(v)).join(', ')}`]
  }
  if (value !== null && typeof value === 'object') {
    return [
      `${indent}${key}:`,
      ...Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => renderField(k, v, indent + '  '))
    ]
  }
  return [`${indent}${key}: ${formatScalar(value)}`]
}

/** 任意 data（成功载荷或失败明细）→ 人类可读行 */
function renderData(data: unknown): string[] {
  if (isRowArray(data)) return renderTable(data, '')
  if (Array.isArray(data)) return [data.length === 0 ? '(空)' : data.map((v) => formatScalar(v)).join('\n')]
  if (data !== null && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).flatMap(([k, v]) => renderField(k, v, ''))
  }
  if (data !== null && data !== undefined) return [formatScalar(data)]
  return []
}

function toText(env: Envelope): string {
  if (!env.ok) {
    const { code, message, hint } = env.error
    // 失败也可能是「部分成功」：带明细（如 PARTIAL 的逐文件结果），
    // 否则默认通道会把关键信息藏起来、逼用户重跑一次加 --json
    const head = hint ? `[${code}] ${message}\n提示：${hint}` : `[${code}] ${message}`
    return [head, ...renderData(env.data)].join('\n')
  }

  const lines: string[] = []
  const meta = env.meta ?? {}
  if (typeof meta.summary === 'string') lines.push(meta.summary)
  lines.push(...renderData(env.data))
  return lines.join('\n')
}

/** 命令专用的人类可读渲染器：仅成功信封走它（`--json` 与错误信封不受影响） */
export type TextRenderer = (env: OkEnvelope) => string

/** 渲染结果（信封 + 文本 + 退出码一起返回，便于调用方决定输出通道） */
export function renderResult(env: Envelope, renderText?: TextRenderer): RenderedResult {
  return {
    json: JSON.stringify(env),
    text: env.ok && renderText ? renderText(env) : toText(env),
    exitCode: env.ok ? 0 : exitCodeOf(env.error.code)
  }
}

/** 按模式输出到 stdout/stderr，并返回退出码 */
export function emit(
  env: Envelope,
  opts: {
    json?: boolean
    stdout?: (s: string) => void
    stderr?: (s: string) => void
    /** 命令专用文本渲染器（仅成功信封且非 --json 时生效） */
    renderText?: TextRenderer
  } = {}
): number {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(`${s}\n`))
  const err = opts.stderr ?? ((s: string) => process.stderr.write(`${s}\n`))
  const r = renderResult(env, opts.renderText)
  // 通道由 --json 决定，不由成功/失败决定：不加 --json 时失败也走人类可读通道
  // （`[错误类别] 说明` + 可选提示与明细）
  if (opts.json) {
    if (env.ok) out(r.json)
    else err(r.json)
  } else if (env.ok) {
    out(r.text)
  } else {
    err(r.text)
  }
  return r.exitCode
}
