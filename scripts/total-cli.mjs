// Headless Total CLI launcher. Bundles src/main/cli/main.ts with esbuild (already a transitive
// devDependency via vite — no new packages), then runs the bundle under the Electron binary with
// ELECTRON_RUN_AS_NODE=1 so better-sqlite3's Electron-ABI build loads without a rebuild — the same
// pattern as scripts/test-db.mjs. Safe alongside a running app: the DB layer opens every company
// in WAL mode with a busy_timeout and takes no exclusive locks.
//
// Usage: npm run cli -- <command> [options]     (try: npm run cli -- help)
// Data root: TOTAL_DATA_DIR if set, else ~/Documents/total (matches the app).
import { createRequire } from 'module'
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const esbuild = require('esbuild')
const electronBinaryPath = require('electron') // plain-Node require -> the binary's path string

const outfile = join(root, 'out', 'cli', 'total-cli.cjs')
mkdirSync(dirname(outfile), { recursive: true })

// Rebundle on every invocation — esbuild does this in tens of milliseconds, and it guarantees the
// CLI always matches the checked-out sources (no stale-bundle debugging).
esbuild.buildSync({
  entryPoints: [join(root, 'src', 'main', 'cli', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  external: ['electron', 'better-sqlite3'],
  alias: {
    '@shared': join(root, 'src', 'shared'),
    '@main': join(root, 'src', 'main')
  },
  loader: { '.md': 'text' },
  logLevel: 'warning'
})

const result = spawnSync(electronBinaryPath, [outfile, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TOTAL_DATA_DIR: process.env.TOTAL_DATA_DIR ?? join(homedir(), 'Documents', 'total')
  }
})

process.exit(result.status ?? 1)
