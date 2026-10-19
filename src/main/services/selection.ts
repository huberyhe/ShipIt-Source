/**
 * 选择器解析与计划生成。
 *
 * - 选择器四种取值互斥，由前端传值；缺省按当前变更（all-changed）。
 * - 计划阶段只做本地路径解析与映射匹配，**不建立远端连接**（INV-1 / AC-005）。
 * - 未命中映射的文件进入跳过集合并标注原因，不阻断其他文件（INV-3 / AC-006）。
 */
import { isAbsolute, join, relative } from 'path'
import type { Selector } from '../../shared/cli-contract'
import { toSlashes } from '../../shared/paths'
import { isUnderPath, realPath, samePath } from './project-context'
import type { DeployTarget, PlanItem, PlanSkip, UploadTask } from '../../shared/types'

/**
 * 单次选择器允许的最大文件数。
 *
 * 不是业务上限，而是"输入失控"的兜底：选择器路径一旦写错（或目录异常膨胀），
 * 后续的映射匹配与存在性检查会线性放量。超限**明确报错**而不是静默截断。
 */
export const MAX_SELECTION_FILES = 200_000

/**
 * 解析后的路径必须落在项目根内（含项目根本身）。
 *
 * 为什么必须查：前端可以传**绝对路径**（`--dir D:/`、`--files /etc/...`），
 * 若只校验 projectRoot 的作用域，就能借一个"合法项目"去读取/枚举项目之外的目录
 * （已实测可复现：范围外目录的文件名会出现在 plan 的 skipped 里回显给调用方）。
 */
export function isInsideProject(projectRoot: string, absPath: string): boolean {
  // 两道门：词法挡 `..`/绝对路径，真实路径挡符号链接与 junction（P1-5）。
  // 只查词法时，项目内的 `link -> D:/secrets` 能枚举/上传项目之外的文件。
  if (!samePath(projectRoot, absPath) && !isUnderPath(projectRoot, absPath)) return false
  const realRoot = realPath(projectRoot)
  const realAbs = realPath(absPath)
  return samePath(realRoot, realAbs) || isUnderPath(realRoot, realAbs)
}

export interface SelectionDeps {
  isGitRepo: (dir: string) => Promise<boolean>
  /** git 未提交变更（相对项目根的路径） */
  listChangedFiles: (dir: string) => Promise<string[]>
  /** 指定提交涉及的文件（相对项目根的路径） */
  listCommitFiles: (dir: string, ref: string) => Promise<string[]>
  /**
   * 目录内全部文件（绝对路径；上传遍历，包含构建产物）。
   * `maxFiles` 由选择器传入：遍历中就要能停手（P2-9）
   */
  listFilesInDir: (dir: string, maxFiles?: number) => Promise<string[]>
  /** 判断路径是否存在：用于把「文件不存在」与「未命中映射」区分开（可选） */
  exists?: (absPath: string) => Promise<boolean>
}

export { toSlashes }

/** 相对路径 → 绝对路径（已是绝对路径时原样归一化） */
export function resolvePath(projectRoot: string, input: string): string {
  return isAbsolute(input) ? input : join(projectRoot, input)
}

/** 命中映射：按 localPrefix 长度降序取最长前缀（与 DeployService 规则一致） */
export function matchMapping(
  relativePath: string,
  mappings: DeployTarget['mappings']
): { localPrefix: string; remotePath: string } | null {
  const relPath = toSlashes(relativePath)
  const sorted = [...mappings].sort((a, b) => b.localPrefix.length - a.localPrefix.length)
  for (const mapping of sorted) {
    let prefix = toSlashes(mapping.localPrefix)
    if (!prefix.endsWith('/')) prefix += '/'
    if (relPath.startsWith(prefix) || relPath === prefix.slice(0, -1)) {
      return { localPrefix: mapping.localPrefix, remotePath: mapping.remotePath }
    }
  }
  return null
}

export type SelectionResult =
  | { ok: true; files: string[] }
  | { ok: false; code: 'NOT_A_REPO' | 'EMPTY_SELECTION' | 'USAGE'; message: string; hint?: string }

/** 解析选择器 → 待处理文件绝对路径集合 */
export async function resolveSelection(
  selector: Selector | null,
  projectRoot: string,
  deps: SelectionDeps
): Promise<SelectionResult> {
  const kind = selector?.kind ?? 'all-changed'

  if (kind === 'files') {
    const paths = (selector as Extract<Selector, { kind: 'files' }>).paths
    if (paths.length === 0) {
      return { ok: false, code: 'EMPTY_SELECTION', message: '选择器为空：--files 未给出任何路径' }
    }
    // 先做数量上限：每个路径的作用域校验都要看真实路径（一次 fs 调用），
    // 对失控输入先拒绝，避免为了报“越界”而把几万个路径全查一遍。
    if (paths.length > MAX_SELECTION_FILES) {
      return {
        ok: false,
        code: 'USAGE',
        message: `选择的文件过多：${paths.length} 个（上限 ${MAX_SELECTION_FILES}）`,
        hint: '请改用更小的范围（--dir 指定子目录）'
      }
    }
    const resolved = paths.map((p) => resolvePath(projectRoot, p))
    const outside = resolved.filter((abs) => !isInsideProject(projectRoot, abs))
    if (outside.length > 0) {
      return {
        ok: false,
        code: 'USAGE',
        message: `选择的路径超出项目根：${outside.map((p) => toSlashes(p)).join('、')}`,
        hint: '--files 只能指定项目根内的文件（缺省相对项目根解析）'
      }
    }
    if (resolved.length > MAX_SELECTION_FILES) {
      return {
        ok: false,
        code: 'USAGE',
        message: `选择的文件过多：${resolved.length} 个（上限 ${MAX_SELECTION_FILES}）`,
        hint: '请改用更小的范围（--dir 指定子目录）'
      }
    }
    return { ok: true, files: resolved }
  }

  if (kind === 'dir') {
    const dir = resolvePath(projectRoot, (selector as Extract<Selector, { kind: 'dir' }>).path)
    if (!isInsideProject(projectRoot, dir)) {
      return {
        ok: false,
        code: 'USAGE',
        message: `选择的目录超出项目根：${toSlashes(dir)}`,
        hint: '--dir 只能指向项目根内的目录（缺省相对项目根解析）'
      }
    }
    let files: string[]
    try {
      // 多要一个：用来判定“超过上限”，而不是把整棵目录收完
      files = await deps.listFilesInDir(dir, MAX_SELECTION_FILES)
    } catch (error) {
      // 目录不存在/不可读：如实报错，不要静默变成「目录内没有文件」
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        code: 'EMPTY_SELECTION',
        message: `目录不可读：${dir}（${message}）`,
        hint: '请确认 --dir 指向项目内的可读目录'
      }
    }
    if (files.length === 0) {
      return { ok: false, code: 'EMPTY_SELECTION', message: `目录内没有文件：${dir}` }
    }
    if (files.length > MAX_SELECTION_FILES) {
      return {
        ok: false,
        code: 'USAGE',
        message: `目录内文件过多：${files.length} 个（上限 ${MAX_SELECTION_FILES}）`,
        hint: '请缩小 --dir 的范围'
      }
    }
    return { ok: true, files }
  }

  // all-changed / last-commit 依赖 Git
  if (!(await deps.isGitRepo(projectRoot))) {
    return {
      ok: false,
      code: 'NOT_A_REPO',
      message: `目录不是 Git 仓库：${projectRoot}`,
      hint: '请改用 --files 或 --dir 指定范围'
    }
  }

  const relPaths =
    kind === 'last-commit' ? await deps.listCommitFiles(projectRoot, 'HEAD') : await deps.listChangedFiles(projectRoot)

  const unique = [...new Set(relPaths.map(toSlashes).filter((p) => p.length > 0))]
  if (unique.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_SELECTION',
      message: kind === 'last-commit' ? '最近一次提交没有文件' : '没有未提交变更',
      hint: '请先用 --files 或 --dir 显式指定范围'
    }
  }
  return { ok: true, files: unique.map((p) => join(projectRoot, p)) }
}

/** 上传任务 → 计划项（补上命中的映射） */
export function toPlanItems(tasks: UploadTask[], target: DeployTarget): PlanItem[] {
  return tasks.map((task) => {
    const rel = toSlashes(task.relativePath)
    return {
      relativePath: rel,
      remotePath: toSlashes(task.remotePath),
      size: task.size,
      mapping: matchMapping(rel, target.mappings ?? []) ?? { localPrefix: '', remotePath: '' }
    }
  })
}

/**
 * 选中但未进入上传集合的文件 → 跳过项。
 *
 * `missing` 由调用方预先算好（需要文件系统信息），未传时一律标 no-mapping，
 * 保持纯函数与既有调用方式不变。
 */
export function toPlanSkips(
  files: string[],
  tasks: UploadTask[],
  projectRoot: string,
  missing?: ReadonlySet<string>
): PlanSkip[] {
  const planned = new Set(tasks.map((t) => toSlashes(t.relativePath)))
  const skips: PlanSkip[] = []
  for (const file of files) {
    const rel = toSlashes(relative(projectRoot, file))
    if (planned.has(rel)) continue
    skips.push({ relativePath: rel, reason: missing?.has(file) ? 'missing' : 'no-mapping' })
  }
  return skips
}
