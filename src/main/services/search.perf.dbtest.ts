// Books-search performance guard: ~50,000 vouchers (≈125k lines, 5k inventory lines) seeded by
// raw INSERTs in one transaction, then the typical palette queries are timed.
//
// Flake-proofing for slow CI: each query is timed best-of-3 (the minimum, so one GC pause or
// scheduler hiccup can't fail it), the bound is 500 ms locally and 2,000 ms when CI is set, and
// TOTAL_SKIP_PERF=1 skips the suite outright. Seeding runs in beforeAll with its own 120 s
// budget; every individual test stays far below the 30 s per-test timeout.
import { describe, it, expect, beforeAll } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { search } from './search'

const VOUCHERS = 50_000
const PARTIES = 1_000
const ITEMS = 200
const BOUND_MS = process.env.CI ? 2000 : 500
const skip = process.env.TOTAL_SKIP_PERF === '1'

const STATES = ['27', '29', '24', '07', '33']
const WORDS = ['Steel', 'Traders', 'Retail', 'Enterprises', 'Components', 'Agencies', 'Industries', 'Exports', 'Textiles', 'Foods']

function seed(db: DB): { partyGstin: string; partyName: string } {
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const debtors = g('Sundry Debtors')
  const salesGroup = g('Sales Accounts')
  const unit = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const types = [vt('sales'), vt('receipt'), vt('payment'), vt('journal'), vt('purchase')]

  let partyGstin = ''
  let partyName = ''
  db.transaction(() => {
    const insLedger = db.prepare('INSERT INTO ledgers (name, group_id, gstin, pan, state_code, address) VALUES (?, ?, ?, ?, ?, ?)')
    const parties: number[] = []
    for (let i = 0; i < PARTIES; i++) {
      const st = STATES[i % STATES.length]!
      const pan = `AAB${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i / 26) | 0) % 26)}${String(i).padStart(4, '0')}Z`
      const gstin = `${st}${pan}1Z${i % 10}`
      const name = `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}`
      const id = Number(insLedger.run(name, debtors, gstin, pan, st, `Plot ${i}, Industrial Area`).lastInsertRowid)
      parties.push(id)
      if (i === 517) { partyGstin = gstin; partyName = name }
    }
    const salesId = Number(insLedger.run('Sales Bulk A/c', salesGroup, null, null, null, null).lastInsertRowid)
    const insItem = db.prepare('INSERT INTO stock_items (name, unit_id, hsn) VALUES (?, ?, ?)')
    const items: number[] = []
    for (let i = 0; i < ITEMS; i++) items.push(Number(insItem.run(`Item ${WORDS[i % WORDS.length]} ${i}`, unit, String(8400 + (i % 50))).lastInsertRowid))

    const insV = db.prepare(
      'INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id, narration, reference, post_dated, is_optional, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const insL = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)')
    const insI = db.prepare("INSERT INTO inventory_lines (voucher_id, stock_item_id, qty_milli, rate_paise, amount, direction) VALUES (?, ?, 1000, ?, ?, 'out')")
    const start = Date.UTC(2024, 3, 1)
    for (let i = 0; i < VOUCHERS; i++) {
      const date = new Date(start + (i % 900) * 86_400_000).toISOString().slice(0, 10)
      const party = parties[(i * 31) % PARTIES]!
      const amount = 100_00 + ((i * 7919) % 2_000_000) * 100 // ₹100 … ₹20,00,099, whole rupees
      const type = types[i % types.length]!
      const vid = Number(
        insV.run(
          type, date, `V-${i}`, i % 4 === 0 ? null : party, i % 3 === 0 ? `Being goods supplied, bill ${i}` : null,
          i % 10 === 0 ? `REF-${i}` : null, i % 500 === 0 ? 1 : 0, i % 700 === 0 ? 1 : 0,
          i % 97 === 0 ? '2026-01-01 00:00:00' : null
        ).lastInsertRowid
      )
      if (i % 5 === 0) {
        // Three-line voucher: split debit.
        const a = Math.floor(amount / 3)
        insL.run(vid, party, 'dr', a, 0)
        insL.run(vid, cash, 'dr', amount - a, 1)
        insL.run(vid, salesId, 'cr', amount, 2)
      } else {
        insL.run(vid, party, 'dr', amount, 0)
        insL.run(vid, salesId, 'cr', amount, 1)
      }
      if (i % 10 === 0) insI.run(vid, items[i % ITEMS]!, amount, amount)
    }
  })()
  if (process.env.SEARCH_PERF_EXTRA_SQL) db.exec(process.env.SEARCH_PERF_EXTRA_SQL)
  db.exec('ANALYZE')
  return { partyGstin, partyName }
}

function bestOf3(fn: () => unknown): number {
  let best = Infinity
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe.skipIf(skip)('search performance (50k vouchers)', () => {
  let db: DB
  let fixture: { partyGstin: string; partyName: string }
  const timings: Record<string, number> = {}

  beforeAll(() => {
    db = seededDb()
    const t0 = performance.now()
    fixture = seed(db)
    timings['(seed)'] = performance.now() - t0
  }, 120_000)

  const QUERIES: [string, () => string][] = [
    ['free text (party word)', () => 'steel'],
    ['multi-term free text', () => 'steel traders 51'],
    ['voucher number', () => 'no:V-4242'],
    ['bare number (text + amount)', () => '4242'],
    ['exact amount', () => 'amt:1,48,500'],
    ['amount > 50,000', () => 'amt:>50000'],
    ['amount range', () => 'amt:1000..5000'],
    ['month', () => 'date:apr'],
    ['date range + type', () => 'date:2025-04-01..2025-06-30 type:sales'],
    ['fy + amount + type', () => 'fy:2025 type:receipt amt:>=100000'],
    ['gstin token', () => `gstin:${fixture.partyGstin}`],
    ['party token', () => `party:"${fixture.partyName}"`],
    ['group token (broad)', () => 'group:sundry'],
    ['narration phrase', () => '"goods supplied"'],
    ['hsn token', () => 'hsn:8421'],
    ['load more page 3', () => 'steel']
  ]

  for (const [label, q] of QUERIES) {
    it(`${label} returns within ${BOUND_MS} ms`, () => {
      const opts = label.startsWith('load more') ? { kind: 'voucher' as const, offset: 40 } : {}
      const r = search(db, q(), { today: '2026-10-07', fyStartYear: 2025, ...opts })
      expect(r.vouchers).not.toBeNull()
      const ms = bestOf3(() => search(db, q(), { today: '2026-10-07', fyStartYear: 2025, ...opts }))
      timings[label] = ms
      expect(ms).toBeLessThan(BOUND_MS)
    })
  }

  it('sanity: results are real and deleted vouchers stay out', () => {
    const r = search(db, 'amt:>50000', { today: '2026-10-07' })
    expect(r.vouchers!.total).toBeGreaterThan(1000)
    const deleted = (db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NOT NULL').get() as { n: number }).n
    expect(deleted).toBeGreaterThan(400)
    const all = search(db, 'no:V-', { today: '2026-10-07' }).vouchers!.total
    expect(all).toBe(VOUCHERS - deleted)
    expect(search(db, `gstin:${fixture.partyGstin}`).vouchers!.total).toBeGreaterThan(0)
    // Timings for the WP report (vitest prints console output per file).
    console.log('[search perf ms]', JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10]))))
  })
})
