/**
 * 文件树（浏览用）忽略的目录：浏览时隐藏依赖与构建产物，减少噪声。
 */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.nuxt', '__pycache__',
  '.idea', '.vscode', 'vendor', 'target', 'build', '.cache'
])

/**
 * **上传遍历**忽略的目录：只跳过对发布毫无意义的版本库与依赖目录。
 *
 * 不能用 IGNORE_DIRS：它含 dist/build/target/vendor 等构建产物目录，
 * 而那正是最常见的发布内容 —— `--dir .` 曾因此静默漏掉 `dist/`。
 */
export const UPLOAD_SKIP_DIRS = new Set(['.git', 'node_modules'])
