// WP 7.1 — performance work must not change a single figure. Every budgeted read (and the same
// reports over other periods, ledgers and sides — reportSuite.ts) is hashed on two companies:
// the 0.10 demo seed (dated as on PERF_TODAY) and a 10k-voucher Perf Traders seed. The expected
// hashes in __fixtures__/reportHashes.json were generated from origin/main's code BEFORE the
// WP 7.1 index / query changes (TOTAL_PERF_WRITE_EXPECTED=1 rewrites them — only ever on code
// whose outputs are known good). On a mismatch the outputs are written to a temp dir to diff.
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
import { canonical, reportHashes, reportOutputs } from './reportSuite'

const EXPECTED_PATH = join(__dirname, '__fixtures__', 'reportHashes.json')
const WRITE = process.env.TOTAL_PERF_WRITE_EXPECTED === '1'
const expected: Record<string, Record<string, string>> = existsSync(EXPECTED_PATH) ? JSON.parse(readFileSync(EXPECTED_PATH, 'utf8')) : {}
const written: Record<string, Record<string, string>> = { ...expected }

async function compare(name: string, db: DB, info: CompanyInfo): Promise<void> {
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
