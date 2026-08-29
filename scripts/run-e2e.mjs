// E2E runner — `npm run e2e` (build first: `npm run build`).
//
// Runs every scripts/e2e/NN-*.mjs sequentially. Each scenario is fail-fast internally (first
// broken assertion aborts it), but the runner always runs ALL scenarios and reports the full
// picture at the end. Screenshots land in <out>/<scenario>/, results in <out>/results.json
// (out = $SMOKE_OUT or ./smoke-out/e2e).
//
// Filter by substring:  node scripts/run-e2e.mjs 03 06   → only 03-* and 06-*.
//
// A failing scenario is run once more before it is called a failure. If the retry passes, it is
// reported as FLAKE rather than PASS or FAIL: a test that passes half the time is not a passing
// test, and burying that in a green summary is how a real bug ships. One did — scenario 02 failed
// about half the time because `staleTime` is 5s and a query family was in no screen's
// invalidation list, and the suite reported 28/29 often enough to look like noise.
//
//   --no-retry     fail on the first failure, no second chance (use in a bisect)
//   --budget=600   fail the run if the whole suite takes longer than this many seconds
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const e2eDir = path.join(root, 'scripts', 'e2e')
const outRoot = process.env.SMOKE_OUT ?? path.join(root, 'smoke-out', 'e2e')
fs.mkdirSync(outRoot, { recursive: true })

const argv = process.argv.slice(2)
const noRetry = argv.includes('--no-retry')
const budgetArg = argv.find((a) => a.startsWith('--budget='))
// A suite nobody will wait for is a suite nobody runs. The default is generous — this is fifty-odd
// scenarios each booting a real Electron app — but it has to have a number, or it grows without
// anyone noticing until it is twenty minutes. On a quiet machine the suite runs in about 200-300
// seconds, so 600 is roughly double what it costs.
const budgetSeconds = budgetArg ? Number(budgetArg.split('=')[1]) : Number(process.env.E2E_BUDGET_SECONDS ?? 600)

/**
 * Everything timed here is wall clock, and wall clock is a statement about the MACHINE.
 *
 * `E2E_SCALE=3` multiplies both the suite budget and the per-scenario kill. It exists because
 * these numbers have already produced two false failures: a run that took 834 seconds against
 * the 600-second budget, and `12-theme-a11y` — normally 8 seconds — taking 141 seconds and being
 * killed, both while several agents were saturating an 8-core machine. Neither was a regression,
 * and a suite that cries wolf is a suite people start ignoring.
 *
 * A multiplier rather than a bigger default, so a developer's own run keeps the tight number that
 * would actually notice the suite doubling in cost.
 */
const scale = Math.max(1, Number(process.env.E2E_SCALE ?? 1))
const filters = argv.filter((a) => !a.startsWith('--'))
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
    const scenarioTimeoutMs = 5 * 60 * 1000 * scale
    const timer = setTimeout(() => {
      console.error(
        `[runner] ${name} timed out after ${Math.round(scenarioTimeoutMs / 60000)} minutes — killing.` +
          (scale === 1 ? ' If the machine is busy, E2E_SCALE=3 raises this.' : '')
      )
      child.kill('SIGKILL')
    }, scenarioTimeoutMs)
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

for (const file of files) {
  const first = await runOne(file)
  if (first.ok || noRetry) {
    results.push(first)
    continue
  }
  // Second chance. A scenario that passes on the retry is a flake, which is its own verdict:
  // the run does not go green, and the first failure's error is kept so it can be diagnosed.
  console.log(`[runner] ${first.scenario} failed — running once more to tell a flake from a break`)
  const second = await runOne(file)
  results.push(
    second.ok
      ? { ...second, flake: true, firstError: first.error ?? null, ms: first.ms + second.ms }
      : { ...second, ms: first.ms + second.ms }
  )
}

const flakes = results.filter((r) => r.flake)
const totalMs = Date.now() - t0
const effectiveBudget = budgetSeconds * scale
const overBudget = effectiveBudget > 0 && totalMs > effectiveBudget * 1000

const summary = {
  startedAt,
  totalMs,
  budgetSeconds,
  overBudget,
  passed: results.filter((r) => r.ok && !r.flake).length,
  flaky: flakes.length,
  failed: results.filter((r) => !r.ok).length,
  results
}
fs.writeFileSync(path.join(outRoot, 'results.json'), JSON.stringify(summary, null, 2))

console.log('\n================ e2e summary ================')
// Slowest first in the tail of the list, so the thing to fix is the thing you read last.
for (const r of results) {
  const verdict = !r.ok ? 'FAIL' : r.flake ? 'FLAKE' : 'PASS'
  console.log(
    `${verdict.padEnd(5)} ${r.scenario.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s` +
      `${r.error ? `  ${r.error.split('\n')[0]}` : ''}` +
      `${r.flake ? `  passed on retry — first failure: ${(r.firstError ?? '').split('\n')[0]}` : ''}`
  )
}

const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3)
console.log(
  `\n${summary.passed}/${results.length} passed` +
    `${flakes.length ? `, ${flakes.length} FLAKY` : ''}` +
    `${summary.failed ? `, ${summary.failed} failed` : ''}` +
    ` in ${(totalMs / 1000).toFixed(0)}s of a ${effectiveBudget}s budget${scale > 1 ? ` (E2E_SCALE=${scale})` : ''}`
)
console.log(`slowest: ${slowest.map((r) => `${r.scenario} ${(r.ms / 1000).toFixed(0)}s`).join(', ')}`)
console.log(`results + screenshots in ${outRoot}`)

if (overBudget) {
  console.error(
    `\n[runner] the suite took ${(totalMs / 1000).toFixed(0)}s against a ${effectiveBudget}s budget. ` +
      'Speed up the slowest scenarios or raise the budget deliberately — do not let it drift.'
  )
}
// A flake fails the run. It is a real defect in the app or in the test, and the only way it gets
// fixed is if it is not allowed to be green.
process.exit(summary.failed === 0 && flakes.length === 0 && !overBudget ? 0 : 1)
