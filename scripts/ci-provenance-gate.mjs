import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateSuccessfulCiRun } from './lib/ci-provenance.mjs'

const input = process.argv[2]
if (!input) throw new Error('Usage: node scripts/ci-provenance-gate.mjs <workflow-runs.json>')

const revision = process.env.RELEASE_REVISION?.trim()
const branch = process.env.RELEASE_BRANCH?.trim() || 'main'
const payload = JSON.parse(readFileSync(resolve(input), 'utf8'))
const result = validateSuccessfulCiRun(payload, { revision, branch })

console.log(JSON.stringify({ ok: true, ...result }))
