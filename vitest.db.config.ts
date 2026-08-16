import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/** DB-layer tests: run under Electron-as-Node (see scripts/test-db.mjs) so better-sqlite3's
 *  Electron-ABI build loads correctly. Not part of the plain-Node `npm test` run. */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    // Windows CI runners (Defender scanning fresh .db files) push I/O-heavy backup/restore
    // tests past vitest's 5s default; these suites are correctness-, not latency-, sensitive.
    testTimeout: 30000,
    include: ['src/main/**/*.dbtest.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  }
})
