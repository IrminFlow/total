// E2E runner — `npm run e2e` (build first: `npm run build`).
//
// Runs every scripts/e2e/NN-*.mjs sequentially. Each scenario is fail-fast internally (first
// broken assertion aborts it), but the runner always runs ALL scenarios and reports the full
// picture at the end. Screenshots land in <out>/<scenario>/, results in <out>/results.json
// (out = $SMOKE_OUT or ./smoke-out/e2e).
//
// Filter by substring:  node scripts/run-e2e.mjs 03 06   → only 03-* and 06-*.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const e2eDir = path.join(root, 'scripts', 'e2e')
const outRoot = process.env.SMOKE_OUT ?? path.join(root, 'smoke-out', 'e2e')
fs.mkdirSync(outRoot, { recursive: true })

const filters = process.argv.slice(2)
const files = fs
  .readdirSync(e2eDir)
  .filter((f) => /^\d\d-.*\.mjs$/.test(f))
  .sort()
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))

if (files.length === 0) {
  console.error(`no scenarios match ${JSON.stringify(filters)} in ${e2eDir}`)
  process.exit(2)
}
if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('out/ is missing — run `npm run build` first')
  process.exit(2)
}

/** Run one scenario file; resolve with its result-line JSON (or a synthesized failure). */
function runOne(file) {
  return new Promise((resolve) => {
    const name = file.replace(/\.mjs$/, '')
    console.log(`\n=== ${name} ===`)
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(e2eDir, file)], {
      cwd: root,
      env: { ...process.env, SMOKE_OUT: outRoot },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let tail = ''
    child.stdout.on('data', (buf) => {
      process.stdout.write(buf)
      tail = (tail + buf.toString()).slice(-20000)
    })
    // A hung scenario must not wedge the whole run.
    const timer = setTimeout(() => {
      console.error(`[runner] ${name} timed out after 5 minutes — killing`)
      child.kill('SIGKILL')
    }, 5 * 60 * 1000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const lines = tail.trim().split('\n').reverse()
      const jsonLine = lines.find((l) => {
        try {
          const o = JSON.parse(l)
          return o && typeof o === 'object' && 'scenario' in o && 'ok' in o
        } catch {
          return false
        }
      })
      if (jsonLine) resolve(JSON.parse(jsonLine))
      else resolve({ scenario: name, ok: false, ms: Date.now() - started, error: `no result line (exit code ${code})` })
    })
  })
}

const startedAt = new Date().toISOString()
const t0 = Date.now()
const results = []
for (const file of files) results.push(await runOne(file))

const summary = { startedAt, totalMs: Date.now() - t0, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }
fs.writeFileSync(path.join(outRoot, 'results.json'), JSON.stringify(summary, null, 2))

console.log('\n================ e2e summary ================')
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s${r.error ? `  ${r.error.split('\n')[0]}` : ''}`)
}
console.log(`${summary.passed}/${results.length} passed — results + screenshots in ${outRoot}`)
process.exit(summary.failed === 0 ? 0 : 1)
