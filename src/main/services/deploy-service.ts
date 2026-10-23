import SftpClient from 'ssh2-sftp-client'
import { Client } from 'basic-ftp'
import { promises as fsPromises, readFileSync, constants } from 'fs'
import { join, relative, posix, dirname } from 'path'
import type { DeployTarget, DirectoryMapping, UploadTask, DeployResult, DeployDetail } from '../../shared/types'
import { UPLOAD_SKIP_DIRS } from './ignore-dirs'
import { postUploadOf, runPostUploadScript } from './post-upload-script'

export type { DeployTarget, DirectoryMapping, UploadTask, DeployResult, DeployDetail }

/** 上传来源：桌面界面 / CLI·MCP 队列。用于「取消只影响自己的会话」 */
export type DeployOwner = 'desktop' | 'queue'

interface DeploySession {
  owner: DeployOwner
  /** 目标名：仅用于可观测性（退出提示、状态接口） */
  target: string
  /** 发起窗口（仅 owner=desktop）：取消只作用于本窗口的会话，不误伤其他窗口 */
  windowId?: number
  aborted: boolean
}

/** deploy() 的附加选项 */
export interface DeployOptions {
  /** 桌面窗口 ID：让「取消」具备窗口粒度（多窗口下 B 窗口取消不应打断 A 窗口） */
  windowId?: number
  /** 外部取消信号：队列看门狗超时走这条路径，与手动取消共用同一套语义 */
  signal?: AbortSignal
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
      session.aborted = true
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
        const sftp = new SftpClient(`test-${Date.now()}`)
        try {
          await sftp.connect(this.buildSftpOptions(target))
          await sftp.list(target.mappings[0]?.remotePath || '/')
        } finally {
          // end() 自身可能 reject（连接已断）；这里只关心释放，不覆盖真正的失败原因
          await sftp.end().catch(() => undefined)
        }
      } else {
        const client = new Client()
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

  /** 异步计算上传任务：避免同步 I/O 阻塞主进程（文件多时 UI 会卡顿） */
  async buildUploadTasks(
    selectedFiles: string[],
    projectRoot: string,
    target: DeployTarget
  ): Promise<UploadTask[]> {
    const tasks: UploadTask[] = []

    for (const filePath of selectedFiles) {
      let stats
      try {
        stats = await fsPromises.stat(filePath)
      } catch {
        continue // 文件不存在/不可访问：跳过
      }

      if (stats.isDirectory()) {
        // 递归收集目录下所有文件
        await this.collectDirFiles(filePath, projectRoot, target.mappings, tasks)
      } else {
        const remotePath = this.resolveRemotePath(filePath, projectRoot, target.mappings)
        if (remotePath) {
          tasks.push({
            localPath: filePath,
            remotePath,
            relativePath: relative(projectRoot, filePath),
            size: stats.size
          })
        }
      }
    }

    return tasks
  }

  async deploy(
    tasks: UploadTask[],
    target: DeployTarget,
    onProgress?: (current: number, total: number, file: string) => void,
    owner: DeployOwner = 'desktop',
    options: DeployOptions = {}
  ): Promise<DeployResult> {
    const session: DeploySession = { owner, target: target.name, aborted: false, windowId: options.windowId }
    // 外部取消（队列看门狗超时）与手动 abort 走同一个标记：排队中/传输中语义一致
    const onAbort = (): void => {
      session.aborted = true
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
    try {
      await previous.catch(() => undefined)
    } catch {
      // 前一个会话的失败不影响本会话
    }

    if (session.aborted) {
      // 排队期间被取消：不建立连接、不上传任何文件，语义与执行中取消一致
      this.sessions.delete(session)
      release()
      return {
        taskId: Date.now().toString(36),
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
      taskId: Date.now().toString(36),
      targetName: target.name,
      timestamp: startTime,
      totalFiles: tasks.length,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      details: []
    }

    let sftpClient: SftpClient | null = null
    let ftpClient: Client | null = null
    const isLocal = target.protocol === 'local'

    try {
      if (isLocal) {
        // 本地/挂载目录：无需连接
      } else if (target.protocol === 'sftp') {
        sftpClient = new SftpClient('deploy')
        await sftpClient.connect(this.buildSftpOptions(target))
      } else {
        ftpClient = new Client()
        await ftpClient.access(this.buildFtpOptions(target))
      }

      for (let i = 0; i < tasks.length; i++) {
        // 取消检查：停止继续上传
        if (session.aborted) {
          result.cancelled = true
          break
        }

        const task = tasks[i]
        onProgress?.(i + 1, tasks.length, task.relativePath)

        try {
          if (isLocal) {
            const dest = this.resolveLocalDest(task, target)
            await fsPromises.mkdir(dirname(dest), { recursive: true })
            await fsPromises.copyFile(task.localPath, dest)
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
          result.succeeded++
          result.details.push({ relativePath: task.relativePath, remotePath: task.remotePath, status: 'success' })
        } catch (err: any) {
          result.failed++
          result.details.push({
            relativePath: task.relativePath,
            remotePath: task.remotePath,
            status: 'failed',
            error: err.message
          })
        }
      }

      // 上传后脚本：全部文件传完后执行一次（失败不影响已上传文件的成功状态）
      if (postUploadOf(target)) {
        result.postUpload = await runPostUploadScript({
          target,
          sftpClient: target.protocol === 'sftp' ? sftpClient : null,
          isLocal
        })
      }
    } finally {
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
    tasks: UploadTask[]
  ): Promise<void> {
    let entries
    try {
      entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
    } catch {
      return // 跳过无法访问的目录
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
      if (!st) return
      const remotePath = this.resolveRemotePath(fullPath, projectRoot, mappings)
      if (remotePath) {
        tasks.push({
          localPath: fullPath,
          remotePath,
          relativePath: relative(projectRoot, fullPath),
          size: st.size
        })
      }
    })

    // 子目录并行递归
    await Promise.all(subDirs.map(d => this.collectDirFiles(d, projectRoot, mappings, tasks)))
  }

  private buildSftpOptions(target: DeployTarget): any {
    const opts: any = {
      host: target.host,
      port: target.port || 22,
      username: target.username,
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
