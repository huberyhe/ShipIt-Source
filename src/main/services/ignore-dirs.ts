/**
 * 文件树（FileService）与上传任务计算（DeployService）共用的忽略目录。
 * 两处必须使用同一份定义，避免出现“文件树可见但上传被跳过”（或反之）的隐性差异。
 */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.nuxt', '__pycache__',
  '.idea', '.vscode', 'vendor', 'target', 'build', '.cache'
])
