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
  external: ['electron', 'better-sqlite3'],
  alias: {
    '@shared': join(root, 'src', 'shared'),
    '@main': join(root, 'src', 'main')
  },
  loader: { '.md': 'text' },
  logLevel: 'warning'
})

console.log(`built ${outfile}`)
