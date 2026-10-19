/**
 * 内置自签 TLS 证书：生成 / 加载 / 指纹。
 *
 * 通道强制加密（INV-4），客户端固定指纹（INV-11）：指纹变化即拒绝连接。
 * 证书与私钥只落盘到用户数据目录，私钥不出进程、不入输出与日志（INV-5）。
 */
import { createHash, createPrivateKey, X509Certificate } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import selfsigned from 'selfsigned'
import { matchesFingerprint } from '../../shared/fingerprint'

export interface TlsMaterial {
  cert: string
  key: string
  /** 证书 DER 的 SHA-256，小写十六进制（64 字符） */
  fingerprint: string
  certPath: string
  keyPath: string
  /** 本次调用是否新生成（false 表示复用已有文件） */
  created: boolean
}

/** 证书主体名与有效期（10 年；自签证书按指纹固定，长期有效避免频繁轮换） */
export const CERT_COMMON_NAME = 'shipit-local'
export const CERT_VALIDITY_DAYS = 3650

const DAY_MS = 24 * 60 * 60 * 1000

export const certPaths = (dir: string): { certPath: string; keyPath: string } => ({
  certPath: join(dir, 'cert.pem'),
  keyPath: join(dir, 'key.pem')
})

/** 计算证书指纹：PEM 去壳后 DER 的 SHA-256，小写十六进制 */
export function computeFingerprint(certPem: string): string {
  const der = Buffer.from(
    certPem
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s+/g, ''),
    'base64'
  )
  return createHash('sha256').update(der).digest('hex')
}

/**
 * 校验实际指纹是否与固定指纹一致（AC-027）。
 * 归一化与比较逻辑在 `shared/fingerprint.ts`，前端（CLI/MCP）复用同一实现。
 */
export { matchesFingerprint }

/**
 * 校验证书与私钥是否配对（含可解析性）。
 *
 * 不配对的一对会让 `createHttpsServer` 同步抛错（服务根本起不来），
 * 而且客户端固定指纹一旦跟着漂移，所有已配对客户端都会 TLS_MISMATCH。
 */
export function isKeyPairMatch(certPem: string, keyPem: string): boolean {
  try {
    return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem))
  } catch {
    return false
  }
}

/**
 * 确保自签证书存在：已存在**且配对可用**则加载，否则生成并落盘。
 * 首次生成后指纹固定，直到证书被删除/轮换（轮换后客户端必须重新取得指纹）。
 */
export async function ensureSelfSignedCert(dir: string): Promise<TlsMaterial> {
  const { certPath, keyPath } = certPaths(dir)

  if (existsSync(certPath) && existsSync(keyPath)) {
    const [cert, key] = await Promise.all([fs.readFile(certPath, 'utf-8'), fs.readFile(keyPath, 'utf-8')])
    // 损坏或失配 → 不返回，落到下面重新生成（自愈：否则会留下永久起不来的一对文件）
    if (isKeyPairMatch(cert, key)) {
      return { cert, key, fingerprint: computeFingerprint(cert), certPath, keyPath, created: false }
    }
  }

  // 注意：selfsigned@5 没有 `days` 选项（旧 node-forge 写法会静默失效，默认只有 365 天），
  // 有效期必须用 notAfterDate 表达；这里不做类型断言，让类型检查守住选项名。
  const pems = await selfsigned.generate([{ name: 'commonName', value: CERT_COMMON_NAME }], {
    notAfterDate: new Date(Date.now() + CERT_VALIDITY_DAYS * DAY_MS),
    algorithm: 'sha256',
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' }
        ]
      }
    ]
  })

  const cert = pems.cert
  const key = pems.private

  await fs.mkdir(dir, { recursive: true })
  // 先写临时文件再改名：中途失败不会留下半截 PEM（半截 PEM 会在下次启动被当成「损坏」而重新生成，
  // 等于白白轮换一次指纹）。改名本身是原子的，配合加载时的配对校验，撕裂的一对也能自愈。
  const certTmp = `${certPath}.tmp`
  const keyTmp = `${keyPath}.tmp`
  await fs.writeFile(certTmp, cert, 'utf-8')
  await fs.writeFile(keyTmp, key, { encoding: 'utf-8', mode: 0o600 })
  await fs.rename(certTmp, certPath)
  await fs.rename(keyTmp, keyPath)

  return { cert, key, fingerprint: computeFingerprint(cert), certPath, keyPath, created: true }
}
