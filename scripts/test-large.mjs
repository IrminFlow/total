// Cross-platform one-million-line release fixture. Runs through Electron-as-Node so the native
// SQLite ABI matches production. The ordinary DB suite uses 100k lines for fast local feedback.
import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['scripts/test-db.mjs', '--run', 'src/main/services/performanceGates.dbtest.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, TOTAL_LARGE_BOOK_LINES: '1000000' },
  stdio: 'inherit'
})
process.exit(result.status ?? 1)
