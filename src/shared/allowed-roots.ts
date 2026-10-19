/**
 * 局域网作用域白名单（`server.allowedRoots`）的归一化 —— **唯一来源**。
 *
 * 为什么必须同源：主进程（写盘校验）与渲染层（草稿/patch/isDirty）各写一份实现时，
 * 两边的口径会出现细微差异（全分隔符输入 `///`、Windows 去重大小写、尾分隔符），
 * 表现为"界面显示的与落盘的不一致""改了尾斜杠却因 patch 为空而静默关窗不保存"。
 *
 * 口径：trim → 去空 → 反斜杠转正斜杠 → 去尾分隔符（纯分隔符输入归一为 `/`）→ 按平台去重（win32 忽略大小写）。
 * @param platform 传入以便测试指定平台（默认取当前平台）
 */
/**
 * 安全地判断平台（**渲染层没有 `process`**：contextIsolation 下拿不到 Node 全局）。
 *
 * 这里必须用 `typeof process` 守卫：直接写 `process.platform` 作为默认参数会在渲染层
 * 抛 `ReferenceError: process is not defined` —— 本模块由设置页直接调用，一旦抛错，
 * 保存流程会在"算 patch"之前中断（表现为点「确定」毫无反应、未保存提示不消失）。
 */
function detectPlatform(): string {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') return process.platform
  // 渲染层：用 UA 近似（Windows 路径大小写不敏感这一点必须保住，否则与主进程去重口径不一致）
  if (typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)) return 'win32'
  return 'unknown'
}

export function normalizeAllowedRoots(input: unknown, platform?: string): string[] {
  const os = platform ?? detectPlatform()
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    const slashed = trimmed.replace(/\\/g, '/')
    // 纯分隔符（`/`、`//`、`///`）归一为文件系统根，避免落盘成 `///` 这种半成品
    const normalized = /^\/+$/.test(slashed) ? '/' : slashed.replace(/\/+$/, '')
    const key = os === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}
