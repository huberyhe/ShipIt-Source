/**
 * 构建「绿色免安装」包（Windows）。
 *
 * 产物：
 * - release/ShipIt-green/        解压即用的目录（含 portable.txt → 数据随身）
 * - release/ShipIt-green-x64.zip 分发包（解压后直接运行 ShipIt.exe）
 *
 * 说明：
 * - 数据目录会写到 <程序目录>/shipit-data（见 main 入口的 applyPortableDataDir）
 * - 后端 dist-server 与 CLI 随包提供；backend=process 时同样可用
 */
const { execSync } = require('child_process')
const { cpSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const UNPACKED = join(ROOT, 'release', 'win-unpacked')
const OUT = join(ROOT, 'release', 'ShipIt-green')
const ZIP = join(ROOT, 'release', 'ShipIt-green-x64.zip')

function run (cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: ROOT })
}

// 打包前清掉可能占用文件的实例（否则 electron-builder 报 ENOENT）
if (process.platform === 'win32') {
  try {
    execSync('taskkill /F /IM ShipIt.exe', { stdio: 'ignore' })
  } catch {
    // 没有在跑
  }
}

console.log('[green] 构建后端 / CLI / 前端')
run('node scripts/build-server.js')
run('node scripts/build-cli.js')
run('npx vite build')

console.log('[green] 目录打包')
run('npx electron-builder --win dir')

console.log('[green] 组装绿色目录')
rmSync(OUT, { recursive: true, force: true })
cpSync(UNPACKED, OUT, { recursive: true })
writeFileSync(
  join(OUT, 'portable.txt'),
  '便携模式：配置、证书与连接信息写在 shipit-data/，不写 %APPDATA%。删除本文件即恢复默认行为。\n',
  'utf-8'
)

console.log('[green] 压缩 zip')
rmSync(ZIP, { force: true })
run(`powershell -NoProfile -Command "Compress-Archive -Path '${OUT}' -DestinationPath '${ZIP}' -Force"`)

console.log(`[green] 完成：${ZIP}`)
