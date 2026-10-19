/**
 * P3 回归：版本号唯一来源是包清单（铁律 6）。
 * 此前 `packageVersion()` 会兜底读 `process.cwd()/package.json`，
 * 在别人的 Node 项目里执行就把别人的版本当成了 ShipIt 版本。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { packageVersion } from './version'

describe('version（P3 回归）', () => {
  it('不把当前工作目录的 package.json 当成本工具版本', () => {
    const other = mkdtempSync(join(tmpdir(), 'shipit-other-'))
    const cwd = process.cwd()
    try {
      writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'other', version: '9.9.9' }), 'utf-8')
      process.chdir(other)
      expect(packageVersion()).not.toBe('9.9.9')
    } finally {
      process.chdir(cwd)
      rmSync(other, { recursive: true, force: true })
    }
  })
})
