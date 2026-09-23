import type { GitBranchInfo } from '../../shared/types'

const HEADS_PREFIX = 'refs/heads/'
const REMOTES_PREFIX = 'refs/remotes/'

/**
 * 解析 `git for-each-ref --sort=-committerdate --format=%(refname) refs/heads refs/remotes` 的原始输出。
 *
 * 纯函数（不依赖 Electron / git 调用），便于单测：见 branch-parse.spec.ts。
 *
 * - 本地分支：`refs/heads/<name>` → `{ name, ref: name, isRemote: false }`
 * - 远程分支：`refs/remotes/<remote>/<name>` → `{ ref: '<remote>/<name>', isRemote: true }`
 *   展示名默认去掉 remote 前缀（`2.0.2SP5`）；仓库存在多个远程时保留前缀（`origin/main`），
 *   避免同一仓库出现两条同名的 `main`（☁️ 由渲染层附加）
 * - 符号引用（`origin/HEAD`）、空行忽略；按 ref 保序去重
 *
 * 传入顺序即展示顺序（调用方用 `--sort=-committerdate` 保证“最近有提交的分支在前”）。
 */
export function parseBranches(raw: string): GitBranchInfo[] {
  const refs: Array<{ ref: string; isRemote: boolean }> = []

  for (const line of raw.split('\n')) {
    // trim 同时吃掉 \r（Windows 下 git 输出可能带 CRLF）与首尾空白
    const refname = line.trim()
    if (!refname) continue

    if (refname.startsWith(HEADS_PREFIX)) {
      const name = refname.slice(HEADS_PREFIX.length)
      if (name) refs.push({ ref: name, isRemote: false })
    } else if (refname.startsWith(REMOTES_PREFIX)) {
      const short = refname.slice(REMOTES_PREFIX.length)
      if (!short || short.endsWith('/HEAD')) continue // 符号引用无需展示
      refs.push({ ref: short, isRemote: true })
    }
  }

  const remoteNames = new Set(
    refs.filter(r => r.isRemote).map(r => r.ref.slice(0, r.ref.indexOf('/')))
  )
  const stripRemote = remoteNames.size <= 1

  return refs
    .map(({ ref, isRemote }) => ({
      name: isRemote && stripRemote ? ref.slice(ref.indexOf('/') + 1) : ref,
      ref,
      isRemote
    }))
    .filter((b, i, arr) => arr.findIndex(x => x.ref === b.ref) === i)
}
