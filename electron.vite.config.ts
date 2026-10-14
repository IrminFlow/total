import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // WP 5.4: the PDF text-layer reader runs in a worker thread (out/main/pdfWorker.js).
        // WP 7.1: whole-file SQLite checks (quick_check / integrity_check) too (out/main/checkWorker.js).
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          pdfWorker: resolve(__dirname, 'src/main/ai/capture/pdfWorker.ts'),
          checkWorker: resolve(__dirname, 'src/main/db/checkWorker.ts')
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
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    }
  }
})
