/**
 * 构建后端进程产物（dist-server/index.js）。
 *
 * external 与主进程口径一致：这三个库带原生/动态加载，不能内联。
 */
const { build } = require('esbuild')
const { join } = require('path')

const ROOT = join(__dirname, '..')

build({
  entryPoints: [join(ROOT, 'src/server/index.ts')],
  outfile: join(ROOT, 'dist-server/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', 'simple-git', 'ssh2-sftp-client', 'basic-ftp'],
  logLevel: 'info'
}).catch(() => process.exit(1))
