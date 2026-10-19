/**
 * git revision 白名单（**唯一来源**：CLI 参数校验与服务端执行边界共用）。
 *
 * 为什么要它：`branch` / `hash` 会被拼进 git argv（`git log <branch>`、`git show <hash>`）。
 * git 接受大量"看起来像选项"的参数，例如 `--output=/path` 会让 git 以用户权限写入/截断任意文件；
 * 而 `branch` 可直接来自 MCP 工具入参（由 LLM 填写）与 CLI `--branch`，
 * 因此"只读查询"必须在这里把值约束成正常 ref / commit-ish 的形状。
 *
 * 规则：首字符为字母数字或下划线（**杜绝以 `-` 开头的选项注入**），
 * 其余允许字母数字与 `. _ / @ ^ ~ - { }`，总长 ≤ 200。
 */
const SAFE_REV = /^[A-Za-z0-9_][A-Za-z0-9._/@^~{}-]{0,199}$/

/** 值是否是安全的 git revision（分支名 / commit-ish） */
export function isSafeGitRev(value: string): boolean {
  return SAFE_REV.test(value)
}
