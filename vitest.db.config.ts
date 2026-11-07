import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/** DB-layer tests: run under Electron-as-Node (see scripts/test-db.mjs) — the Node the app ships
 *  with. Not part of the plain-Node `npm test` run. */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    // hi / hinglish are registered catalogues (the renderer loads them on demand); tests see all three.
    setupFiles: ['src/shared/i18n/all.ts', 'src/shared/zodMessages.ts'],
    // Windows CI runners (Defender scanning fresh .db files) push I/O-heavy backup/restore
    // tests past vitest's 5s default; these suites are correctness-, not latency-, sensitive.
    testTimeout: 30000,
    include: ['src/main/**/*.dbtest.ts'],
    // One file at a time, each in its own child process (Electron-as-Node, inherited from
    // scripts/test-db.mjs). Vitest 4 removed `poolOptions.forks.singleFork` (one process,
    // modules re-evaluated per file); its suggested stand-in, `isolate: false`, would share the
    // module graph AND each file's vi.mock('electron', …) across files, so we keep isolation and
    // pay one process start per file instead. Measured on CI (PR #205): Windows test:db 8.5 →
    // 13.6 min, Linux unchanged. Don't trade that back for `isolate: false` without first making
    // every dbtest's electron mock identical.
    pool: 'forks',
    maxWorkers: 1,
    isolate: true
  }
})
