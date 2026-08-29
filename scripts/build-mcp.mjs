// Bundles the MCP server into out/mcp/total-mcp.cjs — the same esbuild-then-run-under-Electron
// pattern as scripts/total-cli.mjs. @modelcontextprotocol/sdk is inlined, which is why it can
// stay a devDependency: the shipped artefact is one file with no node_modules to resolve.
//
// Wired into `npm run build`, so out/mcp is covered by electron-builder's existing `out/**/*`
// glob, and asarUnpack keeps it a real path on disk for Claude Desktop to spawn.
import { createRequire } from 'module'
import { mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const esbuild = require('esbuild')

const outfile = join(root, 'out', 'mcp', 'total-mcp.cjs')
mkdirSync(dirname(outfile), { recursive: true })

esbuild.buildSync({
  entryPoints: [join(root, 'src', 'main', 'mcp', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  // better-sqlite3 stays external: it is a native module loaded from the app's node_modules.
  // `electron` is NOT external -- under ELECTRON_RUN_AS_NODE inside a packaged bundle there is
  // no node_modules/electron to resolve, so requiring it fails at load. The stub supplies the
  // one thing the server needs from it.
  external: ['better-sqlite3'],
  alias: {
    '@shared': join(root, 'src', 'shared'),
    '@main': join(root, 'src', 'main'),
    electron: join(root, 'src', 'main', 'mcp', 'electron-stub.ts')
  },
  loader: { '.md': 'text' },
  logLevel: 'warning'
})

console.log(`built ${outfile}`)
