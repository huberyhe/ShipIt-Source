/**
 * 守卫：渲染层引用的 `shared/` 模块**不得依赖 Node 全局**。
 *
 * 背景（真实事故）：`shared/allowed-roots.ts` 曾用 `platform: string = process.platform` 作默认参数。
 * 主进程调用没问题，但设置页（渲染进程）调用时抛 `ReferenceError: process is not defined`
 * （contextIsolation + nodeIntegration:false 下渲染层没有 `process`），
 * 表现为「点确定毫无反应、未保存提示不消失」——排查成本很高。
 *
 * 这里做静态检查：把渲染层真正 import 到的 shared 模块挑出来，扫描其中的 Node 全局/内置模块引用；
 * 允许 `typeof process` 这种**守卫式**访问（那正是跨进程模块的正确写法）。
 */
import { readFileSync, readdirSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')

function walk(dir: string, filter: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, filter))
    else if (filter(entry.name)) out.push(full)
  }
  return out
}

/** 从源码文本里抽出 `... from 'xxx'` / `import('xxx')` 的路径 */
function importSpecifiers(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  return out
}

describe('shared 模块必须跨进程安全（渲染层无 Node 全局）', () => {
  it('渲染层 import 到的 shared 模块不得裸用 process / Buffer / Node 内置模块', () => {
    const rendererFiles = walk(join(SRC, 'renderer'), (n) => /\.(ts|vue)$/.test(n) && !/\.spec\.ts$/.test(n))
    const sharedUsed = new Set<string>()
    for (const file of rendererFiles) {
      const text = readFileSync(file, 'utf-8')
      for (const spec of importSpecifiers(text)) {
        if (!spec.includes('shared/')) continue
        const abs = resolve(dirname(file), spec)
        for (const candidate of [`${abs}.ts`, join(abs, 'index.ts')]) {
          try {
            readFileSync(candidate)
            sharedUsed.add(candidate)
            break
          } catch {
            /* 继续尝试下一个候选 */
          }
        }
      }
    }
    // 前置条件：确实存在被渲染层引用的 shared 模块（否则本用例是空转）
    expect(sharedUsed.size).toBeGreaterThan(0)

    const violations: string[] = []
    for (const file of sharedUsed) {
      const lines = readFileSync(file, 'utf-8').split('\n')
      lines.forEach((line, index) => {
        const rel = relative(SRC, file).replace(/\\/g, '/') + ':' + (index + 1)
        const guarded = /typeof process/.test(line)
        if (/\bprocess\.[a-zA-Z]/.test(line) && !guarded) violations.push(`${rel} 裸用 process：${line.trim()}`)
        if (/\bBuffer\./.test(line)) violations.push(`${rel} 裸用 Buffer：${line.trim()}`)
        if (/\b__dirname\b|\b__filename\b/.test(line)) violations.push(`${rel} 裸用 __dirname/__filename：${line.trim()}`)
        if (/\brequire\(/.test(line)) violations.push(`${rel} 裸用 require：${line.trim()}`)
        if (/(?:from|import)\s*\(?\s*['"](?:fs|path|os|child_process|electron)['"]/.test(line)) {
          violations.push(`${rel} 引入 Node 内置/electron：${line.trim()}`)
        }
      })
    }
    expect(violations).toEqual([])
  })
})
