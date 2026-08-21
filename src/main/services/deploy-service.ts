import SftpClient from 'ssh2-sftp-client'
import { Client } from 'basic-ftp'
import { promises as fsPromises, readFileSync, statSync, readdirSync, constants } from 'fs'
import { join, relative, posix, dirname } from 'path'
import type { DeployTarget, DirectoryMapping, UploadTask, DeployResult, DeployDetail } from '../../shared/types'

export type { DeployTarget, DirectoryMapping, UploadTask, DeployResult, DeployDetail }

export class DeployService {
  private aborted = false

  /** 请求中止当前部署（在下一个文件开始前生效） */
  abort(): void {
    this.aborted = true
  }

  /** local 协议：把映射出的远程路径转成本地目标路径（host 为根目录） */
  private resolveLocalDest(task: UploadTask, target: DeployTarget): string {
    const rel = task.remotePath.replace(/\//g, '\\')
    return target.host ? join(target.host, rel) : rel
  }

  async testConnection(target: DeployTarget): Promise<{ success: boolean; error?: string }> {
    try {
      if (target.protocol === 'local') {
        const root = target.host || '.'
        await fsPromises.access(root, constants.W_OK)
        return { success: true }
      }
      if (target.protocol === 'sftp') {
        const sftp = new SftpClient(`test-${Date.now()}`)
        await sftp.connect(this.buildSftpOptions(target))
        await sftp.list(target.mappings[0]?.remotePath || '/')
        sftp.end()
      } else {
        const client = new Client()
        client.ftp.verbose = true
        await client.access(this.buildFtpOptions(target))
        await client.list(target.mappings[0]?.remotePath || '/')
        client.close()
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

  buildUploadTasks(
    selectedFiles: string[],
    projectRoot: string,
    target: DeployTarget
  ): UploadTask[] {
    const tasks: UploadTask[] = []

    for (const filePath of selectedFiles) {
      const stats = statSync(filePath)

      if (stats.isDirectory()) {
        // 递归收集目录下所有文件
        this.collectDirFiles(filePath, projectRoot, target.mappings, tasks)
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
    onProgress?: (current: number, total: number, file: string) => void
  ): Promise<DeployResult> {
    this.aborted = false
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
        if (this.aborted) {
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
    } finally {
      if (sftpClient) sftpClient.end()
      if (ftpClient) ftpClient.close()
    }

    result.duration = Date.now() - startTime
    return result
  }

  private collectDirFiles(
    dirPath: string,
    projectRoot: string,
    mappings: DirectoryMapping[],
    tasks: UploadTask[]
  ): void {
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          this.collectDirFiles(fullPath, projectRoot, mappings, tasks)
        } else {
          const stats = statSync(fullPath)
          const remotePath = this.resolveRemotePath(fullPath, projectRoot, mappings)
          if (remotePath) {
            tasks.push({
              localPath: fullPath,
              remotePath,
              relativePath: relative(projectRoot, fullPath),
              size: stats.size
            })
          }
        }
      }
    } catch {
      // 跳过无法访问的目录
    }
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
