// The check worker (src/main/db/checkWorker.ts → out/main/checkWorker.js) is bundled on its own
// with esbuild, not as a rollup input of the main build: since the restore check of a backup runs
// there (services/backupVerify.ts — migrations, audit chain, trial balance), a rollup input would
// share chunks with index.js, and those chunks require('electron') — which a worker thread cannot
// load (the packaged app has no `electron` package). Here the graph's two Electron imports
// (paths.ts, services/pdf.ts — reached through reports → vouchers, never called by a check) get an
// empty stand-in, so the file is self-contained: only Node built-ins and the SQLite driver.
// Used by electron.vite.config.ts (after the main build) and by the dbtests (the same bundle).
import { build } from 'esbuild'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** What the worker must never contain (checkWorkerBundle.test.ts). */
export const CHECK_WORKER_FORBIDDEN = [/^electron$/, /^openai(\/|$)/, /^@modelcontextprotocol\//]

/** Bundle the check worker to `outfile`. `sqlitePath` = where better-sqlite3-multiple-ciphers is
 *  required from (default: by name, resolved at run time like the app's own require). */
export async function buildCheckWorker(outfile, { sqlitePath, metafile = false, minify = false } = {}) {
  return build({
    entryPoints: [join(root, 'src', 'main', 'db', 'checkWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    minify,
    metafile,
    logLevel: 'warning',
    alias: { '@shared': join(root, 'src', 'shared'), '@main': join(root, 'src', 'main') },
    plugins: [
      {
        name: 'check-worker-externals',
        setup(b) {
          b.onResolve({ filter: /^better-sqlite3-multiple-ciphers$/ }, () => ({ path: sqlitePath ?? 'better-sqlite3-multiple-ciphers', external: true }))
          // Never loaded by a check: an empty object stands in (a use would fail loudly).
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'check-worker-no-electron' }))
          b.onLoad({ filter: /.*/, namespace: 'check-worker-no-electron' }, () => ({ contents: 'module.exports = {}', loader: 'js' }))
          for (const re of CHECK_WORKER_FORBIDDEN.slice(1)) {
            b.onResolve({ filter: re }, (args) => ({ errors: [{ text: `the check worker may not import ${args.path} (from ${args.importer})` }] }))
          }
        }
      }
    ]
  })
}

/** For tests: the driver resolved from this checkout (a worker bundled into a temp dir). */
export const sqliteDriverPath = () => createRequire(import.meta.url).resolve('better-sqlite3-multiple-ciphers')
