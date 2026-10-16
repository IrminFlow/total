// WP 7.1 — performance work must not change a single figure. Every budgeted read (and the same
// reports over other periods, ledgers and sides — reportSuite.ts) is hashed on two companies:
// the 0.10 demo seed (dated as on PERF_TODAY) and a 10k-voucher Perf Traders seed. The expected
// hashes in __fixtures__/reportHashes.json were generated from origin/main's code BEFORE the
// WP 7.1 index / query changes (TOTAL_PERF_WRITE_EXPECTED=1 rewrites them — only ever on code
// whose outputs are known good; a field added later is listed in ADDITIVE_FIELDS instead — never
// regenerate to pass). On a mismatch the outputs are written to a temp dir to diff.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { freshDb } from '../db/testdb'
import { openCompanyDb } from '../db/connection'
import { readCompanyInfo } from '../db/seed'
import { createDemoCompany } from '../services/demo'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { PERF_COMPANY, PERF_TODAY, seedLargeAsync } from './seedLarge'
import { canonical, hashOf, reportHashes, reportOutputs, withoutAdditive } from './reportSuite'

const EXPECTED_PATH = join(__dirname, '__fixtures__', 'reportHashes.json')
const WRITE = process.env.TOTAL_PERF_WRITE_EXPECTED === '1'
const expected: Record<string, Record<string, string>> = existsSync(EXPECTED_PATH) ? JSON.parse(readFileSync(EXPECTED_PATH, 'utf8')) : {}
const written: Record<string, Record<string, string>> = { ...expected }

/** vouchers.created_at is SQLite's real clock (fake timers can't reach it), and the anomaly scan
 *  in simple:homeAttention reads it (back-dated = entered 30+ days after its date) — so the hashes
 *  moved with the calendar (perf10k homeAttention failed on origin/main from 15 Oct 2026). Pinned
 *  to the day the expectations were generated (14 Oct 2026, UTC), so the inputs are the ones they
 *  were made on: with this pin origin/main's own code reproduces every expected hash.
 *  The two homeAttention hashes were moved once, on purpose (Home's "added for an earlier, closed
 *  date" no longer counts entries merely made 30+ days late): with the old rule restored the old
 *  hashes still matched, and the new outputs differ from them only by that dropped row. */
const ENTERED_ON = '2026-10-14 12:00:00'

async function compare(name: string, db: DB, info: CompanyInfo): Promise<void> {
  db.prepare('UPDATE vouchers SET created_at = ?').run(ENTERED_ON)
  const got = await reportHashes(db, info, PERF_TODAY)
  if (WRITE) {
    written[name] = got
    return
  }
  const want = expected[name]
  expect(want, `no expectations for ${name} — generate them on known-good code`).toBeTruthy()
  const differ = Object.keys({ ...want, ...got }).filter((k) => want![k] !== got[k])
  if (differ.length) {
    const dir = mkdtempSync(join(tmpdir(), `total-report-diff-${name}-`))
    const outputs = await reportOutputs(db, info, PERF_TODAY)
    for (const k of differ) writeFileSync(join(dir, `${k.replace(/[^\w.-]/g, '_')}.json`), canonical(outputs[k] ?? null))
    console.log(`[report equality] ${name}: outputs that differ written to ${dir}`)
  }
  expect(differ, `${name}: these outputs changed`).toEqual([])
}

describe('report outputs are unchanged by the performance work (WP 7.1)', () => {
  afterAll(() => {
    if (WRITE) writeFileSync(EXPECTED_PATH, JSON.stringify(written, null, 2) + '\n')
  })

  it('an additive field is left out of the hash only at its neutral value (never regenerate to pass)', () => {
    const before = { lines: { sales: 100, expenses: 30, profit: 70 } }
    expect(hashOf(withoutAdditive('doing', { lines: { ...before.lines, rounding: 0 } }))).toBe(hashOf(before))
    expect(hashOf(withoutAdditive('home', { profit: { month: { lines: { ...before.lines, rounding: 0 } } } }))).toBe(hashOf({ profit: { month: before } }))
    // A real round-off still changes the hash, and so does the field on any other output.
    expect(hashOf(withoutAdditive('doing', { lines: { ...before.lines, rounding: 50 } }))).not.toBe(hashOf(before))
    expect(hashOf(withoutAdditive('pnl:2025-04-01', { lines: { ...before.lines, rounding: 0 } }))).not.toBe(hashOf(before))
  })

  // The clock is pinned to the perf day in both cases, so nothing date-relative can drift.
  it('on a 10k-voucher Perf Traders seed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${PERF_TODAY}T10:00:00`))
    const db = freshDb()
    try {
      await seedLargeAsync(db, { vouchers: 10_000 })
      await compare('perf10k', db, PERF_COMPANY)
    } finally {
      db.close()
      vi.useRealTimers()
    }
  }, 600_000)

  it('on the demo company, dated as on the perf day', async () => {
    const root = mkdtempSync(join(tmpdir(), 'total-report-eq-'))
    const before = process.env.TOTAL_DATA_DIR
    process.env.TOTAL_DATA_DIR = root
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${PERF_TODAY}T10:00:00`))
    try {
      const { slug } = createDemoCompany()
      const db = openCompanyDb(slug)
      try {
        await compare('demo', db, readCompanyInfo(db))
      } finally {
        db.close()
      }
    } finally {
      vi.useRealTimers()
      if (before === undefined) delete process.env.TOTAL_DATA_DIR
      else process.env.TOTAL_DATA_DIR = before
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
