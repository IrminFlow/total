// Runs the DB-layer vitest suite (src/main/**/*.dbtest.ts) with Node re-pointed at the Electron
// binary via ELECTRON_RUN_AS_NODE=1. This matches the ABI better-sqlite3 is built against
// (Electron's, not plain Node's) so the native module loads without a rebuild. See CLAUDE.md.
import { createRequire } from 'module'
import { spawnSync } from 'child_process'

const require = createRequire(import.meta.url)
const electronBinaryPath = require('electron')

const result = spawnSync(
  electronBinaryPath,
  ['node_modules/vitest/vitest.mjs', 'run', '-c', 'vitest.db.config.ts', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    // WP 7.3: test DBs skip the checkpoint fsyncs (db/testPragmas.ts — vitest workers with a scratch data
    // dirs only). Measured on the Windows runner: the suite 420 s → 373 s, the demo seed 0.5 s →
    // 0.3 s, and the seeding hooks that had stalled past 10 s (tradeLegacy 11.2 s) ran in 0.5 s.
    env: { TOTAL_TEST_DB_SYNCHRONOUS: 'off', ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
)

process.exit(result.status ?? 1)
