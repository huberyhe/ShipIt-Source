import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_PORT,
  defaultServerConfig,
  generateToken,
  loadServerConfig,
  rotateToken,
  saveServerConfig,
  validateToken,
  connectionString,
  type ServerConfig
} from './server-config'
let dir = ''
let cfgPath = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipit-server-cfg-'))
  cfgPath = join(dir, 'deploy-config.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

import { discoverConnection } from '../../cli/discover'

describe('server-config', () => {
  it('AC-017 默认不开启服务（INV-4）', async () => {
    const cfg = await loadServerConfig(cfgPath)
    expect(cfg.enabled).toBe(false)
    expect(cfg.bind).toBe('local')
    expect(cfg.port).toBe(DEFAULT_PORT)
  })

  it('AC-017 配置文件不存在时不抛错，返回默认值', async () => {
    await expect(loadServerConfig(join(dir, 'nope', 'missing.json'))).resolves.toMatchObject({
      enabled: false,
      bind: 'local'
    })
  })

  it('AC-028 自定义令牌最短 16 字符', () => {
    expect(validateToken('12345678')).toMatchObject({ ok: false })
    expect(validateToken('0123456789abcdef')).toMatchObject({ ok: true })
    expect(validateToken('')).toMatchObject({ ok: false })
  })

  it('AC-028 随机令牌满足长度门槛且稳定（首次生成后持久化）', async () => {
    const first = await loadServerConfig(cfgPath)
    expect(first.tokenMode).toBe('random')
    expect(first.token.length).toBeGreaterThanOrEqual(16)
    const second = await loadServerConfig(cfgPath)
    expect(second.token).toBe(first.token)
    expect(generateToken()).not.toBe(first.token)
  })

  it('保存服务端配置时保留同文件内的其它配置（不破坏桌面配置）', async () => {
    writeFileSync(cfgPath, JSON.stringify({ recentProjects: ['D:/a'], deploymentTargets: [] }), 'utf-8')
    const saved = await saveServerConfig(cfgPath, { enabled: true, bind: 'lan', port: 4600 })
    if (!saved.ok) throw new Error(saved.reason)
    expect(saved.config).toMatchObject({ enabled: true, bind: 'lan', port: 4600 })
    const raw = JSON.parse(await (await import('fs')).promises.readFile(cfgPath, 'utf-8'))
    expect(raw.recentProjects).toEqual(['D:/a'])
    expect(raw.server.enabled).toBe(true)
  })

  it('DFX-OPS-004 开关与端口可管：非法输入被归一化（端口范围 / 绑定范围 / 令牌模式）', async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ server: { enabled: 'yes', bind: 'wan', port: 99999, tokenMode: 'x', token: 5 } }),
      'utf-8'
    )
    const cfg = await loadServerConfig(cfgPath)
    expect(cfg.enabled).toBe(false)
    expect(cfg.bind).toBe('local')
    expect(typeof cfg.port).toBe('number')
    expect(cfg.tokenMode).toBe('random')
    expect(typeof cfg.token).toBe('string')
  })

  it('P2 回归 令牌门槛不可绕过：空串/过短令牌一律拒绝，且不落盘（主进程才是可信边界）', async () => {
    const original = 'x'.repeat(16)
    writeFileSync(cfgPath, JSON.stringify({ server: { ...defaultServerConfig(), tokenMode: 'custom', token: original } }), 'utf-8')

    const empty = await saveServerConfig(cfgPath, { token: '' })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toContain('16')

    const short = await saveServerConfig(cfgPath, { token: 'short' })
    expect(short.ok).toBe(false)

    // random 模式下显式给过短令牌同样拒绝（曾可落盘 1 字符令牌）
    const randomShort = await saveServerConfig(cfgPath, { tokenMode: 'random', token: 'x' })
    expect(randomShort.ok).toBe(false)

    // 三次拒绝后，文件里仍是原来那个可用令牌（没有被写成不可用值）
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { server: ServerConfig }
    expect(raw.server.token).toBe(original)
  })

  it('P2 回归 空令牌 + random 模式：落盘的是生成出来的可用令牌（不留 expected 为空的死局）', async () => {
    const saved = await saveServerConfig(cfgPath, { enabled: true, tokenMode: 'random', token: '' })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(validateToken(saved.config.token).ok).toBe(true)

    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { server: ServerConfig }
    expect(validateToken(raw.server.token).ok).toBe(true)
  })

  it('P2 回归 仅改端口/开关时不被令牌长度阻断（配置里的旧令牌不动）', async () => {
    // 手工编辑过的配置：custom 模式 + 过短令牌
    writeFileSync(cfgPath, JSON.stringify({ server: { ...defaultServerConfig(), tokenMode: 'custom', token: 'short' } }), 'utf-8')

    const saved = await saveServerConfig(cfgPath, { enabled: true, port: 4600 })

    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.config.port).toBe(4600)
    expect(saved.config.enabled).toBe(true)

    // 没动令牌/模式 → 不因为「令牌长度」被拒；读取路径会自愈成可用令牌
    const reread = await loadServerConfig(cfgPath)
    expect(validateToken(reread.token).ok).toBe(true)
  })

  it('P2 回归 读取时自愈也覆盖 custom 模式：空令牌不留在文件里，服务端不会恒 401', async () => {
    writeFileSync(cfgPath, JSON.stringify({ server: { ...defaultServerConfig(), enabled: true, tokenMode: 'custom', token: '' } }), 'utf-8')

    const cfg = await loadServerConfig(cfgPath)

    expect(validateToken(cfg.token).ok).toBe(true)
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { server: ServerConfig }
    expect(raw.server.token).toBe(cfg.token)
    expect(validateToken(raw.server.token).ok).toBe(true)
  })

  it('P2 回归 读取时自愈：文件里 1 字符的随机令牌会被换掉并持久化（不再恒 401）', async () => {
    writeFileSync(cfgPath, JSON.stringify({ server: { ...defaultServerConfig(), enabled: true, token: 'x' } }), 'utf-8')

    const cfg = await loadServerConfig(cfgPath)
    expect(validateToken(cfg.token).ok).toBe(true)

    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { server: ServerConfig }
    expect(raw.server.token).toBe(cfg.token)
  })
})

describe('令牌轮换', () => {
  it('rotateToken 生成新令牌并持久化（显式语义，不依赖副作用顺序）', async () => {
    const before = await loadServerConfig(cfgPath)
    const after = await rotateToken(cfgPath)
    expect(after.tokenMode).toBe('random')
    expect(after.token).not.toBe(before.token)
    expect(after.token.length).toBeGreaterThanOrEqual(16)

    const reloaded = await loadServerConfig(cfgPath)
    expect(reloaded.token).toBe(after.token)
  })

  it('P3-9 无目录分隔符的配置路径不产生错误目录', async () => {
    const cwd = process.cwd()
    try {
      process.chdir(dir)
      await saveServerConfig('deploy-config.json', { enabled: true })
      expect(existsSync(join(dir, 'deploy-config.json'))).toBe(true)
      // 不应因 slice(0,-1) 造出形如 "deploy-config.jso" 的目录
      expect(readdirSync(dir).some((n) => n.startsWith('deploy-config.jso') && n !== 'deploy-config.json')).toBe(false)
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('导出连接串（主要给 CLI --connect 用）', () => {
  const connection = {
    host: '192.168.1.20',
    port: 4517,
    token: '0123456789abcdef',
    protocolVersion: 1,
    fingerprint: 'a'.repeat(64)
  }

  it('导出为单行压缩 JSON（粘贴进命令行不会断行）', () => {
    const text = connectionString(connection)
    expect(text).not.toContain('\n')
    expect(text.split('\n')).toHaveLength(1)
    expect(text.startsWith('{') && text.endsWith('}')).toBe(true)
    expect(text).not.toContain(': ') // 无缩进美化
  })

  it('字段齐备（host/port/token/protocolVersion/fingerprint）', () => {
    expect(JSON.parse(connectionString(connection))).toEqual(connection)
  })

  it('可直接喂给 CLI --connect（契约：同仓库两侧闭环）', () => {
    const r = discoverConnection({ env: {}, args: ['--connect', connectionString(connection)] })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.connection).toMatchObject({
      host: '192.168.1.20',
      port: 4517,
      token: '0123456789abcdef',
      protocolVersion: 1,
      fingerprint: connection.fingerprint,
      source: 'connect'
    })
  })
})
