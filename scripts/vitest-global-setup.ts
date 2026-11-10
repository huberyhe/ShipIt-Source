/**
 * Vitest 全局前置：保证进程级用例依赖的构建产物存在且新鲜。
 *
 * 背景：`server/lifecycle`、`server/runtime`、`cli-e2e`、`main/server-host`、`main/adapter-factory`
 * 这些用例会真的 fork `dist-server/index.js`。它不在 `src/` 里，也不由 vitest 转译，
 * 所以「先 `npm run build:server` 再测」曾是一条口口相传的前置条件 —— 漏掉时的表现是
 * 一堆看起来像功能缺陷的失败（`MODULE_NOT_FOUND` / 后端起不来）。
 *
 * 这里在测试开始前检查：产物缺失，或 `src/server/**` 里有比它更新的文件，就重新构建（约 1 秒）。
 */
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const BUNDLE = join(ROOT, 'dist-server', 'index.js')
const SERVER_SRC = join(ROOT, 'src', 'server')

/** 递归取目录内 .ts 文件的最新 mtime；目录不存在时返回 0 */
function newestSourceMtime (dir: string): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(full).mtimeMs)
  }
  return newest
}

export default function setup (): void {
  const bundleMtime = existsSync(BUNDLE) ? statSync(BUNDLE).mtimeMs : 0
  const stale = bundleMtime === 0 || newestSourceMtime(SERVER_SRC) > bundleMtime
  if (!stale) return

  process.stderr.write('[vitest] dist-server 缺失或过期，先构建（进程级用例依赖它）\n')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.js')], { stdio: 'inherit', cwd: ROOT })
}
