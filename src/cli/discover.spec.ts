import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkFingerprint, defaultUserDataDir, discoverConnection, isValidProfileName } from './discover'

let dir = ''
let home = ''

const writeInfo = (targetDir: string, info: Record<string, unknown>): void => {
  writeFileSync(join(targetDir, 'server.json'), JSON.stringify(info), 'utf-8')
}

const validInfo = {
  port: 4517,
  token: '0123456789abcdef',
  protocolVersion: 1,
  fingerprint: 'a'.repeat(64),
  pid: 1234
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipit-discover-'))
  home = mkdtempSync(join(tmpdir(), 'shipit-home-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('discover', () => {
  it('AC-015 未提供端口与令牌参数也能发现连接信息（SHIPIT_HOME）', () => {
    writeInfo(home, validInfo)
    const r = discoverConnection({ env: { SHIPIT_HOME: home }, args: [] })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.connection.port).toBe(4517)
    expect(r.connection.token.length).toBeGreaterThanOrEqual(16)
    expect(r.connection.source).toBe('shipit-home')
  })

  it('AC-015 --connect 直接给连接串，优先于 SHIPIT_HOME', () => {
    writeInfo(home, validInfo)
    const connectionString = JSON.stringify({ ...validInfo, port: 4600 })

    const r = discoverConnection({ env: { SHIPIT_HOME: home }, args: ['--connect', connectionString] })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.connection.port).toBe(4600)
    expect(r.connection.source).toBe('connect')
    expect(r.connection.file).toBeUndefined()
  })

  it('AC-015 连接串可携带远端 host（跨机器）', () => {
    const connectionString = JSON.stringify({ ...validInfo, host: '192.168.1.20' })
    const r = discoverConnection({ env: {}, args: ['--connect', connectionString] })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.connection.host).toBe('192.168.1.20')
  })

  it('AC-015 --connect=<连接串> 写法等价（等号形式）', () => {
    const connectionString = JSON.stringify({ ...validInfo, port: 4700 })
    const r = discoverConnection({ env: {}, args: [`--connect=${connectionString}`] })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.connection.port).toBe(4700)
  })

  it('AC-020 连接串不是合法 JSON / 缺字段时按后端不可用拒绝', () => {
    for (const value of ['not-json', '{"port":4517}', '{}']) {
      const r = discoverConnection({ env: {}, args: ['--connect', value] })
      expect(r.ok, value).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('BACKEND_UNAVAILABLE')
    }
  })

  it('AC-014 --connect 缺连接串按用法错误拒绝（提示带示例）', () => {
    const r = discoverConnection({ env: {}, args: ['--connect'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('USAGE')
    expect(r.error.hint ?? '').toContain('导出连接串')
  })

  it('AC-026 --profile 读取本机命名连接配置（含远端 host 与指纹）', () => {
    const { mkdirSync } = require('fs') as typeof import('fs')
    mkdirSync(join(home, 'profiles'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'peer.json'),
      JSON.stringify({ ...validInfo, host: '192.168.1.30' }),
      'utf-8'
    )
    const r = discoverConnection({ env: { SHIPIT_HOME: home }, args: ['--profile', 'peer'] })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.connection).toMatchObject({ source: 'profile', host: '192.168.1.30' })
  })

  it('AC-020 profile 不存在时返回后端不可用', () => {
    const r = discoverConnection({ env: { SHIPIT_HOME: home }, args: ['--profile', 'missing'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('BACKEND_UNAVAILABLE')
  })

  it('P3-13 非法 profile 名（路径穿越）按用法错误拒绝', () => {
    for (const name of ['../secret', 'a/b', '..', 'a b', 'a\\b']) {
      const r = discoverConnection({ env: { SHIPIT_HOME: home }, args: ['--profile', name] })
      expect(r.ok, name).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('USAGE')
    }
    expect(discoverConnection({ env: { SHIPIT_HOME: home }, args: ['--profile', 'peer_1.dev'] }).ok).toBe(false)
  })

  it('CON-7 不接受裸端口与裸令牌参数，按用法错误拒绝', () => {
    for (const args of [['--port', '4517'], ['--token', '0123456789abcdef'], ['--token=abc'], ['--port=4517']]) {
      const r = discoverConnection({ env: { SHIPIT_HOME: home }, args })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.code).toBe('USAGE')
    }
  })

  it('AC-020 连接信息文件缺失时返回后端不可用（不要求用户手填）', () => {
    const r = discoverConnection({ env: { SHIPIT_HOME: home }, args: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('BACKEND_UNAVAILABLE')
  })

  it('AC-020 连接信息字段缺失时视为不可用', () => {
    writeInfo(home, { port: 4517 })
    const r = discoverConnection({ env: { SHIPIT_HOME: home }, args: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('BACKEND_UNAVAILABLE')
  })

  it('AC-020 连接信息文件不是合法 JSON 时视为不可用', () => {
    writeFileSync(join(home, 'server.json'), '{ not json', 'utf-8')
    const r = discoverConnection({ env: { SHIPIT_HOME: home }, args: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('BACKEND_UNAVAILABLE')
  })

  it('AC-027 已固定指纹与服务端不一致时拒绝连接', () => {
    expect(checkFingerprint('a'.repeat(64), 'b'.repeat(64))).toBe(false)
  })

  it('AC-027 指纹一致（忽略大小写与分隔符）时放行，缺失即拒绝', () => {
    const fp = 'ab'.repeat(32)
    expect(checkFingerprint(fp, fp.toUpperCase())).toBe(true)
    expect(checkFingerprint(fp, fp)).toBe(true)
    expect(checkFingerprint(fp, '')).toBe(false)
    expect(checkFingerprint('', fp)).toBe(false)
  })

  it('DFX-PORT-001 三平台默认用户数据目录', () => {
    expect(defaultUserDataDir({ platform: 'win32', env: { APPDATA: 'C:/Users/me/AppData/Roaming' }, home: 'C:/Users/me' })).toBe(
      join('C:/Users/me/AppData/Roaming', 'shipit')
    )
    expect(
      defaultUserDataDir({ platform: 'darwin', env: {}, home: '/Users/me' })
    ).toBe(join('/Users/me', 'Library', 'Application Support', 'shipit'))
    expect(defaultUserDataDir({ platform: 'linux', env: {}, home: '/home/me' })).toBe(join('/home/me', '.config', 'shipit'))
    expect(
      defaultUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/me/.config-custom' }, home: '/home/me' })
    ).toBe(join('/home/me/.config-custom', 'shipit'))
  })

  it('DFX-CMP-005 发现结果回显协议版本，供前端比对', () => {
    writeInfo(home, validInfo)
    const r = discoverConnection({ env: { SHIPIT_HOME: home }, args: [] })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.connection.protocolVersion).toBe(1)
    expect((r.connection.file ?? '').endsWith('server.json')).toBe(true)
  })
})

describe('profile 名白名单', () => {
  it('接受普通名称，拒绝路径与穿越写法', () => {
    expect(isValidProfileName('peer')).toBe(true)
    expect(isValidProfileName('peer-1.dev_2')).toBe(true)
    expect(isValidProfileName('../peer')).toBe(false)
    expect(isValidProfileName('a/b')).toBe(false)
    expect(isValidProfileName('..')).toBe(false)
    expect(isValidProfileName('a\\b')).toBe(false)
  })
})
