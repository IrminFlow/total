// Production-build startup budget. Measures actual Electron launch, first interactive screen,
// company creation, restart and existing-company open on a hermetic data/profile directory.
import { Harness, assert } from './lib/harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const budgets = { coldLaunchMs: 8_000, createAndOpenMs: 6_000, warmLaunchMs: 8_000, existingOpenMs: 5_000 }
const outDir = process.env.SMOKE_OUT ?? path.join(os.tmpdir(), 'total-performance')
const h = new Harness({ outDir })
const metrics = {}

try {
  let started = performance.now()
  await h.launch()
  await h.waitScreen('company-select')
  metrics.coldLaunchMs = Math.round(performance.now() - started)

  started = performance.now()
  await h.createCompanyUI('Performance Gate Co')
  metrics.createAndOpenMs = Math.round(performance.now() - started)

  started = performance.now()
  await h.relaunch()
  await h.waitScreen('company-select')
  metrics.warmLaunchMs = Math.round(performance.now() - started)

  started = performance.now()
  await h.openCompany('Performance Gate Co')
  metrics.existingOpenMs = Math.round(performance.now() - started)

  for (const [name, budget] of Object.entries(budgets)) {
    assert(metrics[name] <= budget, `${name} ${metrics[name]}ms exceeds ${budget}ms budget`)
  }
  h.assertNoConsoleErrors()
  h.assertNoKeyWarnings()
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'startup-performance.json'), JSON.stringify({ measuredAt: new Date().toISOString(), budgets, metrics }, null, 2))
  console.log(JSON.stringify({ ok: true, budgets, metrics }))
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  await h.close()
}
