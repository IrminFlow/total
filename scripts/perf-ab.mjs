// Compare two renderer builds on startup, without the machine deciding the answer.
//
//   npm run build                            # the candidate
//   cp -R out/renderer /tmp/renderer-after
//   git stash && npm run build               # the baseline
//   cp -R out/renderer /tmp/renderer-before
//   git stash pop
//   node scripts/perf-ab.mjs /tmp/renderer-before /tmp/renderer-after
//
// Why this exists rather than "measure, change it, measure again":
//
// This repo has already published one number that was wrong. Trial balance was reported at
// 3,240 ms warm and called the scaling wall; the same build on a quiet machine reported 159 ms.
// Nothing about the app had changed. A sequential A-then-B measurement on a shared machine
// measures whatever else was running during B, and the load on this machine drifts by a factor of
// three over ten minutes — enough to invent a regression or hide one.
//
// So the two builds are alternated launch by launch, and the order flips every round, so neither
// arm can collect a systematically busier half of the run. The statistic is the MINIMUM of each
// arm: on a contended machine the mean measures the contention, and the minimum is the closest
// estimate of what the code actually costs.
//
// Only the renderer is swapped, because that is the only part of the app that can be swapped
// without rebuilding: main and preload stay exactly as they are in out/, and so are controlled by
// construction. For a main-process change, measure it in-process instead (see the paired
// cached/uncached benchmark in the header of src/main/db/stmt.ts).
//
// NOTE: this OVERWRITES out/renderer as it goes. Re-run `npm run build` afterwards.
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const [before, after, roundsArg] = process.argv.slice(2)
if (!before || !after) {
  console.error('usage: node scripts/perf-ab.mjs <renderer-dir-before> <renderer-dir-after> [rounds]')
  process.exit(2)
}
for (const dir of [before, after]) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    console.error(`${dir} does not look like an out/renderer directory (no index.html)`)
    process.exit(2)
  }
}
const ROUNDS = Number(roundsArg ?? 8)
const arms = { before, after }
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'total-ab-'))

/** One cold launch against whichever renderer is currently in out/. */
async function launchOnce() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'total-ab-profile-'))
  const t0 = Date.now()
  const app = await electron.launch({
    executablePath: electronPath,
    args: [process.cwd(), `--user-data-dir=${userDataDir}`],
    timeout: 60000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      TOTAL_DATA_DIR: dataDir,
      TOTAL_SUPPRESS_SYNC_WARNING: '1'
    }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.total), null, { timeout: 30000 })
  await page.waitForSelector('[data-screen]', { state: 'attached', timeout: 30000 })
  const firstScreen = Date.now() - t0
  const dcl = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    return Math.round(nav.domContentLoadedEventEnd - nav.fetchStart)
  })
  await app.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
  return { firstScreen, dcl }
}

const results = { before: [], after: [] }
for (let round = 0; round < ROUNDS; round++) {
  const order = round % 2 === 0 ? ['before', 'after'] : ['after', 'before']
  for (const arm of order) {
    execFileSync('rsync', ['-a', '--delete', arms[arm] + path.sep, path.join('out', 'renderer') + path.sep])
    const r = await launchOnce()
    results[arm].push(r)
    console.log(`${arm.padEnd(6)} first screen ${String(r.firstScreen).padStart(5)} ms   renderer DCL ${String(r.dcl).padStart(4)} ms`)
  }
}

const entryKb = (dir) => {
  const assets = path.join(dir, 'assets')
  const entry = fs.readdirSync(assets).find((f) => /^index-.*\.js$/.test(f))
  return entry ? Math.round(fs.statSync(path.join(assets, entry)).size / 1024) : 0
}

console.log('')
for (const key of ['firstScreen', 'dcl']) {
  const stat = (arm) => {
    const v = results[arm].map((r) => r[key]).sort((a, b) => a - b)
    return { min: v[0], med: v[Math.floor(v.length / 2)] }
  }
  const a = stat('before')
  const b = stat('after')
  console.log(
    `${key.padEnd(12)} before min ${a.min} med ${a.med}   after min ${b.min} med ${b.med}   Δmin ${b.min - a.min} ms`
  )
}
console.log(`entry chunk  before ${entryKb(before)} KB   after ${entryKb(after)} KB`)
console.log(
  '\nRead the MINIMUM. If Δmin is smaller than the gap between each arm\'s own min and median,\n' +
    'the machine moved more than the change did and there is nothing here to report.'
)
console.log('out/renderer now holds whichever arm ran last — rebuild before doing anything else.')
