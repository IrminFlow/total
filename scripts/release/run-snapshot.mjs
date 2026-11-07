// Scheduled release — run upgrade/snapshot.ts against a SOURCE TREE (the last release's checkout or
// HEAD's). The bundle resolves `@main` / `@shared` and every package from that tree, is written
// inside it (so `require('better-sqlite3-multiple-ciphers')` loads that tree's driver) and runs
// under that tree's Electron binary as Node — the same pattern as scripts/total-cli.mjs.
//
//   node scripts/release/run-snapshot.mjs <tree> <seed|dump|check> <dataDir> [out.json]
import { createRequire } from 'module'
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const [treeArg, ...rest] = process.argv.slice(2)
if (!treeArg || rest.length < 2) {
  console.error('usage: run-snapshot.mjs <tree> <seed|dump|check> <dataDir> [out.json]')
  process.exit(2)
}
const tree = resolve(treeArg)
const treeRequire = createRequire(join(tree, 'package.json'))
const esbuild = treeRequire('esbuild')
const electron = treeRequire('electron')

const outfile = join(tree, 'out', 'release', 'snapshot.cjs')
mkdirSync(dirname(outfile), { recursive: true })
esbuild.buildSync({
  entryPoints: [join(here, 'upgrade', 'snapshot.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  external: ['electron', 'better-sqlite3-multiple-ciphers'],
  alias: { '@shared': join(tree, 'src', 'shared'), '@main': join(tree, 'src', 'main') },
  nodePaths: [join(tree, 'node_modules')],
  loader: { '.md': 'text' },
  logLevel: 'warning'
})

const [, dataDir, out] = rest
const args = [outfile, rest[0], resolve(dataDir), ...(out ? [resolve(out)] : [])]
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', TOTAL_SUPPRESS_SYNC_WARNING: '1', TOTAL_INSECURE_TEST_SECRETS: '1' }
const result = spawnSync(electron, args, { stdio: 'inherit', env, cwd: tree })
process.exit(result.status ?? 1)
