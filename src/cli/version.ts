/**
 * 版本口径：必须取自包版本，禁止硬编码（CON-3 / 铁律 6）。
 *
 * 两种发布形态都能读到版本：
 * - npm 包：`dist-cli/package.json` 与 `index.js` 同目录
 * - 安装包：CLI 入口随包放在 `<resources>/cli/`，同目录也有 package.json
 * 读取失败时返回 'unknown'，不伪造版本号。
 *
 * 刻意**不查 `process.cwd()`**：调用方可能从任意目录执行（含别的 Node 项目），
 * 那会把别人的版本当成 ShipIt 版本（违反铁律 6：版本号唯一来源是包清单）。
 */
import { readFileSync } from 'fs'
import { join } from 'path'

export function packageVersion(): string {
  const candidates = [
    // 打包产物：dist-cli/index.js → 同目录 package.json（CLI 包清单）
    join(__dirname, 'package.json'),
    join(__dirname, '..', 'package.json'),
    // 开发/测试期：src/cli/version.ts → 仓库根 package.json（仍是 ShipIt 自己的清单，不是"别人的"）
    join(__dirname, '..', '..', 'package.json')
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { name?: unknown; version?: unknown }
      // 身份校验：候选路径可能落在**别的 Node 工程**里（例如 CLI 被放进某项目子目录），
      // 不校验 name 就会把别人的版本当成本包版本（违反"版本号唯一来源"）。
      const nameOk = typeof parsed.name === 'string' && /shipit/i.test(parsed.name)
      if (nameOk && typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return 'unknown'
}
