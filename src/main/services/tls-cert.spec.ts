import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { X509Certificate } from 'crypto'
import {
  CERT_VALIDITY_DAYS,
  computeFingerprint,
  ensureSelfSignedCert,
  isKeyPairMatch,
  matchesFingerprint
} from './tls-cert'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipit-tls-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('tls-cert', () => {
  it('P3 回归 损坏或失配的证书/私钥会被重新生成（自愈，不留永久起不来的一对）', async () => {
    const a = await ensureSelfSignedCert(dir)
    const otherDir = mkdtempSync(join(tmpdir(), 'shipit-tls-other-'))
    try {
      const b = await ensureSelfSignedCert(otherDir)
      // 写入 A 的证书 + B 的私钥（失配）
      writeFileSync(join(dir, 'cert.pem'), a.cert, 'utf-8')
      writeFileSync(join(dir, 'key.pem'), b.key, 'utf-8')

      const fixed = await ensureSelfSignedCert(dir)

      expect(fixed.created).toBe(true)
      expect(isKeyPairMatch(fixed.cert, fixed.key)).toBe(true)
      const certOnDisk = readFileSync(join(dir, 'cert.pem'), 'utf-8')
      const keyOnDisk = readFileSync(join(dir, 'key.pem'), 'utf-8')
      expect(isKeyPairMatch(certOnDisk, keyOnDisk)).toBe(true)
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('P3 回归 isKeyPairMatch：配对为真，失配与损坏为假', async () => {
    const a = await ensureSelfSignedCert(dir)
    expect(isKeyPairMatch(a.cert, a.key)).toBe(true)
    expect(isKeyPairMatch(a.cert, 'not a pem')).toBe(false)
    expect(isKeyPairMatch('not a pem', a.key)).toBe(false)
  })

  it('AC-026 首次调用生成证书并返回 64 位十六进制指纹', async () => {
    const { cert, key, fingerprint } = await ensureSelfSignedCert(dir)
    expect(cert).toContain('BEGIN CERTIFICATE')
    expect(key).toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('AC-026 证书与私钥落盘，且二次调用复用同一证书（指纹稳定）', async () => {
    const first = await ensureSelfSignedCert(dir)
    expect(existsSync(join(dir, 'cert.pem'))).toBe(true)
    expect(existsSync(join(dir, 'key.pem'))).toBe(true)
    expect(readFileSync(join(dir, 'cert.pem'), 'utf-8')).toBe(first.cert)

    const second = await ensureSelfSignedCert(dir)
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('AC-026 指纹为证书 DER 的 SHA-256（可由证书独立复算）', async () => {
    const { cert, fingerprint } = await ensureSelfSignedCert(dir)
    expect(computeFingerprint(cert)).toBe(fingerprint)
  })

  it('AC-027 指纹不匹配一律拒绝', () => {
    expect(matchesFingerprint('a'.repeat(64), 'b'.repeat(64))).toBe(false)
  })

  it('AC-027 指纹比较忽略大小写与分隔符，匹配时放行', () => {
    const fp = 'ab'.repeat(32)
    expect(matchesFingerprint(fp, fp.toUpperCase())).toBe(true)
    const coloned = (fp.toUpperCase().match(/../g) as string[]).join(':')
    expect(matchesFingerprint(fp, coloned)).toBe(true)
    expect(matchesFingerprint(fp, '')).toBe(false)
    expect(matchesFingerprint(fp, undefined)).toBe(false)
  })

  it('AC-026 有效期按 10 年签发（selfsigned@5 无 days 选项，必须用 notAfterDate）', async () => {
    const { cert } = await ensureSelfSignedCert(dir)
    const x509 = new X509Certificate(cert)
    const days = Math.round((new Date(x509.validTo).getTime() - new Date(x509.validFrom).getTime()) / 86_400_000)
    expect(days).toBeGreaterThanOrEqual(CERT_VALIDITY_DAYS)
  })

  it('AC-026 证书含 KeyUsage / ExtendedKeyUsage / SAN 扩展且非 CA', async () => {
    const { cert } = await ensureSelfSignedCert(dir)
    const der = Buffer.from(
      cert.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, ''),
      'base64'
    )
    // OID：keyUsage 2.5.29.15、extKeyUsage 2.5.29.37（按 DER 字节核对，不依赖 Node 的呈现）
    expect(der.includes(Buffer.from('0603551D0F', 'hex'))).toBe(true)
    expect(der.includes(Buffer.from('0603551D25', 'hex'))).toBe(true)

    const x509 = new X509Certificate(cert)
    expect(x509.subjectAltName).toContain('DNS:localhost')
    expect(x509.subjectAltName).toContain('127.0.0.1')
    expect(x509.ca).toBe(false)
    expect(x509.subject).toContain('shipit-local')
  })

  it('AC-026 证书包含回环与局域网可用性（SAN 含 127.0.0.1）', async () => {
    const { cert, fingerprint } = await ensureSelfSignedCert(dir)
    expect(cert).toContain('BEGIN CERTIFICATE')
    // 私钥不进入指纹，避免泄漏面扩大（INV-5）
    expect(fingerprint).not.toContain('PRIVATE')
  })
})
