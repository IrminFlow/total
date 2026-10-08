// WP 5.8 — `npm run ai:evals`: bundles src/main/ai/evals/cli.ts with esbuild (as total-cli.mjs does)
// and runs it under the Electron binary with ELECTRON_RUN_AS_NODE=1, so better-sqlite3's
// Electron-ABI build loads. The run is hermetic: the fixture lives in a scratch directory (--out,
// default a fresh temp dir), never in ~/Documents/total; TOTAL_DATA_DIR is pointed at it too.
// Options are passed through: npm run ai:evals -- --live --model <id> --case acc.* --sample 20
import { createRequire } from 'module'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const esbuild = require('esbuild')
const electronBinaryPath = require('electron')

const outfile = join(root, 'out', 'cli', 'ai-evals.cjs')
mkdirSync(dirname(outfile), { recursive: true })
const tmpOutfile = `${outfile}.${process.pid}.tmp`
esbuild.buildSync({
  entryPoints: [join(root, 'src', 'main', 'ai', 'evals', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: tmpOutfile,
  external: ['electron', 'better-sqlite3'],
  alias: { '@shared': join(root, 'src', 'shared'), '@main': join(root, 'src', 'main') },
  loader: { '.md': 'text' },
  logLevel: 'warning'
})
renameSync(tmpOutfile, outfile)

const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const out = outAt >= 0 && args[outAt + 1] ? resolve(args[outAt + 1]) : mkdtempSync(join(tmpdir(), 'total-ai-evals-'))
const passArgs = outAt >= 0 ? args : [...args, '--out', out]

const result = spawnSync(electronBinaryPath, [outfile, ...passArgs], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TOTAL_DATA_DIR: out, TOTAL_SUPPRESS_SYNC_WARNING: '1' }
})
process.exit(result.status ?? 1)
