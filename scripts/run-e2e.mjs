// E2E runner — `npm run e2e` (build first: `npm run build`).
//
// Runs every scripts/e2e/NN-*.mjs sequentially. Each scenario is fail-fast internally (first
// broken assertion aborts it), but the runner always runs ALL scenarios and reports the full
// picture at the end. Screenshots land in <out>/<scenario>/, results in <out>/results.json
// (out = $SMOKE_OUT or ./smoke-out/e2e).
//
// Filter by substring:  node scripts/run-e2e.mjs 03 06   → only 03-* and 06-*.
//
// WP 7.4:
//   --repeat N    run the selection N times in a row (the flake budget is zero over three runs:
//                 `--repeat 3`). Run k writes its screenshots + results.json under <out>/run-k/;
//                 <out>/summary.json lists every run and the FLAKY scenarios (passed in one run,
//                 failed in another). Exit 1 when any run had a failure.
//   --shard i/n   run only shard i of n (1-based) — scenarios are dealt out longest-first by the
//                 durations in scripts/e2e/timings.json (unknown = 60 s) so CI's parallel
//                 matrix jobs take about the same time. Filters apply before sharding.
//   --json FILE   also write the summary to FILE.
//   --write-timings  after the run, write each scenario's (last) duration to scripts/e2e/timings.json.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const e2eDir = path.join(root, 'scripts', 'e2e')
const timingsFile = path.join(e2eDir, 'timings.json')
const outRoot = process.env.SMOKE_OUT ?? path.join(root, 'smoke-out', 'e2e')
fs.mkdirSync(outRoot, { recursive: true })

// ---------------- arguments ----------------
const argv = process.argv.slice(2)
let repeat = 1
let shard = null
let jsonOut = null
let writeTimings = false
const filters = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const value = () => {
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]
    if (v === undefined) {
      console.error(`${a} needs a value`)
      process.exit(2)
    }
    return v
  }
  if (a === '--repeat' || a.startsWith('--repeat=')) repeat = Number(value())
  else if (a === '--shard' || a.startsWith('--shard=')) {
    const m = /^(\d+)\/(\d+)$/.exec(value())
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
      console.error('--shard takes i/n with 1 ≤ i ≤ n, e.g. --shard 2/3')
      process.exit(2)
    }
    shard = { index: Number(m[1]), count: Number(m[2]) }
  } else if (a === '--json' || a.startsWith('--json=')) jsonOut = path.resolve(value())
  else if (a === '--write-timings') writeTimings = true
  else if (a.startsWith('--')) {
    console.error(`unknown option ${a}`)
    process.exit(2)
  } else filters.push(a)
}
if (!Number.isInteger(repeat) || repeat < 1) {
  console.error('--repeat takes a whole number ≥ 1')
  process.exit(2)
}

// ---------------- selection ----------------
let files = fs
  .readdirSync(e2eDir)
  .filter((f) => /^\d\d-.*\.mjs$/.test(f))
  .sort()
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))

const timings = fs.existsSync(timingsFile) ? JSON.parse(fs.readFileSync(timingsFile, 'utf8')) : {}
const durationOf = (file) => timings[file.replace(/\.mjs$/, '')] ?? 60000

if (shard) {
  // Longest-processing-time first: each scenario goes to the shard with the least work so far.
  const loads = Array.from({ length: shard.count }, () => ({ ms: 0, files: [] }))
  for (const f of [...files].sort((a, b) => durationOf(b) - durationOf(a) || a.localeCompare(b))) {
    const least = loads.reduce((best, s) => (s.ms < best.ms ? s : best))
    least.ms += durationOf(f)
    least.files.push(f)
  }
  files = loads[shard.index - 1].files.sort()
  console.log(`shard ${shard.index}/${shard.count}: ${files.length} scenarios, ~${Math.round(loads[shard.index - 1].ms / 60000)} min by timings.json`)
}

if (files.length === 0) {
  console.error(`no scenarios match ${JSON.stringify(filters)} in ${e2eDir}`)
  process.exit(2)
}
if (!process.env.TOTAL_APP_EXECUTABLE && !fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('out/ is missing — run `npm run build` first')
  process.exit(2)
}

/** Run one scenario file; resolve with its result-line JSON (or a synthesized failure). */
function runOne(file, runOut) {
  return new Promise((resolve) => {
    const name = file.replace(/\.mjs$/, '')
    console.log(`\n=== ${name} ===`)
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(e2eDir, file)], {
      cwd: root,
      env: { ...process.env, SMOKE_OUT: runOut },
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
      const lines = tail.trim().split(/\r?\n/).reverse()
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

function printTable(title, summary) {
  console.log(`\n================ ${title} ================`)
  for (const r of summary.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s${r.error ? `  ${r.error.split('\n')[0]}` : ''}`)
  }
  console.log(`${summary.passed}/${summary.results.length} passed in ${(summary.totalMs / 60000).toFixed(1)} min`)
}

const runs = []
for (let k = 1; k <= repeat; k++) {
  // A single run keeps the old layout (<out>/<scenario>/, <out>/results.json).
  const runOut = repeat === 1 ? outRoot : path.join(outRoot, `run-${k}`)
  fs.mkdirSync(runOut, { recursive: true })
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const results = []
  for (const file of files) results.push(await runOne(file, runOut))
  const summary = {
    run: k,
    startedAt,
    totalMs: Date.now() - t0,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  }
  fs.writeFileSync(path.join(runOut, 'results.json'), JSON.stringify(summary, null, 2))
  printTable(repeat === 1 ? 'e2e summary' : `e2e run ${k}/${repeat}`, summary)
  runs.push(summary)
}

// ---------------- overall summary ----------------
const byScenario = new Map()
for (const run of runs) {
  for (const r of run.results) {
    const s = byScenario.get(r.scenario) ?? { scenario: r.scenario, passes: 0, failures: 0, ms: [], errors: [] }
    if (r.ok) s.passes++
    else {
      s.failures++
      s.errors.push({ run: run.run, error: r.error?.split('\n')[0] ?? '' })
    }
    s.ms.push(r.ms)
    byScenario.set(r.scenario, s)
  }
}
const scenarios = [...byScenario.values()]
const overall = {
  repeat,
  shard: shard ? `${shard.index}/${shard.count}` : null,
  totalMs: runs.reduce((n, r) => n + r.totalMs, 0),
  runs: runs.map(({ run, startedAt, totalMs, passed, failed }) => ({ run, startedAt, totalMs, passed, failed })),
  flaky: scenarios.filter((s) => s.passes > 0 && s.failures > 0),
  broken: scenarios.filter((s) => s.passes === 0),
  scenarios
}
fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(overall, null, 2))
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(overall, null, 2))

if (writeTimings) {
  const next = { ...timings }
  for (const s of scenarios) next[s.scenario] = Math.max(...s.ms)
  fs.writeFileSync(timingsFile, JSON.stringify(Object.fromEntries(Object.entries(next).sort()), null, 2) + '\n')
  console.log(`timings written to ${path.relative(root, timingsFile)}`)
}

if (repeat > 1) {
  console.log(`\n${repeat} runs: ${runs.map((r) => `${r.passed}/${r.results.length}`).join(', ')} — total ${(overall.totalMs / 60000).toFixed(1)} min`)
  if (overall.flaky.length) console.log(`FLAKY: ${overall.flaky.map((s) => `${s.scenario} (${s.failures}/${repeat})`).join(', ')}`)
  if (overall.broken.length) console.log(`BROKEN: ${overall.broken.map((s) => s.scenario).join(', ')}`)
}
console.log(`results + screenshots in ${outRoot}`)
process.exit(runs.every((r) => r.failed === 0) ? 0 : 1)
