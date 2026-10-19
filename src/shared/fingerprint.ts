/**
 * 证书指纹归一化与比较（前端与后端共用）。
 *
 * 单独成模块是为了让 CLI/MCP 前端只依赖这一小段纯逻辑，
 * 而不必把证书生成（selfsigned）带进前端包。
 */

/** 去掉非十六进制字符并转小写；输入缺失时返回空串 */
export function normalizeFingerprint(value?: string | null): string {
  return typeof value === 'string' ? value.replace(/[^0-9a-fA-F]/g, '').toLowerCase() : ''
}

/** 指纹是否一致；任一侧缺失即不匹配（AC-027 / INV-11） */
export function matchesFingerprint(expected?: string | null, actual?: string | null): boolean {
  const e = normalizeFingerprint(expected)
  const a = normalizeFingerprint(actual)
  return e !== '' && e === a
}
