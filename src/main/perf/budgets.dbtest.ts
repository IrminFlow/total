// WP 7.1 — the performance budgets (docs/perf-budgets.md) at 100k vouchers, as a test. Off unless
// TOTAL_PERF=1 (seeding 100k through the services takes minutes); the CI `perf` job runs it on a
// cached seed (TOTAL_PERF_DATA = a `total-cli perf-seed` data root, copied before use so the
// cache stays pristine). Every budgeted operation is timed (one cold call, then the median of 3)
// and fails only when it is over 150 % of its budget × TOTAL_PERF_SCALE (the runner's speed
// relative to the laptop the budgets were measured on — recorded in docs/perf-budgets.md).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { closeCompanyDb, openCompanyDb, type DB } from '../db/connection'
import { readCompanyInfo } from '../db/seed'
import { MIGRATIONS } from '../db/migrations'
import { PERF_TODAY, seedLargeAsync, booksFingerprint } from './seedLarge'
import { PERF_SLUG, usePerfDataRoot, fingerprintHash } from './cli'
import { formatTable, overBudget, perfContext, runPerf, type PerfResult } from './bench'

const enabled = process.env.TOTAL_PERF === '1'
const VOUCHERS = Number(process.env.TOTAL_PERF_VOUCHERS ?? 100_000)
const SCALE = Number(process.env.TOTAL_PERF_SCALE ?? 1)

describe.skipIf(!enabled)(`performance budgets (${VOUCHERS.toLocaleString('en-IN')} vouchers, × ${SCALE})`, () => {
  const before = process.env.TOTAL_DATA_DIR
  const root = mkdtempSync(join(tmpdir(), 'total-perf-budgets-'))
  let db: DB
  let openMs = 0
  let results: PerfResult[] = []

  beforeAll(async () => {
    const cached = process.env.TOTAL_PERF_DATA
    if (cached && existsSync(join(cached, 'perf-seed.json'))) {
      cpSync(cached, root, { recursive: true })
      usePerfDataRoot(root)
    } else {
      usePerfDataRoot(root)
      const seeding = openCompanyDb(PERF_SLUG)
      const summary = await seedLargeAsync(seeding, { vouchers: VOUCHERS })
      const fingerprint = booksFingerprint(seeding)
      closeCompanyDb(seeding)
      writeFileSync(join(root, 'perf-seed.json'), JSON.stringify({ vouchers: VOUCHERS, migrations: MIGRATIONS.length, summary, fingerprint, hash: fingerprintHash(fingerprint) }))
    }
    const t0 = performance.now()
    db = openCompanyDb(PERF_SLUG)
    openMs = performance.now() - t0
  }, 3_600_000)

  afterAll(() => {
    db?.open && closeCompanyDb(db)
    if (before === undefined) delete process.env.TOTAL_DATA_DIR
    else process.env.TOTAL_DATA_DIR = before
    rmSync(root, { recursive: true, force: true })
  })

  it('every budgeted operation is within 150 % of its budget', async () => {
    const manifest = JSON.parse(readFileSync(join(root, 'perf-seed.json'), 'utf8')) as { vouchers: number }
    const ctx = perfContext(db, readCompanyInfo(db), PERF_TODAY)
    results = await runPerf(ctx, manifest.vouchers)
    console.log(`[perf] ${manifest.vouchers} vouchers, company DB open ${openMs.toFixed(0)} ms, budgets × ${SCALE}\n${formatTable(results, SCALE)}`)
    // The runner's speed against the budgets — what to set TOTAL_PERF_SCALE to (median ratio).
    const ratios = results.map((r) => r.medianMs / r.budgetMs).sort((a, b) => a - b)
    console.log(`[perf] median measured / budget: ${ratios[Math.floor(ratios.length / 2)]!.toFixed(2)}`)
    const over = overBudget(results, SCALE).map((r) => `${r.id} ${r.medianMs.toFixed(0)} ms > 150 % of ${(r.budgetMs * SCALE).toFixed(0)} ms`)
    expect(over).toEqual([])
  }, 1_800_000)
})
