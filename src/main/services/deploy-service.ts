/**
 * ssh2 / basic-ftp **惰性加载**。
 *
 * 这两个包只在「真正建立远端连接」时才需要（本地协议、plan、配置操作都不需要）。
 * 静态 import 会让主进程与后端进程在启动时就加载整条依赖图（ssh2 尤其重），
 * 实测每个进程多背 15–25MB 常驻内存。
 *
 * 这里用最小结构接口而不是包内的类型：
 * - 避免依赖 CJS 包的 default 导出形状；
 * - 字段与 `post-upload-script.ts` 期望的 `sftpClient` 形状保持一致。
 */
type SftpInstance = {
  connect (options: unknown): Promise<unknown>
  list (path: string): Promise<unknown>
  mkdir (path: string, recursive?: boolean): Promise<unknown>
  put (local: string, remote: string): Promise<unknown>
  end (): Promise<unknown>
  stat (remote: string): Promise<{ size?: number } | undefined>
  chmod? (remote: string, mode: number): Promise<unknown>
  client?: unknown
}
type SftpCtor = new (name?: string) => SftpInstance

type FtpInstance = {
  access (options: unknown): Promise<unknown>
  list (path: string): Promise<unknown>
  ensureDir (path: string): Promise<unknown>
  uploadFrom (source: unknown, target: string): Promise<unknown>
  close (): void
}
// basic-ftp 的构造参数是 socket 空闲超时（毫秒）；0/不传 = 永不超时
type FtpCtor = new (timeout?: number) => FtpInstance

let sftpCtorPromise: Promise<SftpCtor> | null = null
let ftpCtorPromise: Promise<FtpCtor> | null = null

async function loadSftpCtor (): Promise<SftpCtor> {
  sftpCtorPromise ??= import('ssh2-sftp-client').then((mod) => {
    const m = mod as unknown as { default?: SftpCtor } & SftpCtor
    return m.default ?? m
  })
  return sftpCtorPromise
}

async function loadFtpCtor (): Promise<FtpCtor> {
  ftpCtorPromise ??= import('basic-ftp').then((mod) => mod.Client as unknown as FtpCtor)
  return ftpCtorPromise
}
import { promises as fsPromises, createReadStream, createWriteStream, readFileSync, constants } from 'fs'
import { pipeline } from 'stream/promises'
import { join, relative, posix, dirname, isAbsolute, resolve } from 'path'
import type {
  DeployTarget,
  DirectoryMapping,
  UploadTask,
  DeployResult,
  DeployDetail,
  PlanSkip,
  UploadPreview
} from '../../shared/types'
import { toSlashes } from '../../shared/paths'
import { UPLOAD_SKIP_DIRS } from './ignore-dirs'
import { postUploadOf, runPostUploadScript } from './post-upload-script'

export type { DeployTarget, DirectoryMapping, UploadTask, DeployResult, DeployDetail, PlanSkip, UploadPreview }

/** 上传来源：桌面界面 / CLI·MCP 队列。用于「取消只影响自己的会话」 */
export type DeployOwner = 'desktop' | 'queue'

interface DeploySession {
  owner: DeployOwner
  /** 目标名：仅用于可观测性（退出提示、状态接口） */
  target: string
  /** 发起窗口（仅 owner=desktop）：取消只作用于本窗口的会话，不误伤其他窗口 */
  windowId?: number
  aborted: boolean
  /** 已拿到执行链（用于算排队位置） */
  started: boolean
  /** 任务标识：取消只针对“当前这个任务”，不牵连排队中的 */
  taskId: string
  /** 中止本地流式复制（F3） */
  controller: AbortController
  /** 中止远端 I/O 的钩子：断连后挂起的 put/uploadFrom 才会抛错，release() 才执行 */
  abortHooks: Array<() => void>
  /** 取消后的强制释放句柄（由 deploy() 注入；协义层不响应中断时的兼容） */
  forceRelease?: () => void
  /** 取消后启动的兑底定时器 */
  releaseTimer?: NodeJS.Timeout
}

/**
 * 标记会话中止，并**真正打断正在进行的 I/O**（F3）。
 *
 * 只置 aborted 不够：已经 await 的 put / uploadFrom / 流式复制不会自己结束，
 * finally 里的 release() 就不会执行 → 串行链被永久占住，后续任务虽然“排队中”但永远不开始。
 */
/**
 * 取消后若 I/O 迟迟不结束，多久强制释放串行链（ms）。
 *
 * 各协义的 destroy/close 在极端网络条件下可能仍然挂住（socket 半死、内核缓冲未回）。
 * 没有这个兑底，一次取消就能把后续所有上传永久堵在 `await previous` 上。
 * 代价：旧 I/O 可能仍在向远端写，与新会话并发 —— 所以只作为最后手段，并写日志。
 */
const ABORT_FORCE_RELEASE_MS = 15_000

function markAborted (session: DeploySession): void {
  session.aborted = true
  try {
    session.controller.abort()
  } catch {
    // AbortController 已中止
  }
  for (const hook of session.abortHooks) {
    try {
      hook()
    } catch {
      // 钩子只做尽力而为的释放
    }
  }

  // 兑底：连钩子也拉不回来时，到点强制释放，不让后续任务无限排队
  if (session.releaseTimer) clearTimeout(session.releaseTimer)
  session.releaseTimer = setTimeout(() => {
    process.stderr.write(
      `[shipit] 取消后 ${ABORT_FORCE_RELEASE_MS}ms 仍未结束，强制释放串行链：${session.owner}/${session.target}\n`
    )
    try {
      session.forceRelease?.()
    } catch {
      // 释放已发生
    }
  }, ABORT_FORCE_RELEASE_MS)
  // 不阻塞进程退出：这只是兑底定时器
  session.releaseTimer.unref?.()
}

/** deploy() 的附加选项 */
export interface DeployOptions {
  /** 桌面窗口 ID：让「取消」具备窗口粒度（多窗口下 B 窗口取消不应打断 A 窗口） */
  windowId?: number
  /** 外部取消信号：队列看门狗超时走这条路径，与手动取消共用同一套语义 */
  signal?: AbortSignal
  /**
   * 真正拿到执行链（uploadTail）后回调一次。
   * 队列用它重置看门狗（F9）：排队等桌面上传不应该消耗 CLI 的传输预算。
   */
  markStarted?: () => void
  /**
   * 进入排队时回调一次，告知前面还有几个会话。
   * 界面用它显示“排队中”，而不是先弹一个不动的进度卡（用户会误以为在传）。
   */
  onQueued?: (ahead: number) => void
}

export class DeployService {
  /**
   * 存活会话集合（执行中 + 排队中）。
   *
   * 此前是「单值 currentSession + waitingSessions 列表」两套机制，取消语义因此分叉：
   * abort() 命中执行中的会话就提前 return，不传 owner 时排队的会话漏取消（与注释承诺不符）；
   * 且单值一旦忘记清空，「取消」就会落到已经结束的会话上。统一成一个集合后只有一处语义。
   */
  private sessions = new Set<DeploySession>()
  /**
   * 串行链尾。桌面界面与 CLI/MCP 各自直接调用 deploy()，此前互不感知：
   * 两个入口会同时对同一目标开两个会话（违反 INV-6/AC-019），且单值 currentSession
   * 会让「取消」落到别人的任务上。这里用同一条链把两侧串起来。
   */
  private uploadTail: Promise<void> = Promise.resolve()

  /**
   * 存活会话快照（执行中 + 排队中）。
   *
   * 供退出收尾与可观测性使用：桌面界面**直接**调用 `deploy()`，不经过上传队列，
   * 因此队列快照看不到它 —— 只看队列会得出"空闲"，从而在退出时静默截断桌面正在跑的上传。
   */
  activeSessions(): Array<{ owner: DeployOwner; target: string; windowId?: number }> {
    return [...this.sessions].map((session) => ({
      owner: session.owner,
      target: session.target,
      ...(session.windowId === undefined ? {} : { windowId: session.windowId })
    }))
  }

  /**
   * 取消本窗口**当前正在执行**的任务，排队中的保留。
   *
   * 与 abort() 的区别：abort 会取消本窗口全部会话，用户点一次“取消”
   * 就把后面排队的任务一起干掉，与“取消当前这个上传”的直觉不符。
   * 若当前没有执行中的会话（都在排队），退化为取消队首，
   * 避免“刚提交就点取消，结果什么都没取消”。
   */
  abortCurrent(owner: DeployOwner, windowId?: number): void {
    const candidates = [...this.sessions].filter(
      (session) => session.owner === owner && (windowId === undefined || session.windowId === windowId)
    )
    if (candidates.length === 0) return
    const running = candidates.filter((session) => session.started)
    if (running.length > 0) {
      for (const session of running) markAborted(session)
      return
    }
    markAborted(candidates[0])
  }

  /**
   * 等待所有会话（含排队）结束。
   *
   * @returns true 表示在超时前已空闲；false 表示超时仍有会话存活
   */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    // 轮询足够：会话结束没有统一的可订阅信号，而退出是低频路径
    while (this.sessions.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return this.sessions.size === 0
  }

  /**
   * 请求中止上传（在下一个文件开始前生效）。
   * owner 给定时只取消该来源的会话：桌面点「取消」不应中止 CLI/MCP 的任务（反之亦然）；
   * windowId 给定时再收窄到该窗口：多窗口下 B 窗口的取消不应打断 A 窗口的上传。
   * 两者都不给则取消所有存活会话（内部与测试用）。
   */
  abort(owner?: DeployOwner, windowId?: number): void {
    // 执行中与排队中的会话一视同仁：命中即标记（不提前返回）
    for (const session of this.sessions) {
      if (owner && session.owner !== owner) continue
      if (windowId !== undefined && session.windowId !== windowId) continue
      markAborted(session)
    }
  }

  /** local 协议：把映射出的远程路径转成本地目标路径（host 为根目录） */
  private resolveLocalDest(task: UploadTask, target: DeployTarget): string {
    // remotePath 是 POSIX 口径；交给 join 按**当前平台**归一分隔符。
    // 不能手工把 `/` 换成 `\`：在 POSIX 上会把 `\out\a.txt` 当成一个文件名（CI 上就是这么挂的）。
    return target.host ? join(target.host, task.remotePath) : task.remotePath
  }

  async testConnection(target: DeployTarget): Promise<{ success: boolean; error?: string }> {
    try {
      if (target.protocol === 'local') {
        const root = target.host || '.'
        await fsPromises.access(root, constants.W_OK)
        return { success: true }
      }
      // 连接必须放在 finally 里关：失败路径（connect 成功但 list 抛错 —— 例如远端路径不存在，
      // 恰恰是"测试连接"最常见的失败）此前会漏掉 end()/close()，反复测试不可达目标会漏 socket。
      // `/test-connection` 是局域网可达路径，泄漏面被放大。
      if (target.protocol === 'sftp') {
        const Sftp = await loadSftpCtor()
        const sftp = new Sftp(`test-${Date.now()}`)
        try {
          await sftp.connect(this.buildSftpOptions(target))
          await sftp.list(target.mappings[0]?.remotePath || '/')
        } finally {
          // end() 自身可能 reject（连接已断）；这里只关心释放，不覆盖真正的失败原因
          await sftp.end().catch(() => undefined)
        }
      } else {
        const Ftp = await loadFtpCtor()
        // 30s 空闲超时：FTP 没有 keepalive，不设超时就会在断网时永久挂住
        const client = new Ftp(30_000)
        await client.access(this.buildFtpOptions(target))
        try {
          await client.list(target.mappings[0]?.remotePath || '/')
        } finally {
          client.close()
        }
      }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  resolveRemotePath(localPath: string, projectRoot: string, mappings: DirectoryMapping[]): string | null {
    const relPath = relative(projectRoot, localPath).replace(/\\/g, '/')

    // 按 localPrefix 长度降序（最长匹配优先）
    const sorted = [...mappings].sort((a, b) => b.localPrefix.length - a.localPrefix.length)

    for (const mapping of sorted) {
      let prefix = mapping.localPrefix.replace(/\\/g, '/')
      if (!prefix.endsWith('/')) {
        prefix += '/'
      }

      if (relPath.startsWith(prefix) || relPath === prefix.slice(0, -1)) {
        const subPath = relPath.slice(prefix.length)
        const remoteFullPath = posix.join(mapping.remotePath, subPath)
        return remoteFullPath
      }
    }

    return null
  }

  /**
   * 异步计算上传计划：会上传的任务 + 被跳过的条目（**含真实原因**）。
   *
   * 跳过判定与真正执行的筛选条件出自同一趟遍历，原因因此不需要下游再猜：
   * - `missing`：选中路径不存在/取不到 stat（已删除 / 未提交 / 路径不在项目内）
   * - `no-mapping`：文件存在但未命中任何目录映射
   *
   * 目录选择只对它**枚举出的文件**判定（目录本身不是上传单位）：无法 readdir 的目录目前
   * 不产出跳过项 —— 它既不是「不存在」也不是「无映射」，宁可不报也不编一个错原因。
   */
  async buildUploadPlan(
    selectedFiles: string[],
    projectRoot: string,
    target: DeployTarget
  ): Promise<UploadPreview> {
    const tasks: UploadTask[] = []
    const skipped: PlanSkip[] = []

    for (const rawPath of selectedFiles) {
      // 归一化：相对路径按项目根解析（CLI / 脚本调用方常传相对路径），
      // 解析后仍不在项目内的直接归为 outside-project——不能报 missing，也不能去 stat 项目外的路径。
      const filePath = isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath)
      const rel = toSlashes(relative(projectRoot, filePath))
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        skipped.push({ relativePath: rel || toSlashes(rawPath), reason: 'outside-project' })
        continue
      }
      let stats
      try {
        stats = await fsPromises.stat(filePath)
      } catch {
        // 已删除的 Git 变更文件就走这一支：必须报 missing，不能落到「无映射」兜底
        skipped.push({ relativePath: rel, reason: 'missing' })
        continue
      }

      if (stats.isDirectory()) {
        // 递归收集目录下所有文件
        await this.collectDirFiles(filePath, projectRoot, target.mappings, tasks, skipped)
      } else {
        const remotePath = this.resolveRemotePath(filePath, projectRoot, target.mappings)
        if (remotePath) {
          tasks.push({
            localPath: filePath,
            remotePath,
            relativePath: relative(projectRoot, filePath),
            size: stats.size
          })
        } else {
          skipped.push({ relativePath: toSlashes(relative(projectRoot, filePath)), reason: 'no-mapping' })
        }
      }
    }

    return { tasks, skipped }
  }

  /**
   * 只要任务列表（CLI / MCP 的 `plan`、`deploy` 走这条；跳过项由服务端 `toPlanSkips` 另算）。
   * 保留该入口是为了不改动服务端 handler 与其契约。
   */
  async buildUploadTasks(
    selectedFiles: string[],
    projectRoot: string,
    target: DeployTarget
  ): Promise<UploadTask[]> {
    return (await this.buildUploadPlan(selectedFiles, projectRoot, target)).tasks
  }

  async deploy(
    tasks: UploadTask[],
    target: DeployTarget,
    onProgress?: (current: number, total: number, file: string) => void,
    owner: DeployOwner = 'desktop',
    options: DeployOptions = {}
  ): Promise<DeployResult> {
    const session: DeploySession = {
      owner,
      target: target.name,
      aborted: false,
      started: false,
      taskId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      windowId: options.windowId,
      controller: new AbortController(),
      abortHooks: [],
      forceRelease: () => {
        try {
          release()
        } catch {
          // 已释放
        }
      }
    }
    // 外部取消（队列看门狗超时）与手动 abort 走同一个标记：排队中/传输中语义一致
    const onAbort = (): void => {
      markAborted(session)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) session.aborted = true
    // 排队等待前一个上传结束：桌面与 CLI/MCP 共用同一条串行链（INV-6 / AC-019）
    const previous = this.uploadTail
    let release!: () => void
    this.uploadTail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.sessions.add(session)
    // 排队位置：前面还有几个「已登记但未开始」的会话。
    // 用独立回调而不是 onProgress —— 后者语义是“文件开始/完成”，
    // 混入排队信号会让“严格串行”的用例误判（第二个任务“已经开始”）。
    const ahead = [...this.sessions].filter((item) => item !== session && !item.started).length
    if (ahead > 0) options.onQueued?.(ahead)
    try {
      await previous.catch(() => undefined)
    } catch {
      // 前一个会话的失败不影响本会话
    }

    // 拿到执行链了：这时才算“真正开始”（F9）
    session.started = true
    options.markStarted?.()

    if (session.aborted) {
      // 排队期间被取消：不建立连接、不上传任何文件，语义与执行中取消一致
      this.sessions.delete(session)
      release()
      return {
        taskId: session.taskId,
        targetName: target.name,
        timestamp: Date.now(),
        totalFiles: tasks.length,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        details: [],
        cancelled: true
      }
    }

    const startTime = Date.now()
    const result: DeployResult = {
      taskId: session.taskId,
      targetName: target.name,
      timestamp: startTime,
      totalFiles: tasks.length,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      details: []
    }

    let sftpClient: SftpInstance | null = null
    let ftpClient: FtpInstance | null = null
    const isLocal = target.protocol === 'local'

    // 取消熔断（关键）：底层 I/O 的 destroy/close 不保证能让挂着的 Promise 立即落定
    // （实测 SFTP 传大文件时取消，put 永不 reject，整个请求卡住 → 弹窗关不掉、无日志）。
    // 这里用 race 把“取消”变成一个必然落定的竞态，I/O 本身交给 hooks 去收尾。
    let abortReject: ((error: Error) => void) | null = null
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject
    })
    abortPromise.catch(() => undefined)
    session.abortHooks.push(() => abortReject?.(new Error('upload cancelled')))

    try {
      if (isLocal) {
        // 本地/挂载目录：无需连接
      } else if (target.protocol === 'sftp') {
        const Sftp = await loadSftpCtor()
        sftpClient = new Sftp('deploy')
        await sftpClient.connect(this.buildSftpOptions(target))
        // 取消时强制断连（F3）：让挂起的 put 抛错，才能走到 finally 释放串行链。
        // 先 destroy 底层 socket（end() 在断网场景自己也可能挂）：这是唯一能
        // 把“已发出但永远等不到回应”的写操作立刻拉回的手段。
        const activeSftp = sftpClient
        session.abortHooks.push(() => {
          try {
            const underlying = (activeSftp as { client?: { destroy?: () => void } }).client
            underlying?.destroy?.()
          } catch {
            // socket 已销毁
          }
          void activeSftp.end().catch(() => undefined)
        })
      } else {
        const Ftp = await loadFtpCtor()
        ftpClient = new Ftp(30_000)
        await ftpClient.access(this.buildFtpOptions(target))
        const activeFtp = ftpClient
        session.abortHooks.push(() => { try { activeFtp.close() } catch { /* 已关闭 */ } })
      }

      // 取消发生在第几个文件（-1 表示不是取消结束）
      let cancelledAt = -1
      for (let i = 0; i < tasks.length; i++) {
        // 取消检查：停止继续上传
        if (session.aborted) {
          result.cancelled = true
          cancelledAt = i
          break
        }

        const task = tasks[i]
        // 进度按“已完成文件数”报：开始第 i 个时报 i（不是 i+1）。
        // 否则单文件上传时一开拍就是 100%，大文件传输期间进度条停在满格。
        onProgress?.(i, tasks.length, task.relativePath)

        try {
          // 只上传单个文件的异步块：与取消熔断 race，保证取消后立即落定
          const uploadingOne = (async () => {
          if (isLocal) {
            const dest = this.resolveLocalDest(task, target)
            await fsPromises.mkdir(dirname(dest), { recursive: true })
            // 用流式复制而不是 copyFile（F3）：copyFile 不响应取消，目标在慢速网络盘上
            // 挂住时整个串行链会被卡死。mode 传源文件权限，保持与 copyFile 一致的语义。
            const srcStat = await fsPromises.stat(task.localPath)
            await pipeline(
              createReadStream(task.localPath),
              createWriteStream(dest, { mode: srcStat.mode & 0o777 }),
              { signal: session.controller.signal }
            )
          } else {
            // 确保远程目录存在
            const remoteDir = posix.dirname(task.remotePath)
            if (target.protocol === 'sftp' && sftpClient) {
              await sftpClient.mkdir(remoteDir, true).catch(() => {})
              await sftpClient.put(task.localPath, task.remotePath)
            } else if (ftpClient) {
              await ftpClient.ensureDir(remoteDir)
              await ftpClient.uploadFrom(task.localPath, task.remotePath)
            }
          }
          })()
          uploadingOne.catch(() => undefined)
          await Promise.race([uploadingOne, abortPromise])
          result.succeeded++
          // 传完一个再报一次：进度条按“已完成”前进，大文件期间不会假满
          onProgress?.(i + 1, tasks.length, task.relativePath)
          result.details.push({ relativePath: task.relativePath, remotePath: task.remotePath, status: 'success' })
        } catch (err: any) {
          // 被取消时正在传的那个文件不算“失败”：用户主动中止，不该在结果里计失败
          if (session.aborted) {
            result.cancelled = true
            cancelledAt = i
            break
          }
          result.failed++
          result.details.push({
            relativePath: task.relativePath,
            remotePath: task.remotePath,
            status: 'failed',
            error: err.message
          })
        }
      }

      // 取消时把**没轮到的文件**也列出来（status=cancelled）：用户要知道到底哪些没传。
      // 不计入 failed/skipped（那不是错误也不是跳过），只是“没开始”。
      if (result.cancelled && cancelledAt >= 0) {
        for (let j = cancelledAt; j < tasks.length; j++) {
          result.details.push({
            relativePath: tasks[j].relativePath,
            remotePath: tasks[j].remotePath,
            status: 'cancelled',
            error: '上传已取消'
          })
        }
      }

      // 上传后脚本：全部文件传完后执行一次（失败不影响已上传文件的成功状态）
      // 取消/超时后必须跳过：此时只有部分文件到位，脚本可能是重启服务/切版本，
      // 在半成品目录上执行属于不可回滚的副作用（F4）。
      if (!session.aborted && postUploadOf(target)) {
        result.postUpload = await runPostUploadScript({
          target,
          sftpClient: target.protocol === 'sftp' ? sftpClient : null,
          isLocal
        })
      }
    } finally {
      if (session.releaseTimer) clearTimeout(session.releaseTimer)
      if (sftpClient) sftpClient.end()
      if (ftpClient) ftpClient.close()
      options.signal?.removeEventListener('abort', onAbort)
      this.sessions.delete(session)
      release() // 释放串行链（无论成功/失败/取消都必须执行，否则后续上传永久排队）
    }

    result.duration = Date.now() - startTime
    return result
  }

  private async collectDirFiles(
    dirPath: string,
    projectRoot: string,
    mappings: DirectoryMapping[],
    tasks: UploadTask[],
    skipped?: PlanSkip[]
  ): Promise<void> {
    let entries
    try {
      entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
    } catch {
      // 目录不可访问：不产出跳过项（既非「不存在」也非「无映射」，不编原因）
      return
    }

    const subDirs: string[] = []
    const files: string[] = []
    for (const entry of entries) {
      // 上传展开目录时只跳过 .git / node_modules：dist 等构建产物正是要发布的内容
      if (UPLOAD_SKIP_DIRS.has(entry.name)) continue
      // 不跟随符号链接/junction：与 FileService 的遍历策略保持一致（P1-5，防止越界读取）
      if (entry.isSymbolicLink()) continue
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) subDirs.push(fullPath)
      else files.push(fullPath)
    }

    // 文件 stat 并行
    const stats = await Promise.all(files.map(f => fsPromises.stat(f).catch(() => null)))
    files.forEach((fullPath, i) => {
      const st = stats[i]
      if (!st) {
        // 列举到却取不到 stat：文件在遍历间隙消失（已删除）
        skipped?.push({ relativePath: toSlashes(relative(projectRoot, fullPath)), reason: 'missing' })
        return
      }
      const remotePath = this.resolveRemotePath(fullPath, projectRoot, mappings)
      if (remotePath) {
        tasks.push({
          localPath: fullPath,
          remotePath,
          relativePath: relative(projectRoot, fullPath),
          size: st.size
        })
      } else {
        skipped?.push({ relativePath: toSlashes(relative(projectRoot, fullPath)), reason: 'no-mapping' })
      }
    })

    // 子目录并行递归
    await Promise.all(subDirs.map(d => this.collectDirFiles(d, projectRoot, mappings, tasks, skipped)))
  }

  private buildSftpOptions(target: DeployTarget): any {
    const opts: any = {
      host: target.host,
      port: target.port || 22,
      username: target.username,
      // 连接级超时与保活：断网/远端失联时不能等 OS 的 TCP 超时（可能几十分钟）。
      // readyTimeout 管建连，keepalive 管已建立的连接：10s 一次、连续 2 次无响应即判死，
      // 挂起的 put 会因此抛错，任务能尽快结案而不是“永远传不完”。
      readyTimeout: 20_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 2
    }

    if (target.privateKeyPath) {
      opts.privateKey = readFileSync(target.privateKeyPath)
      if (target.passphrase) {
        opts.passphrase = target.passphrase
      }
    } else if (target.password) {
      opts.password = target.password
    }

    return opts
  }

  private buildFtpOptions(target: DeployTarget): any {
    const opts: any = {
      host: target.host,
      port: target.port || 21,
      user: target.username,
    }

    if (target.password) {
      opts.password = target.password
    }

    // basic-ftp: secure=true 为显式 TLS（FTPES）；secure='implicit' 为隐式 TLS（FTPS）
    if (target.protocol === 'ftps') {
      opts.secure = 'implicit'
    } else if (target.protocol === 'ftpes') {
      opts.secure = true
    }

    return opts
  }
}
