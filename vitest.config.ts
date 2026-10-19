import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/**
 * 测试专用配置。
 *
 * 刻意不加载 `vite.config.ts` 里的 electron / renderer 插件：
 * 插件会把 `fs` 等 Node 内置模块重写成 electron-renderer 兼容层，
 * 导致主进程与 CLI 侧的 Node 代码在 vitest 下无法加载。
 *
 * 超时与并发：命令级用例会起**真实 TLS 服务端**并多次驱动 CLI（真机级往返），
 * 单例耗时本就可达数百毫秒到数秒；并行执行时机器负载会进一步放大。
 * 默认 5 秒超时会把「慢」误报成「失败」，因此统一放宽并收敛并发度：
 * - testTimeout / hookTimeout：30 秒（仍能捕获真正的死循环或挂起）
 * - pool: 'forks' + maxForks：6（分波执行，避免每波都同时起一堆服务端互相抢资源）
 *
 * 注意：Vitest 2 的默认池是 `forks`，**只写另一个池的 poolOptions 不会生效** ——
 * 必须为实际使用的池声明上限，否则会按机器 CPU 数无上限拉起 worker（正是这里想避免的）。
 * 这里选 forks 而不是 threads：worker 线程里 `process.chdir()` 不可用，
 * 而配置路径相关用例需要切换工作目录来构造「无目录分隔符的相对路径」。
 */
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    include: ['src/**/*.{spec,test}.ts', 'scripts/**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**', 'dist-electron/**', 'release/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 6
      }
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
