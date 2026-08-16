// Regenerate agent-skill/voucher.schema.json from the live zod voucherInputSchema.
// Run after changing src/shared/schemas.ts voucher shapes: node scripts/gen-voucher-schema.mjs
// A unit test (src/main/cli/schemaDoc.test.ts) fails if the committed file drifts from the schema.
// Pure plain-Node: schemaDoc.ts imports only zod + src/shared, no Electron/better-sqlite3.
import { createRequire } from 'module'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const esbuild = require('esbuild')

const outfile = join(mkdtempSync(join(tmpdir(), 'total-schema-gen-')), 'schemaDoc.cjs')
esbuild.buildSync({
  entryPoints: [join(root, 'src', 'main', 'cli', 'schemaDoc.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  alias: { '@shared': join(root, 'src', 'shared') },
  logLevel: 'warning'
})

const { voucherJsonSchema } = require(outfile)
const dest = join(root, 'agent-skill', 'voucher.schema.json')
writeFileSync(dest, JSON.stringify(voucherJsonSchema(), null, 2) + '\n')
console.log(`wrote ${dest}`)
