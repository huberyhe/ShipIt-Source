// afterPack 钩子：用本地 rcedit 给打包后的 exe 设置图标与版本信息
// 背景：Windows 上 winCodeSign 解压符号链接需要管理员权限，故跳过
// signAndEditExecutable，改由这里手动调用 rcedit 完成资源编辑。
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function (context) {
  // 仅 Windows 需要
  if (process.platform !== 'win32') return

  const { appOutDir, packager } = context
  const exeName = `${packager.appInfo.productFilename}.exe`
  const exePath = path.join(appOutDir, exeName)
  const rcedit = path.join(__dirname, 'vendor', 'rcedit.exe')
  const icon = path.join(packager.projectDir, 'build', 'icon.ico')

  // rcedit 的版本号必须为 a.b.c.d 四段
  const ver = packager.appInfo.version
  const fullVer = ver.split('.').length === 3 ? ver + '.0' : ver

  const args = [
    exePath,
    '--set-icon', icon,
    '--set-version-string', 'ProductName', packager.appInfo.productName,
    '--set-version-string', 'FileDescription', packager.appInfo.description || packager.appInfo.productName,
    '--set-version-string', 'CompanyName', packager.appInfo.companyName || '',
    '--set-product-version', fullVer,
    '--set-file-version', fullVer
  ]

  // 文件可能被防病毒/系统短暂锁定，重试几次
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync(rcedit, args, { stdio: 'inherit' })
      console.log(`[afterPack] icon+version applied to ${exeName}`)
      return
    } catch (err) {
      lastErr = err
      console.warn(`[afterPack] rcedit attempt ${attempt}/3 failed: ${err.message}`)
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }
  console.error('[afterPack] rcedit failed after retries:', lastErr.message)
  throw lastErr
}
