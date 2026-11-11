/**
 * 配置文件的**共享写入设施**。
 *
 * 背景：同一个 `deploy-config.json` 有两个写者 —— `ConfigStore`（最近项目/目标/主题/视图状态）
 * 与 `server-config`（`server` 块）。此前两者各自 `read → 改 → writeFile`：
 *   ① 无互斥 → 交错执行会丢更新（后写者以自己读到的旧快照覆盖对方刚写的字段）；
 *   ② `writeFile` 直接截断原文件 → 崩溃/断电可能留下半截 JSON（目标含凭据，不可自愈）。
 *
 * 这里提供两件东西：**进程内串行锁**（把"读-改-写"整段串起来）与**原子写**（tmp + rename）。
 * 注意：锁只覆盖本进程；多实例由单实例锁保证（见 `window-manager` 的单实例约束）。
 */
import { promises as fs } from 'fs'
import { dirname } from 'path'

/** 串行链尾：所有配置写入按调用顺序排队，避免 read-modify-write 交错 */
let writeTail: Promise<void> = Promise.resolve()

/**
 * 在配置写入锁内执行 `fn`。
 *
 * `fn` 内部通常包含"读盘 → 合并 → 写盘"整段逻辑，必须整段串行，只锁写盘没有意义。
 */
export async function withConfigWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = writeTail
  let release!: () => void
  writeTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * 原子写 JSON：先写 `*.tmp` 再 `rename`。
 *
 * `rename` 在同一目录内是原子替换，因此读方要么看到完整旧文件、要么看到完整新文件，
 * 不会读到被截断的中间态（与 `tls-cert` 的证书落盘口径一致）。
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = dirname(filePath)
  if (dir && dir !== '.') await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
  const tmpPath = `${filePath}.tmp`
  // 先清掉可能的残留 tmp：writeFile 的 mode 只在**创建**时生效，
  // 复用旧文件会带着旧权限（Windows 上额外的 chmod 也会拉长与 rename 的竞争窗口）。
  await fs.rm(tmpPath, { force: true }).catch(() => undefined)
  // mode 必须显式 0600（F8）：默认 0644 会把原有的 0600 通过 rename 覆盖成全局可读，
  // 而这个文件里有目标密码与服务 token。Windows 上 mode 不生效，靠 ACL（另测）。
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  // Windows 上 rename 可能撞上杀毒/索引器的瞬时占用（EPERM/EBUSY）：短重试，
  // 不能直接把一次瞬时占用报成“配置保存失败”。
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmpPath, filePath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 2 || (code !== 'EPERM' && code !== 'EBUSY')) throw error
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
}

/** 读取 JSON 对象；文件不存在或解析失败返回空对象（调用方按"缺字段"处理） */
export async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
