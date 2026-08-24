// Runs the DB-layer vitest suite (src/main/**/*.dbtest.ts) with Node re-pointed at the Electron
// binary via ELECTRON_RUN_AS_NODE=1. This matches the ABI better-sqlite3 is built against
// (Electron's, not plain Node's) so the native module loads without a rebuild. See CLAUDE.md.
import { createRequire } from 'module'
import { spawnSync } from 'child_process'

const require = createRequire(import.meta.url)
const electronBinaryPath = require('electron')
// Resolved rather than spelled as './node_modules/...': a git worktree has no node_modules of
// its own and inherits the main checkout's by Node's upward lookup, so a literal relative path
// works in the repo and fails in every worktree.
const vitestBin = require.resolve('vitest/vitest.mjs')

const result = spawnSync(
  electronBinaryPath,
  [vitestBin, 'run', '-c', 'vitest.db.config.ts', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
)

process.exit(result.status ?? 1)
