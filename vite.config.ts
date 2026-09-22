import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(args) {
          args.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', 'simple-git', 'ssh2-sftp-client', 'basic-ftp']
            }
          }
        }
      },
      {
        entry: 'src/main/preload.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron'
          }
        }
      }
    ]),
    renderer()
  ],
  server: {
    watch: {
      // 保留 Vite 默认忽略项，并排除构建产物目录（避免 electron:build 时 dev 页面被反复重载）
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        '**/test-results/**',
        '**/playwright-report/**',
        '**/coverage/**',
        '**/release/**',
        '**/dist/**',
        '**/dist-electron/**'
      ]
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
