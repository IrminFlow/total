import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { buildCheckWorker } from './scripts/build-check-worker.mjs'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      // WP 7.1: whole-file SQLite checks (quick_check / integrity_check) and, since the PR #131
      // follow-up, the restore check of a backup run in a worker thread (out/main/checkWorker.js).
      // Bundled on its own (scripts/build-check-worker.mjs) so it shares no Electron-requiring
      // chunk with index.js; written after each main build (watch mode too).
      {
        name: 'total-check-worker',
        async writeBundle(options) {
          await buildCheckWorker(resolve(options.dir ?? resolve(__dirname, 'out/main'), 'checkWorker.js'))
        }
      }
    ],
    build: {
      rollupOptions: {
        // WP 5.4: the PDF text-layer reader runs in a worker thread (out/main/pdfWorker.js).
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          pdfWorker: resolve(__dirname, 'src/main/ai/capture/pdfWorker.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          // Screens are dynamic imports (src/renderer/src/lazyScreens.ts), so each is its own chunk and
          // code several screens share lands in shared chunks. The libraries every screen needs (React,
          // React Query, zustand, zod) are one vendor chunk, loaded with the entry and cached apart from it.
          manualChunks(id) {
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler|@tanstack|zustand|zod)[\\/]/.test(id)) return 'vendor'
            return undefined
          }
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    }
  }
})
