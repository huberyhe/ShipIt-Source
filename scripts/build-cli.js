/**
 * 构建 CLI / MCP 前端产物（dist-cli/）。
 *
 * 产出：
 * - `dist-cli/index.js`：`shipit` 命令入口（esbuild 打成单文件 CJS，携带 shebang）
 * - `dist-cli/package.json`：发布用的包清单（包名 @huberyhe/shipit-mcp，版本取自根 package.json，CON-3 / CON-4）
 * - `dist-cli/README.md`、`dist-cli/LICENSE`：随包文档
 *
 * 只发布构建产物，不含业务源码（CON-11）；发布命令：`npm publish ./dist-cli --access public`
 * （必须带 ./ 前缀：裸目录名会被 npm 当作 registry 上的包名，报 404）
 */
const { build } = require('esbuild')
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'dist-cli')
const NPM_PACKAGE_NAME = '@huberyhe/shipit-mcp'

function rootManifest() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
}

async function bundle(root) {
  await build({
    entryPoints: [join(ROOT, 'src/cli/index.ts')],
    outfile: join(OUT_DIR, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    // 全部依赖打进产物（**故意不留 external**）：
    // 安装包把 dist-cli 原样复制到 <安装目录>/resources/cli，不会带 node_modules，
    // 一旦把 MCP SDK 当外部依赖，用「安装包内入口」启动 MCP 就会 MODULE_NOT_FOUND，
    // 只有 npx 形态能用（而文档两种形态都推荐了）。自包含后两种形态一致可用。
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'info'
  })

  if (process.platform !== 'win32') {
    chmodSync(join(OUT_DIR, 'index.js'), 0o755)
  }

  const manifest = {
    name: NPM_PACKAGE_NAME,
    version: root.version,
    description: 'ShipIt CLI / MCP —— 通过本机桌面版执行部署与查询',
    license: root.license,
    author: root.author,
    repository: root.repository,
    bin: { shipit: 'index.js' },
    main: 'index.js',
    files: ['index.js', 'README.md', 'LICENSE'],
    engines: { node: '>=20' },
    // 产物自包含（无 external），因此声明为零运行时依赖：npx 形态也不需要额外安装依赖
    dependencies: {},
    publishConfig: { access: 'public' }
  }
  writeFileSync(join(OUT_DIR, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
}

/**
 * 随包文档。
 *
 * README 用**面向使用者**的 `docs/CLI-RELEASE-README.md`（npm 页面就是它），
 * 不要直接复制仓库根 README —— 那是面向开发者的项目说明（目录结构/构建命令），
 * 对 `npm install` 的人没有用，也没解释「这是桌面版的配套 MCP 工具」。
 */
function copyDocs() {
  const sources = [
    ['README.md', join(ROOT, 'docs', 'CLI-RELEASE-README.md')],
    ['LICENSE', join(ROOT, 'LICENSE')]
  ]
  for (const [name, from] of sources) {
    if (existsSync(from)) copyFileSync(from, join(OUT_DIR, name))
    else console.warn(`[build-cli] 缺少 ${from}，发布包将不含 ${name}`)
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const root = rootManifest()
  await bundle(root)
  copyDocs()
  console.log(`[build-cli] 完成：${NPM_PACKAGE_NAME}@${root.version} → dist-cli/`)
}

main().catch((error) => {
  console.error('[build-cli] 构建失败：', error)
  process.exitCode = 1
})
