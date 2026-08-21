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
  console.log('Building Vite...')
  execSync('vite build', { stdio: 'inherit', env })

  console.log('Building Electron installer...')
  execSync('electron-builder', { stdio: 'inherit', env })

  console.log(`\n✓ Build complete! Installer: ShipIt-v*-build${buildNumber}-x64.exe`)
} catch (err) {
  console.error('Build failed:', err.message)
  process.exit(1)
}
