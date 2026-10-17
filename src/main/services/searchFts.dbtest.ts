// To-do §4 — the voucher text index (migration "voucher text index", services/search.ts) must not
// change a single search result. The expected ids, order, totals and a hash of every returned row
// in __fixtures__/searchIndexEquality.json were generated from origin/main's search (the plain
// LIKE scan, before the index) with TOTAL_SEARCH_WRITE_EXPECTED=1 — only ever on known-good code,
// never to make this pass. Two companies: the demo seed and a 10k-voucher Perf Traders seed, each
// with the same deterministic extra narrations (Devanagari, accented, mixed case, partial
// numbers) and a few vouchers binned by raw SQL, so the fixture holds on both code bases.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { freshDb } from '../db/testdb'
import { openCompanyDb } from '../db/connection'
import type { DB } from '../db/connection'
import { createDemoCompany } from './demo'
import { PERF_TODAY, seedLargeAsync } from '../perf/seedLarge'
import { search } from './search'

const EXPECTED_PATH = join(__dirname, '__fixtures__', 'searchIndexEquality.json')
const WRITE = process.env.TOTAL_SEARCH_WRITE_EXPECTED === '1'
type Expect = { ids: number[]; total: number; hash: string }
const expected: Record<string, Record<string, Expect>> = existsSync(EXPECTED_PATH) ? JSON.parse(readFileSync(EXPECTED_PATH, 'utf8')) : {}
const written: Record<string, Record<string, Expect>> = { ...expected }

/** ≥ 30 queries: words, prefixes, case, partial numbers, Devanagari, accents, quoted phrases,
 *  tokens and combinations, short terms (no index), nothing found, and pages past the first. */
const QUERIES: { q: string; offset?: number }[] = [
  { q: 'Customer' }, { q: 'cus' }, { q: 'CUSTOMER 12' }, { q: 'Cus', offset: 20 }, { q: 'Cus', offset: 40 },
  { q: 'Expense' }, { q: 'expense 1' }, { q: 'Adjustment' }, { q: 'adjustment 77' }, { q: 'goods returned' },
  { q: '"goods returned"' }, { q: 'Goods' }, { q: 'bill 4' }, { q: 'Bill 4' }, { q: 'bill 41' }, { q: 'ill 4' },
  { q: '1/25' }, { q: '/25-' }, { q: 'no:1/25' }, { q: 'no:12' }, { q: 'no:SAL' }, { q: '12' }, { q: '4' }, { q: 'ab' },
  { q: 'बिल' }, { q: 'सामान' }, { q: 'बिल नंबर' }, { q: 'किराया दुकान' }, { q: 'café' }, { q: 'CAFÉ' }, { q: 'cafe' },
  { q: 'Rent' }, { q: 'rent 7' }, { q: 'xyzzy' }, { q: 'nothing here at all' }, { q: 'Sales' }, { q: 'sal' },
  { q: 'Cash' }, { q: 'Bank' }, { q: 'type:sales 1/25' }, { q: 'date:apr expense' }, { q: 'amt:>50000 cus' },
  { q: 'party:"Customer 1"' }, { q: 'REF-' }, { q: 'ref 9' }, { q: '%' }, { q: '_' }, { q: 'O\'Brien' }, { q: '"quoted ""text"' },
  { q: 'Item' }, { q: 'Item 12' }
]

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex')

/** The same extra text on both code bases (raw SQL — the index triggers keep up on the new one). */
function decorate(db: DB): void {
  db.exec(`
    UPDATE vouchers SET narration = 'बिल नंबर ' || id || ' सामान' WHERE id % 23 = 0;
    UPDATE vouchers SET narration = 'किराया दुकान ' || id WHERE id % 29 = 0;
    UPDATE vouchers SET narration = 'Café rent CAFÉ ' || id, reference = 'REF-' || id WHERE id % 31 = 0;
    UPDATE vouchers SET narration = 'Bill 4' || (id % 7) || ' paid', reference = 'ref ' || (id % 10) WHERE id % 37 = 0;
    UPDATE vouchers SET narration = 'Paid O''Brien 100% of the _first_ "quoted "text" bill' WHERE id % 41 = 0;
    UPDATE vouchers SET deleted_at = '2026-01-01 00:00:00' WHERE id % 43 = 0 AND deleted_at IS NULL;
  `)
}

function compare(name: string, db: DB): void {
  decorate(db)
  const got: Record<string, Expect> = {}
  for (const { q, offset } of QUERIES) {
    const r = search(db, q, { today: PERF_TODAY, offset, kind: offset ? 'voucher' : undefined })
    got[`${q}@${offset ?? 0}`] = { ids: r.vouchers!.rows.map((x) => x.id), total: r.vouchers!.total, hash: sha(r) }
  }
  if (WRITE) {
    written[name] = got
    return
  }
  const want = expected[name]
  expect(want, `no expectations for ${name} — generate them on origin/main`).toBeTruthy()
  expect(Object.keys(got).length).toBeGreaterThanOrEqual(30)
  expect(got).toEqual(want)
  // Not vacuous: most queries find vouchers, and the Devanagari / accented ones do too.
  expect(Object.values(got).filter((g) => g.total > 0).length).toBeGreaterThan(name === 'demo' ? 15 : 40)
  for (const k of ['बिल@0', 'सामान@0', 'किराया दुकान@0', 'café@0', 'CAFÉ@0', 'bill 4@0', 'REF-@0']) expect(got[k]!.total, k).toBeGreaterThan(0)
}

describe('search returns exactly what it did before the voucher text index', () => {
  afterAll(() => {
    if (WRITE) writeFileSync(EXPECTED_PATH, JSON.stringify(written, null, 2) + '\n')
  })

  it('on the demo company', () => {
    const root = mkdtempSync(join(tmpdir(), 'total-search-eq-'))
    const before = process.env.TOTAL_DATA_DIR
    process.env.TOTAL_DATA_DIR = root
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${PERF_TODAY}T10:00:00`))
    try {
      const { slug } = createDemoCompany()
      const db = openCompanyDb(slug)
      try {
        compare('demo', db)
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

  it('on a 10k-voucher Perf Traders seed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${PERF_TODAY}T10:00:00`))
    const db = freshDb()
    try {
      await seedLargeAsync(db, { vouchers: 10_000 })
      compare('perf10k', db)
    } finally {
      db.close()
      vi.useRealTimers()
    }
  }, 600_000)
})
