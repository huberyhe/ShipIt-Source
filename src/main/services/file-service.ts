import { promises as fs } from 'fs'
import { join, relative, sep, basename } from 'path'

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

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.nuxt', '__pycache__', '.idea', '.vscode', 'vendor', 'target', 'build', '.cache'])

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
