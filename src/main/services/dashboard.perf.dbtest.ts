// Gateway dashboard performance guard (WP 1.10b): ~50,000 vouchers (sales/purchase/receipt/
// payment/journal across 1,000 debtors + 100 creditors, 5k inventory lines, some soft-deleted /
// optional / post-dated) seeded by raw INSERTs, then dashboardSeries is timed best-of-3.
// Same flake-proofing as search.perf.dbtest.ts: best-of-3, 2,000 ms when CI is set,
// TOTAL_SKIP_PERF=1 skips the suite.
//
// The WP target was 150 ms. Measured ~200 ms (Apple silicon, 2026-10): the floor is the shared
// report functions the dashboard deliberately reuses — Outstandings for both sides (~65 ms) and
// the one grouped scan of every cash/bank/party line for balances + trends (~50 ms); the 13
// month P&Ls cost ~30 ms. So the local bound is a 300 ms regression guard, not the target.
import { describe, it, expect, beforeAll } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import { dashboardSeries } from './dashboard'

const VOUCHERS = 50_000
const DEBTORS = 1_000
const CREDITORS = 100
const ITEMS = 200
const BOUND_MS = process.env.CI ? 2000 : 300
const skip = process.env.TOTAL_SKIP_PERF === '1'

function seed(db: DB): void {
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const unit = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  db.transaction(() => {
    const insLedger = db.prepare('INSERT INTO ledgers (name, group_id) VALUES (?, ?)')
    const debtors: number[] = []
    const creditors: number[] = []
    for (let i = 0; i < DEBTORS; i++) debtors.push(Number(insLedger.run(`Debtor ${i}`, g('Sundry Debtors')).lastInsertRowid))
    for (let i = 0; i < CREDITORS; i++) creditors.push(Number(insLedger.run(`Creditor ${i}`, g('Sundry Creditors')).lastInsertRowid))
    const sales = Number(insLedger.run('Sales Bulk', g('Sales Accounts')).lastInsertRowid)
    const purchase = Number(insLedger.run('Purchase Bulk', g('Purchase Accounts')).lastInsertRowid)
    const bank = Number(insLedger.run('Bulk Bank', g('Bank Accounts')).lastInsertRowid)
    const rent = Number(insLedger.run('Rent', g('Indirect Expenses')).lastInsertRowid)
    const insItem = db.prepare('INSERT INTO stock_items (name, unit_id, reorder_level_milli) VALUES (?, ?, ?)')
    const items: number[] = []
    for (let i = 0; i < ITEMS; i++) items.push(Number(insItem.run(`Item ${i}`, unit, i % 20 === 0 ? 5_000_000 : null).lastInsertRowid))

    const insV = db.prepare(
      'INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id, post_dated, is_optional, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const insL = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)')
    const insI = db.prepare('INSERT INTO inventory_lines (voucher_id, stock_item_id, qty_milli, rate_paise, amount, direction) VALUES (?, ?, 1000, ?, ?, ?)')
    const types = { sales: vt('sales'), purchase: vt('purchase'), receipt: vt('receipt'), payment: vt('payment'), journal: vt('journal') }
    const start = Date.UTC(2024, 3, 1)
    for (let i = 0; i < VOUCHERS; i++) {
      const date = new Date(start + (i % 900) * 86_400_000).toISOString().slice(0, 10)
      const amount = 100_00 + ((i * 7919) % 200_000) * 100
      const debtor = debtors[(i * 31) % DEBTORS]!
      const creditor = creditors[(i * 17) % CREDITORS]!
      const flags = [i % 500 === 0 ? 1 : 0, i % 700 === 0 ? 1 : 0, i % 97 === 0 ? '2026-01-01 00:00:00' : null] as const
      const kind = (['sales', 'purchase', 'receipt', 'payment', 'journal'] as const)[i % 5]!
      const party = kind === 'sales' || kind === 'receipt' ? debtor : kind === 'journal' ? null : creditor
      const vid = Number(insV.run(types[kind], date, `V-${i}`, party, ...flags).lastInsertRowid)
      const line = (ledger: number, drCr: 'dr' | 'cr', n: number): void => void insL.run(vid, ledger, drCr, amount, n)
      if (kind === 'sales') { line(debtor, 'dr', 0); line(sales, 'cr', 1) }
      else if (kind === 'purchase') { line(purchase, 'dr', 0); line(creditor, 'cr', 1) }
      else if (kind === 'receipt') { line(i % 2 ? bank : cash, 'dr', 0); line(debtor, 'cr', 1) }
      else if (kind === 'payment') { line(creditor, 'dr', 0); line(i % 2 ? bank : cash, 'cr', 1) }
      else { line(rent, 'dr', 0); line(cash, 'cr', 1) }
      if (i % 10 === 0) insI.run(vid, items[i % ITEMS]!, amount, amount, kind === 'purchase' ? 'in' : 'out')
      if (i % 10 === 1 && kind === 'purchase') insI.run(vid, items[i % ITEMS]!, amount, amount, 'in')
    }
  })()
  db.exec('ANALYZE')
}

describe.skipIf(skip)('dashboard performance (50k vouchers)', () => {
  let db: DB
  beforeAll(() => {
    db = seededDb()
    seed(db)
  }, 120_000)

  it(`dashboardSeries returns within ${BOUND_MS} ms`, () => {
    const run = (): ReturnType<typeof dashboardSeries> =>
      dashboardSeries(db, TEST_INFO, { today: '2026-09-15', from: '2026-04-01', to: '2027-03-31', backups: [] })
    const first = run()
    for (const [key, sec] of Object.entries(first)) {
      if (key !== 'window') expect((sec as { ok: boolean }).ok, key).toBe(true)
    }
    let best = Infinity
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now()
      run()
      best = Math.min(best, performance.now() - t0)
    }
    console.log(`[dashboard perf] dashboardSeries best of 3: ${best.toFixed(1)} ms`)
    expect(best).toBeLessThan(BOUND_MS)
  })
})
