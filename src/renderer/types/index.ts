export type ActiveView = 'filetree' | 'gitchanges' | 'gitlog'

export interface DeployApi {
  openProject: () => Promise<{ path: string } | null>
  getRecentProjects: () => Promise<string[]>
  getFileTree: (rootPath: string) => Promise<any>
  expandDirectory: (dirPath: string) => Promise<any[]>
  collectFiles: (dirPath: string) => Promise<string[]>
  checkGitRepo: (dir: string) => Promise<boolean>
  getGitBranches: (dir: string) => Promise<string[]>
  getGitAuthors: (dir: string) => Promise<string[]>
  getGitStatus: (dir: string) => Promise<any>
  getGitLog: (dir: string, options?: { branch?: string; author?: string; maxCount?: number }) => Promise<any[]>
  getGitDiff: (dir: string, filePath: string) => Promise<string>
  getCommitFiles: (dir: string, hash: string) => Promise<Array<{ path: string; status: string }>>
  testConnection: (target: any) => Promise<{ success: boolean; error?: string }>
  previewDeployFiles: (files: string[], projectRoot: string, target: any) => Promise<any[]>
  deployFiles: (tasks: any[], target: any) => Promise<any>
  cancelDeploy: () => Promise<void>
  onDeployProgress: (callback: (data: { current: number; total: number; file: string }) => void) => void
  openFileDialog: (options?: any) => Promise<string | null>
  onMenuEvent: (channel: string, callback: (...args: any[]) => void) => void
  syncMenuState: (state: { view?: string; theme?: string; hasProject?: boolean }) => void
  loadConfig: () => Promise<any>
  saveConfig: (config: any) => Promise<void>
  getTargetList: () => Promise<any[]>
  addTarget: (target: any) => Promise<void>
  updateTarget: (id: string, updates: any) => Promise<void>
  removeTarget: (id: string) => Promise<void>
  addMapping: (targetId: string, mapping: any) => Promise<void>
  updateMapping: (targetId: string, mappingId: string, updates: any) => Promise<void>
  removeMapping: (targetId: string, mappingId: string) => Promise<void>
}

declare global {
  interface Window {
    deployApi: DeployApi
  }
}
