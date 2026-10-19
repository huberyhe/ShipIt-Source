/**
 * 项目上下文（策略 D′：**项目必填**）。
 *
 * 多窗口下「最近聚焦的项目窗口」会随时漂移，若服务端以它为默认项目，
 * `plan`(项目A) → `deploy`(焦点已切到B) 会把 A 的计划提交到 B。
 * 因此：**项目相关请求必须显式携带项目根**，服务端只认请求里的值。
 *
 * 本类保留 `current` 仅用于**展示**（`/status` 的 currentProject、界面状态栏），
 * 不再参与任何执行路径的项目解析。
 */
import { existsSync, realpathSync } from 'fs'
import type { ErrorCode } from '../../shared/cli-contract'

export interface ResolveProjectInput {
  /** 前端显式指定的项目根（必填） */
  project?: string | null
}

export interface ResolvedProject {
  projectRoot: string
}

export type ResolveProjectResult =
  | { ok: true; project: ResolvedProject }
  | { ok: false; error: { code: ErrorCode; message: string; hint?: string } }

/**
 * 统一路径口径：反斜杠转正斜杠、去掉末尾分隔符。
 *
 * 必须保留「根」的语义：`C:\` → `C:/`（不能削成 `C:`），纯分隔符 `//` 也不能被削成空串 ——
 * 否则显式传入的项目会被当成「未指定」，静默回退到别的项目（可能部署错项目）。
 */
export function normalizePath(input: string): string {
  const slashed = input.replace(/\\/g, '/')
  const stripped = slashed.replace(/\/+$/, '')
  if (stripped === '') return slashed // 全是分隔符：原样保留（'/'、'//' 都是有意义的前缀）
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}/`
  return stripped
}

/** 路径是否表示同一目录（Windows 下忽略大小写） */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const na = normalizePath(a)
  const nb = normalizePath(b)
  if (platform === 'win32') return na.toLowerCase() === nb.toLowerCase()
  return na === nb
}

/**
 * 解析到真实路径（解开符号链接 / Windows junction）。
 *
 * 作用域与「项目内」判定都必须看真实路径：词法上的 `D:/Work/link` 很可能指向 `D:/Secrets`，
 * 只看字符串就能把局域网令牌作用域绕过去（D-28 的边界失效）。
 * 路径不存在/不可访问时回退到归一化路径：不能因为“解析不了”就当成越界或放行。
 */
export function realPath(input: string): string {
  const normalized = normalizePath(input)
  // 快路径：不存在的路径不可能是链接。realpathSync 失败是“抛异常”路径，
  // 选择器可能一次传上万个路径，用异常做常规分支会把校验拖成几十秒。
  if (!existsSync(normalized)) return normalized
  try {
    return normalizePath(realpathSync(normalized))
  } catch {
    return normalized
  }
}

/**
 * 项目作用域（决策 D-25）。
 *
 * `enforce` 为真时（**仅局域网绑定**）只允许两类路径：
 * 1）桌面已打开的项目；2）`allowedRoots` 之下（含自身）的目录。
 * 本机回环不启用 —— 桌面版本就能读写本机文件，回环服务只是它的控制面。
 */
export interface ProjectScope {
  enforce: boolean
  allowedRoots: string[]
  openedProjects: string[]
}

/**
 * `target` 是否位于 `root` 之下（含相等）。
 *
 * 必须按**路径段**比较：`D:/Work` 不能匹配 `D:/Work2`（前缀字符串比较的经典误判）。
 */
export function isUnderPath(
  root: string,
  target: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const r = normalizePath(root)
  const t = normalizePath(target)
  const lower = (v: string): string => (platform === 'win32' ? v.toLowerCase() : v)
  const [rl, tl] = [lower(r), lower(t)]
  if (rl === tl) return true
  // 根以分隔符结尾（如 C:/）时直接前缀比较；否则要求"根 + /"前缀
  const prefix = rl.endsWith('/') ? rl : `${rl}/`
  return tl.startsWith(prefix)
}

export class ProjectContext {
  /** 最近聚焦的项目根：**仅用于展示**（不参与执行路径的项目解析） */
  private current: string | null = null

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /** 桌面端窗口聚焦/关闭项目时同步（仅内存，供展示） */
  setCurrent(projectRoot: string | null): void {
    this.current = projectRoot && projectRoot.trim().length > 0 ? normalizePath(projectRoot) : null
  }

  getCurrent(): string | null {
    return this.current
  }

  /**
   * 是否落在允许范围内：已打开项目优先，其次 allowedRoots 之下。
   *
   * 一律比较**真实路径**：否则 `allowedRoots` 下建一个指向外部的 junction，
   * 词法上仍“在里面”，实际上能读写任意目录（P1-5）。
   */
  private inScope(projectRoot: string, scope: ProjectScope): boolean {
    const real = realPath(projectRoot)
    if (scope.openedProjects.some((opened) => samePath(realPath(opened), real, this.platform))) return true
    return scope.allowedRoots.some((root) => isUnderPath(realPath(root), real, this.platform))
  }

  /**
   * 解析项目：**必须显式给出**；缺失按用法错误处理（退出码 4）。
   *
   * 传入 `scope` 且 `enforce` 为真时额外做作用域校验（D-25，仅局域网）。
   */
  resolve(input: ResolveProjectInput = {}, scope?: ProjectScope): ResolveProjectResult {
    const explicit = input.project && input.project.trim().length > 0 ? normalizePath(input.project) : null
    if (!explicit) {
      return {
        ok: false,
        error: {
          code: 'USAGE',
          message: '未指定项目根：CLI 用 --project <项目根>，MCP 用 projectRoot',
          hint: '可用 `shipit projects list`（MCP：list_projects）查看桌面当前已打开的项目'
        }
      }
    }
    if (scope?.enforce && !this.inScope(explicit, scope)) {
      const roots = scope.allowedRoots.length > 0 ? scope.allowedRoots.join('、') : '（未配置）'
      return {
        ok: false,
        error: {
          code: 'PROJECT_OUT_OF_SCOPE',
          message: `项目超出允许范围：${explicit}（当前为局域网绑定）`,
          hint: `只允许桌面已打开的项目与「允许的项目根」；当前允许根：${roots}。可在桌面版「设置 → 本地服务」中添加，或改用本机回环访问`
        }
      }
    }
    return { ok: true, project: { projectRoot: explicit } }
  }
}
