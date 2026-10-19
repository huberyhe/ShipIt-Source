/**
 * 多项目多窗口：纯逻辑部分（窗口选择、上限提示、托盘菜单收纳、参数解析）。
 *
 * 与 Electron 无关，便于单测；窗口生命周期由 `src/main/index.ts` 使用这些函数驱动。
 */

/**
 * 绝对路径判定（**不引入 node:path**）。
 *
 * 本模块会被打进 preload：沙箱化的 preload 不能 `require('path')`，
 * 引入了整个 preload 就加载失败（到时所有 IPC 全挂，界面白屏）。
 */
function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

/** 窗口角色：主窗口（项目选择/服务入口）与项目窗口（一项目一窗） */
export type WindowRole = 'main' | 'project' | 'settings'

export interface WindowEntry {
  /** webContents id（主进程内唯一） */
  id: number
  role: WindowRole
  /** 项目窗口的项目根路径；主窗口为 null */
  projectPath: string | null
  /** 窗口标题（托盘菜单与列表用） */
  title: string
}

/** 项目窗口数量阈值：达到即提示（不阻止），避免每窗一个渲染进程导致内存线性增长 */
export const PROJECT_WINDOW_LIMIT = 6

/** 托盘菜单内联展示的窗口数上限，超过收纳进「更多窗口…」（Miller 7±2） */
export const TRAY_INLINE_WINDOW_LIMIT = 5

/**
 * 关窗行为。
 * - `quit`：放行（退出流程，或没有托盘时按平台默认退出）
 * - `hide`：只隐藏（主窗口：托盘常驻的"家"，隐藏后仍可由托盘唤回）
 * - `close`：真正关闭（项目窗口：**关闭窗口即关闭该项目**，释放渲染进程，托盘列表随之移除）
 */
export type CloseAction = 'quit' | 'hide' | 'close'

export function closeActionFor(opts: { role: WindowRole; trayAvailable: boolean; isQuitting: boolean }): CloseAction {
  if (opts.isQuitting) return 'quit'
  // 项目窗口：关窗=关项目；设置窗口：关掉即可（下次从同一入口重建，避免无谓常驻）
  if (opts.role === 'project' || opts.role === 'settings') return 'close'
  return opts.trayAvailable ? 'hide' : 'quit'
}

/**
 * 项目路径归一化：用于「同一项目」判定。
 * Windows 路径大小写不敏感、末尾分隔符可有可无，都要视为同一个项目。
 */
export function normalizeProjectPath(input: string): string {
  const unified = input.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  // 盘符/大小写统一（仅影响比较，不用于访问文件系统）
  return unified.toLowerCase()
}

/** 项目名（路径最后一段），用于窗口标题与托盘菜单 */
export function projectNameOf(projectPath: string): string {
  const normalized = projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').pop() || normalized
}

/**
 * 窗口标题：只要窗口绑定了项目就带上项目名（多窗口下的身份标识）。
 *
 * 与 role 解耦：任何"装着项目"的窗口都必须在托盘列表里一眼可辨，
 * 不能因为它是主窗口就显示成与欢迎窗口同名。
 */
export function windowTitle(role: WindowRole, projectPath: string | null): string {
  if (role === 'settings') return '全局设置 — ShipIt'
  if (!projectPath) return 'ShipIt'
  return `${projectNameOf(projectPath)} — ShipIt`
}

/** 在已打开窗口里查找同一项目的窗口（同项目禁止多开：聚焦已有，不新建） */
export function findWindowForProject(entries: readonly WindowEntry[], projectPath: string): number | null {
  const target = normalizeProjectPath(projectPath)
  for (const entry of entries) {
    // role 会随"绑定/解绑项目"变化（主窗口打开项目后即成为项目窗口），因此只按 projectPath 判定
    if (!entry.projectPath) continue
    if (normalizeProjectPath(entry.projectPath) === target) return entry.id
  }
  return null
}

/**
 * 打开项目时的落点决策（唯一判定点，纯函数便于单测）。
 *
 * - `here`：**就地认领** —— 调用窗口是主窗口（项目选择页，尚无项目归属）。
 *   主窗口是唯一"没有项目归属"的窗口，把项目交给它不是"切换项目"（不违反"不做单窗口项目切换器"）：
 *   它会真正变成该项目窗口（注册表 role/projectPath 同步更新），因此托盘列表、窗口标题、
 *   关窗语义、D-4 的"当前项目"都会跟着生效。
 * - `focus`：该项目已在某个窗口打开 → 聚焦它，不新建（D-2 同项目禁止多开）。
 * - `new-window`：调用窗口是项目窗口，或调用方不是窗口（启动参数/第二实例）→ 新建项目窗口。
 */
export type OpenTarget =
  | { kind: 'here' }
  | { kind: 'focus'; windowId: number }
  | { kind: 'new-window' }

export function decideOpenTarget(
  entries: readonly WindowEntry[],
  callerId: number | null,
  projectPath: string
): OpenTarget {
  const existingId = findWindowForProject(entries, projectPath)
  if (existingId !== null) return { kind: 'focus', windowId: existingId }

  const caller = callerId === null ? undefined : entries.find((entry) => entry.id === callerId)
  if (caller && caller.role === 'main') return { kind: 'here' }
  return { kind: 'new-window' }
}

/** 是否提示窗口数量上限（达到阈值即提示；不阻止打开） */
export function shouldPromptWindowLimit(openProjectWindows: number): boolean {
  return openProjectWindows >= PROJECT_WINDOW_LIMIT
}

/**
 * 托盘窗口列表的标签：**只用项目名**。
 *
 * 窗口标题里的「— ShipIt」是给任务栏用的（明确应用名）；菜单里同一应用内
 * 再重复一遍应用名是噪音，只留项目名更易扫读。
 * 同名项目（如 D:/a/src 与 D:/b/src）用父目录消歧，避免菜单里出现两个一样的项。
 */
export function trayWindowLabels(entries: readonly WindowEntry[]): Map<number, string> {
  const visible = entries.filter((entry) => entry.projectPath !== null)
  const base = new Map<number, string>()
  for (const entry of visible) {
    if (!entry.projectPath) {
      base.set(entry.id, '(未打开项目)')
      continue
    }
    const normalized = entry.projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const segments = normalized.split('/').filter(Boolean)
    base.set(entry.id, segments[segments.length - 1] ?? normalized)
  }

  const counts = new Map<string, number>()
  for (const label of base.values()) counts.set(label, (counts.get(label) ?? 0) + 1)

  const labels = new Map<number, string>()
  for (const entry of visible) {
    const label = base.get(entry.id) ?? ''
    if ((counts.get(label) ?? 0) <= 1) {
      labels.set(entry.id, label)
      continue
    }
    const normalized = (entry.projectPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const segments = normalized.split('/').filter(Boolean)
    labels.set(entry.id, segments.slice(-2).join('/') || label)
  }
  return labels
}

export interface TrayWindowMenu {
  /** 直接展示的窗口 */
  inline: WindowEntry[]
  /** 收纳进「更多窗口…」的窗口 */
  overflow: WindowEntry[]
}

/** 托盘窗口列表：最多内联 TRAY_INLINE_WINDOW_LIMIT 项，其余收纳 */
export function trayWindowMenu(
  entries: readonly WindowEntry[],
  limit: number = TRAY_INLINE_WINDOW_LIMIT
): TrayWindowMenu {
  // 只收录**已绑定项目**的窗口：列表里每一项都对应一个真实项目。
  // 未绑定项目的窗口（项目已关闭 / 打开失败回退）不列出来，避免菜单里出现"看起来像主窗口"的空项。
  const list = entries.filter((entry) => entry.projectPath !== null)
  return { inline: list.slice(0, limit), overflow: list.slice(limit) }
}

/**
 * 聚焦策略（D-4）：优先「最近聚焦的项目窗口」；没有项目窗口时回落到主窗口。
 * 传入的 entries 为当前所有窗口，focusedId 为最近聚焦的窗口 id。
 */
export function pickWindowToFocus(
  entries: readonly WindowEntry[],
  focusedId: number | null
): number | null {
  if (focusedId !== null) {
    const focused = entries.find((entry) => entry.id === focusedId)
    if (focused) return focused.id
  }
  const lastProject = [...entries].reverse().find((entry) => entry.role === 'project')
  if (lastProject) return lastProject.id
  const main = entries.find((entry) => entry.role === 'main')
  return main ? main.id : null
}

export type SettingsSection = 'targets' | 'server'

export interface WindowInitArgs {
  role: WindowRole
  projectPath: string | null
  /** 设置窗口的初始标签页 */
  section: SettingsSection
  /** 启动参数里携带的项目路径（如双击/命令行传入），无则 null */
  startupProject: string | null
}

export const ARG_ROLE = '--shipit-role='
export const ARG_SECTION = '--shipit-section='
export const ARG_PROJECT = '--shipit-project='

/**
 * 解析窗口初始化参数（主进程写入 `webPreferences.additionalArguments`，
 * preload 从 process.argv 读回；渲染进程据此决定初始视图）。
 */
export function parseWindowArgs(argv: readonly string[]): WindowInitArgs {
  let role: WindowRole = 'main'
  let projectPath: string | null = null
  let section: SettingsSection = 'targets'
  let startupProject: string | null = null

  // argv[0] 是可执行文件自身（如 D:\...\electron.exe）：它看起来也像绝对路径，
  // 必须跳过，否则启动时会"打开这个 exe 作为项目"。
  for (const [index, arg] of argv.entries()) {
    if (index === 0 && !arg.startsWith(ARG_ROLE) && !arg.startsWith(ARG_PROJECT)) continue
    if (arg.startsWith(ARG_SECTION)) {
      section = arg.slice(ARG_SECTION.length) === 'server' ? 'server' : 'targets'
    } else if (arg.startsWith(ARG_ROLE)) {
      const rawRole = arg.slice(ARG_ROLE.length)
      role = rawRole === 'project' || rawRole === 'settings' ? rawRole : 'main'
    } else if (arg.startsWith(ARG_PROJECT)) {
      const raw = arg.slice(ARG_PROJECT.length)
      try {
        projectPath = raw ? decodeURIComponent(raw) : null
      } catch {
        projectPath = raw || null
      }
    } else if (!arg.startsWith('--') && isAbsolutePath(arg)) {
      // 命令行/双击/拖拽给了绝对路径：用 path.isAbsolute 而不是只认盘符，
      // 否则 macOS / Linux 上的 `/Users/me/app` 不会被当成启动项目
      startupProject = arg
    }
  }

  return { role, projectPath, section, startupProject }
}

/** 组装窗口附加参数（主进程创建窗口时使用） */
export function windowArguments(role: WindowRole, projectPath: string | null): string[] {
  const args = [`${ARG_ROLE}${role}`]
  if (projectPath) args.push(`${ARG_PROJECT}${encodeURIComponent(projectPath)}`)
  return args
}