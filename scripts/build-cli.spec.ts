/**
 * CLI 产物与发布清单核对（任务 15 / CON-11 / CON-5）。
 *
 * 纯静态核对根清单与构建脚本声明，不依赖构建顺序；
 * 产物本身在 `npm run build:cli` 后由 `npm pack --dry-run` 核对（见计划检查点）。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
  name: string
  version: string
  bin?: Record<string, string>
  files?: string[]
  scripts?: Record<string, string>
  license?: string
  dependencies?: Record<string, string>
}

describe('发布清单（CON-11）', () => {
  it('CON-11 npm 包只包含构建产物白名单', () => {
    expect(manifest.files).toEqual(expect.arrayContaining(['dist-cli/', 'README.md', 'LICENSE']))
    expect((manifest.files ?? []).some((f) => f.startsWith('src/'))).toBe(false)
    expect((manifest.files ?? []).some((f) => f.startsWith('scripts/'))).toBe(false)
  })

  it('CON-11 不把桌面端构建产物打进 CLI 包（dist / dist-electron / release 均不在白名单）', () => {
    for (const forbidden of ['dist/', 'dist-electron/', 'release/']) {
      expect(manifest.files ?? []).not.toContain(forbidden)
    }
  })

  it('提供 shipit 命令入口（bin 指向 dist-cli）', () => {
    expect(manifest.bin?.shipit).toBe('dist-cli/index.js')
  })

  it('提供 build:cli 脚本与 LICENSE（发布到公共 npm 的必备项）', () => {
    expect(manifest.scripts?.['build:cli']).toBe('node scripts/build-cli.js')
    expect(manifest.license).toBeTruthy()
    expect(existsSync(join(ROOT, 'LICENSE'))).toBe(true)
  })
})

describe('依赖白名单（CON-5 / DFX-COST-003）', () => {
  it('运行时依赖只允许既有依赖 + selfsigned + @modelcontextprotocol/sdk', () => {
    const allowed = [
      '@modelcontextprotocol/sdk',
      'basic-ftp',
      'lucide-vue-next',
      'pinia',
      'selfsigned',
      'simple-git',
      'ssh2-sftp-client',
      'vue'
    ]
    const actual = Object.keys(manifest.dependencies ?? {}).sort()
    expect(actual.filter((d) => !allowed.includes(d))).toEqual([])
    expect(actual).toEqual([...allowed].sort())
  })

  it('CON-5 未引入白名单外的依赖（含传递依赖声明）', () => {
    const dependencies = manifest.dependencies ?? {}
    expect(Object.keys(dependencies)).toHaveLength(8)
  })
})

describe('构建脚本声明（版本与包名口径）', () => {
  const script = readFileSync(join(ROOT, 'scripts', 'build-cli.js'), 'utf-8')

  it('CON-3 版本取自根 package.json，不硬编码', () => {
    expect(script).toContain('root.version')
    expect(script).not.toMatch(/version:\s*['"]\d+\.\d+\.\d+['"]/)
  })

  it('CON-11 产物目录与包名符合决策（dist-cli / @huberyhe/shipit-mcp）', () => {
    expect(script).toContain("'dist-cli'")
    expect(script).toContain('@huberyhe/shipit-mcp')
  })

  it('入口产物带 shebang，可被 npm bin 直接执行', () => {
    expect(script).toContain('#!/usr/bin/env node')
  })
})

describe('CI 配置（构建与发布分离）', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'build.yml'), 'utf-8')

  it('DFX-TST-004 / DFX-CMP-001 CI 覆盖三平台矩阵并运行单元测试', () => {
    expect(workflow).toContain('npm test')
    // 三平台可用性由 CI 矩阵承接（本地无法替代实机验证）
    for (const runner of ['windows-latest', 'ubuntu-latest', 'macos-latest']) {
      expect(workflow).toContain(runner)
    }
  })

  it('CI 在打 tag 时发布 npm 包，并使用 NPM_TOKEN', () => {
    expect(workflow).toContain('npm run build:cli')
    expect(workflow).toContain('npm publish')
    expect(workflow).toContain('NPM_TOKEN')
  })

  it('P1-1 发布命令使用 ./dist-cli（裸目录名会被当作包名，报 404）', () => {
    expect(workflow).toContain('npm publish ./dist-cli')
    expect(workflow).not.toMatch(/npm publish dist-cli/)
    expect(manifest.scripts?.['publish:cli']).toContain('npm publish ./dist-cli')
  })

  it('P1-4 CI 发布步骤的条件必须引用矩阵里真实存在的平台值（避免条件恒假）', () => {
    const matrixPlatforms = [...workflow.matchAll(/platform:\s*(\w+)/g)].map((m) => m[1])
    expect(matrixPlatforms.length).toBeGreaterThan(0)
    const conditions = [...workflow.matchAll(/matrix\.platform == '(\w+)'/g)].map((m) => m[1])
    expect(conditions.length).toBeGreaterThan(0)
    for (const value of conditions) {
      expect(matrixPlatforms, `条件里的平台 ${value} 不在矩阵取值中，该步骤永不执行`).toContain(value)
    }
  })

  it('P1-5 三平台打包前先构建 dist-cli（否则安装包静默缺少 cli/）', () => {
    const buildCliAt = workflow.indexOf('npm run build:cli')
    const firstBuilderAt = workflow.indexOf('npx electron-builder')
    expect(buildCliAt).toBeGreaterThan(-1)
    expect(firstBuilderAt).toBeGreaterThan(-1)
    expect(buildCliAt).toBeLessThan(firstBuilderAt)
    expect(workflow).toContain('test -f dist-cli/index.js')
  })
  it('P2 回归 CLI 产物自包含：不得把 MCP SDK 当外部依赖（安装包内没有 node_modules）', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'build-cli.js'), 'utf-8')
    // 不得出现 esbuild 的 external 选项（注释里提到该词是允许的，按选项行匹配）
    expect(script).not.toMatch(/^\s*external:/m)
    expect(script).toContain('dependencies: {}')

    // 产物（若已构建）不得出现对 SDK 的运行时 require
    const bundlePath = join(ROOT, 'dist-cli', 'index.js')
    if (existsSync(bundlePath)) {
      const bundle = readFileSync(bundlePath, 'utf-8')
      expect(bundle).not.toMatch(/require\(["']@modelcontextprotocol\/sdk/)
      expect(bundle).not.toMatch(/__require\(["']@modelcontextprotocol\/sdk/)
    }

    // 已生成的发布清单也要校验（真正被发布的是它，而不是根清单）
    const publishedPath = join(ROOT, 'dist-cli', 'package.json')
    if (existsSync(publishedPath)) {
      const published = JSON.parse(readFileSync(publishedPath, 'utf-8')) as {
        name?: string
        version?: string
        bin?: Record<string, string>
        files?: string[]
        dependencies?: Record<string, string>
        engines?: Record<string, string>
      }
      expect(published.name).toBe('@huberyhe/shipit-mcp')
      // 版本必须与根清单一致（CON-3/CON-4：版本唯一来源）
      expect(published.version).toBe(manifest.version)
      expect(published.bin?.shipit).toBe('index.js')
      expect(published.files).toEqual(['index.js', 'README.md', 'LICENSE'])
      expect(published.engines?.node).toBe('>=20')
      expect(Object.keys(published.dependencies ?? {})).toHaveLength(0)
    }
  })

  it('P1-3 CI 配置 registry 认证（setup-node registry-url，供 NODE_AUTH_TOKEN 生效）', () => {
    expect(workflow).toContain('registry-url')
    expect(workflow).toContain('registry.npmjs.org')
  })

  it('P2 回归 src/cli 必须纳入 tsconfig（否则 CLI / MCP 代码不受类型检查）', () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf-8')) as { include?: string[] }
    expect(tsconfig.include).toContain('src/cli/**/*.ts')
  })
})
