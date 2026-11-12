/**
 * 渲染层的"失败必须可见"工具。
 *
 * 背景：多处 catch 是空的（`// ignore`），于是"磁盘只读导致主题没保存""目标列表加载失败"
 * 这类问题表现为"界面看起来正常"（主题改完重启又变回去、目标显示为空），
 * 用户与排查者都无从下手。这里统一为：`console.warn` 留痕 + 应用内提示（复用 ToastHost 的 toast 事件）。
 *
 * `silent` 用于启动期/高频路径（例如首帧主题读取），只留痕不弹提示，避免打扰。
 */
import { toastError } from './toast'

/**
 * 常见底层错误的"人话"映射。
 *
 * 用户不需要知道 `Timed out while waiting for handshake` / `ECONNREFUSED` 是什么，
 * 但需要知道"接下来该检查什么"。原始串保留在括号里，便于排查时对照日志。
 */
const FRIENDLY_ERRORS: Array<[RegExp, string]> = [
  [/Timed out while waiting for handshake|handshake timeout/i, '连接超时：目标服务器未响应'],
  [/ECONNREFUSED/i, '目标服务器拒绝连接（检查地址与端口）'],
  [/ECONNRESET|EPIPE/i, '连接被中断（网络波动或服务器主动断开）'],
  [/ENOTFOUND|EAI_AGAIN/i, '无法解析主机名（检查地址拼写与 DNS）'],
  [/EHOSTUNREACH|ENETUNREACH/i, '网络不可达（检查本机网络或 VPN）'],
  [/ENOENT/i, '文件不存在（可能已被删除或未提交）'],
  [/EACCES|EPERM/i, '没有操作权限（检查文件或目录权限）'],
  [/ENOSPC/i, '磁盘空间不足'],
  [/All configured authentication methods failed|Authentication failed|auth fail/i, '认证失败（检查用户名、密码或私钥）'],
  [/No such file/i, '远端路径不存在（检查目录映射）']
]

/**
 * 把任意错误转成**给用户看的**一句话。
 *
 * 两件事：
 * 1. 剥掉 Electron IPC 的包装 —— `ipcRenderer.invoke` 会把错误重写成
 *    `Error invoking remote method 'deploy:upload': Error: 真实原因`，直接展示等于泄底。
 * 2. 常见协议/文件系统错误换成人话（原始串保留在括号里）。
 */
export function userMessage (error: unknown): string {
  if (error === undefined || error === null) return ''
  const raw = error instanceof Error ? error.message : String(error)
  const unwrapped = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/s, '').trim()
  const text = unwrapped || raw
  for (const [pattern, friendly] of FRIENDLY_ERRORS) {
    if (pattern.test(text)) {
      const brief = text.length > 120 ? `${text.slice(0, 120)}…` : text
      return `${friendly}（${brief}）`
    }
  }
  return text
}

export function reportError(action: string, error?: unknown, options: { silent?: boolean } = {}): void {
  const detail = userMessage(error)
  const message = detail ? `${action}：${detail}` : action
  // 留痕用原始错误（日志要给排查者看技术细节），提示用人话
  console.warn('[shipit]', action, error ?? '')
  if (!options.silent) {
    toastError(message)
  }
}

/** 只留痕不打扰（启动期、轮询等高频路径用） */
export function warnOnly(action: string, error?: unknown): void {
  reportError(action, error, { silent: true })
}
