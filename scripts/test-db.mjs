// Runs the DB-layer vitest suite (src/main/**/*.dbtest.ts) with Node re-pointed at the Electron
// binary via ELECTRON_RUN_AS_NODE=1. This matches the ABI better-sqlite3 is built against
// (Electron's, not plain Node's) so the native module loads without a rebuild. See CLAUDE.md.
import { createRequire } from 'module'
import { spawnSync } from 'child_process'
import { dirname, join } from 'path'

const require = createRequire(import.meta.url)
const electronBinaryPath = require('electron')
// Resolved rather than assumed to be './node_modules/vitest/vitest.mjs': in a git worktree the
// packages live in the checkout above, and Node's own upward resolution is the only thing that
// knows where. A hardcoded relative path made the suite unrunnable from a worktree.
const vitestEntry = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const result = spawnSync(
  electronBinaryPath,
  [vitestEntry, 'run', '-c', 'vitest.db.config.ts', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
)

process.exit(result.status ?? 1)
