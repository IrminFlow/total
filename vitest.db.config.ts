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
    // WP 7.4: the same runners took > 10 s (vitest's hook default) in the beforeAll of suites that
    // import the whole IPC layer and create / open a company (stockCostIpc, printTemplatesIpc) or
    // build the Demo Traders company (dashboard, tradeLegacy) or seed an inbox company
    // (agentBridge) — about 0.3–1.7 s each on a Mac; the cost is migrations + fresh .db files under
    // Defender, not test logic, so hooks get the test budget.
    hookTimeout: 30000,
    include: ['src/main/**/*.dbtest.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  }
})
