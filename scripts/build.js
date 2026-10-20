// Build script with build number
// Generates installer: ShipIt-v1.0.0-build202608211234-x64.exe

const { execSync } = require('child_process')
const path = require('path')

// Generate build number from timestamp: YYYYMMDDHHmm
const now = new Date()
const buildNumber = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
  String(now.getHours()).padStart(2, '0'),
  String(now.getMinutes()).padStart(2, '0')
].join('')

console.log(`Build number: ${buildNumber}`)

const env = {
  ...process.env,
  BUILD_NUMBER: buildNumber,
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

try {
  // 与 CI 口径一致：CI 会跑 vue-tsc，本地跳过会产出「CI 直接拒收」的包
  console.log('Type checking...')
  execSync('npm run type-check', { stdio: 'inherit', env })

  console.log('Building CLI / MCP bundle...')
  // CLI 入口随安装包提供（spec：三平台产物含 CLI 入口），放在安装目录的 cli/（与可执行文件同级）
  execSync('node scripts/build-cli.js', { stdio: 'inherit', env })

  console.log('Building Vite...')
  execSync('vite build', { stdio: 'inherit', env })

  console.log('Building Electron installer...')
  // --publish never：本地打包不上传 Release。
  // 注：脚本会给子进程注入 BUILD_NUMBER，而 electron-builder 把该变量当作 CI 标识，
  // 不显式关闭会尝试发布到 GitHub Release 并因缺少 GH_TOKEN 报错（安装包已生成但退出码为 1）。
  execSync('electron-builder --publish never', { stdio: 'inherit', env })

  console.log(`\n✓ Build complete! Installer: ShipIt-v*-build${buildNumber}-x64.exe`)
} catch (err) {
  console.error('Build failed:', err.message)
  process.exit(1)
}
