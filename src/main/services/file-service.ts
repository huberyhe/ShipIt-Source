import { promises as fs } from 'fs'
import { join, relative, sep, basename } from 'path'
import { IGNORE_DIRS, UPLOAD_SKIP_DIRS } from './ignore-dirs'

export interface FileEntry {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  size: number
  modifiedAt: number
  children?: FileEntry[]
  gitStatus?: 'modified' | 'added' | 'deleted' | 'untracked' | null
}

export interface FileTree {
  rootPath: string
  rootName: string
  children: FileEntry[]
  totalFiles: number
}

export class FileService {
  async buildTree(rootPath: string): Promise<FileTree> {
    const rootName = basename(rootPath)
    const children = await this.scanDir(rootPath, rootPath)
    return {
      rootPath,
      rootName,
      children,
      totalFiles: this.countFiles(children)
    }
  }

  /**
   * 递归收集目录下所有文件的绝对路径（不阻塞渲染进程）
   */
  async collectAllFiles(dirPath: string): Promise<string[]> {
    const results: string[] = []
    try {
      await this._collect(dirPath, results)
    } catch { /* ignore */ }
    return results
  }

  /**
   * 递归收集目录下所有文件（**上传遍历**用）。
   *
   * 与 `collectAllFiles`（文件树浏览）的区别：不跳过 dist/build/target/vendor 等构建产物目录，
   * 只跳过 .git 与 node_modules；顶层目录不可读时**向上抛错**（由调用方转成明确提示），
   * 不静默返回空集合 —— 空集合会被误报成「目录内没有文件」。
   */
  async collectFilesForUpload(dirPath: string, maxFiles: number = Number.POSITIVE_INFINITY): Promise<string[]> {
    const results: string[] = []
    await this._collectForUpload(dirPath, results, true, maxFiles)
    return results
  }

  private async _collectForUpload(
    dirPath: string,
    results: string[],
    top: boolean,
    maxFiles: number = Number.POSITIVE_INFINITY
  ): Promise<void> {
    // 提前收手：上限在**遍历中**生效，而不是把整个目录收完再报错
    // （百万文件目录会在报错前先吃掉大量内存/时间，P2-9）
    if (results.length > maxFiles) return
    let entries
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch (error) {
      if (top) throw error
      return // 子目录不可读：跳过该子树，但如实保留已收集的部分
    }
    for (const entry of entries) {
      if (results.length > maxFiles) return
      if (UPLOAD_SKIP_DIRS.has(entry.name)) continue
      // 不跟随符号链接/junction：指向项目外的链接会把外部文件带回上传集合（P1-5），
      // 指向自身的环状链接还会让递归无法收敛。
      if (entry.isSymbolicLink()) continue
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) await this._collectForUpload(fullPath, results, false, maxFiles)
      else results.push(fullPath)
    }
  }

  private async _collect(dirPath: string, results: string[]): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (this.shouldIgnore(entry.name)) continue
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          await this._collect(fullPath, results)
        } else {
          results.push(fullPath)
        }
      }
    } catch { /* ignore */ }
  }

  async expandDirectory(dirPath: string): Promise<FileEntry[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const children: FileEntry[] = []

      for (const entry of entries) {
        if (this.shouldIgnore(entry.name)) continue

        const fullPath = join(dirPath, entry.name)
        try {
          const stats = await fs.stat(fullPath)
          const fileEntry: FileEntry = {
            name: entry.name,
            path: fullPath,
            relativePath: '',
            isDirectory: entry.isDirectory(),
            size: stats.size,
            modifiedAt: stats.mtimeMs,
          }

          if (entry.isDirectory()) {
            fileEntry.children = [] // 标记为可展开
          }

          children.push(fileEntry)
        } catch {
          // 跳过无法访问的文件
        }
      }

      return this.sortEntries(children)
    } catch {
      return []
    }
  }

  private async scanDir(rootPath: string, dirPath: string): Promise<FileEntry[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const children: FileEntry[] = []

      for (const entry of entries) {
        if (this.shouldIgnore(entry.name)) continue

        const fullPath = join(dirPath, entry.name)
        try {
          const stats = await fs.stat(fullPath)
          const relPath = relative(rootPath, fullPath)

          const fileEntry: FileEntry = {
            name: entry.name,
            path: fullPath,
            relativePath: relPath,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            modifiedAt: stats.mtimeMs,
          }

          if (entry.isDirectory()) {
            fileEntry.children = this.shallowScan(rootPath, fullPath)
          }

          children.push(fileEntry)
        } catch {
          // 跳过无法访问的文件
        }
      }

      return this.sortEntries(children)
    } catch {
      return []
    }
  }

  private shallowScan(rootPath: string, dirPath: string): FileEntry[] {
    // 只扫描第一层，不递归展开
    return []
  }

  private shouldIgnore(name: string): boolean {
    if (name.startsWith('.') && name !== '.gitignore') return true
    if (IGNORE_DIRS.has(name)) return true
    return false
  }

  private sortEntries(entries: FileEntry[]): FileEntry[] {
    return entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  private countFiles(entries: FileEntry[]): number {
    let count = 0
    for (const entry of entries) {
      if (!entry.isDirectory) {
        count++
      } else if (entry.children) {
        count += this.countFiles(entry.children)
      }
    }
    return count
  }
}
