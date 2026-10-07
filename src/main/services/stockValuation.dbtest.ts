import { describe, it, expect, afterEach } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import * as stockAnalysis from './stockAnalysis'
import { itemProfitability } from './reports'
import { seedStockFixture } from './stockFixture.testutil'

// ---------- legacy parity (WP 2.1) ----------
// The file snapshot below was generated on origin/main BEFORE the global valuation pass landed
// (commit "test: pin legacy stock valuation outputs"). Every existing voucher uses the 'stored'
// costing rule, so every stock figure the app reports must stay byte-identical: a company's
// stock value must not move on upgrade. Do not regenerate this snapshot to make a change pass.

function legacyOutputs(): unknown {
  const db = seededDb()
  const fx = seedStockFixture(db, { vouchers: 2500, items: 30, seed: 7 })
  const ends = ['2025-04-30', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31']
  return {
    lines: fx.inventoryLines,
    summary: ends.map((d) => stockAnalysis.stockSummary(db, d)),
    summaryByGodown: fx.godownIds.map((g) => stockAnalysis.stockSummary(db, '2026-03-31', { godownId: g })),
    stockValue: ends.map((d) => stockAnalysis.stockValue(db, d)),
    valuesAt: [...stockAnalysis.stockValuesAt(db, ends).entries()],
    consumption: [
      ['2025-04-01', '2025-06-30'],
      ['2025-07-15', '2025-07-15'],
      ['2025-10-01', '2026-03-31']
    ].map(([f, t]) => [...stockAnalysis.periodConsumption(db, f!, t!).entries()].sort((a, b) => a[0] - b[0])),
    byGodown: stockAnalysis.stockByGodown(db, '2026-03-31'),
    profitability: itemProfitability(db, '2025-04-01', '2026-03-31')
  }
}

describe('stock valuation — legacy parity', () => {
  it('reproduces origin/main outputs byte-for-byte on a randomised fixture', async () => {
    await expect(JSON.stringify(legacyOutputs(), null, 1)).toMatchFileSnapshot('./__snapshots__/stockValuation.legacy.json')
  })
})

// ---------- costing rule selection + additional-cost precedence (WP 2.1) ----------

/** A stand-in for WP 2.2's manufacture_details: marks vouchers derived, with optional labour. */
function markDerivedVia(db: DB): (voucherId: number, labour?: number | null) => void {
  db.exec('CREATE TABLE IF NOT EXISTS test_manufacture (voucher_id INTEGER PRIMARY KEY, labour INTEGER)')
  stockAnalysis.setDerivedCostingSource(
    (d) =>
      d.prepare('SELECT voucher_id AS voucherId, labour AS additionalCostPaise FROM test_manufacture').all() as stockAnalysis.DerivedCostingMark[]
  )
  return (voucherId, labour = null) => {
    db.prepare('INSERT OR REPLACE INTO test_manufacture (voucher_id, labour) VALUES (?, ?)').run(voucherId, labour)
  }
}

interface Inv {
  item: number
  dir: 'in' | 'out'
  qty: number
  amount?: number
  godown?: number | null
  abs?: boolean
}

let seq = 0
function post(
  db: DB,
  kind: string,
  date: string,
  inv: Inv[],
  opts: { extra?: number; deleted?: boolean; postDated?: boolean } = {}
): number {
  const vt = (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const vid = Number(
    db
      .prepare('INSERT INTO vouchers (voucher_type_id, date, number, deleted_at, post_dated) VALUES (?, ?, ?, ?, ?)')
      .run(vt, date, `T-${++seq}`, opts.deleted ? '2026-01-01 00:00:00' : null, opts.postDated ? 1 : 0).lastInsertRowid
  )
  const insI = db.prepare(
    `INSERT INTO inventory_lines (voucher_id, stock_item_id, godown_id, qty_milli, rate_paise, amount, direction, line_order, is_absolute)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
  )
  inv.forEach((l, i) => insI.run(vid, l.item, l.godown ?? null, l.qty, l.amount ?? 0, l.dir, i, l.abs ? 1 : 0))
  if (opts.extra) {
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const insL = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)')
    insL.run(vid, cash, 'dr', opts.extra, 0)
    insL.run(vid, cash, 'cr', opts.extra, 1)
  }
  return vid
}

function newItem(db: DB, name: string, method: 'fifo' | 'weighted_avg', q = 0, v = 0): number {
  const unit = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  return Number(
    db
      .prepare('INSERT INTO stock_items (name, unit_id, opening_qty_milli, opening_value, valuation_method) VALUES (?, ?, ?, ?, ?)')
      .run(name, unit, q, v, method).lastInsertRowid
  )
}

const closing = (db: DB, item: number, asOn = '2025-12-31', godownId?: number): number =>
  stockAnalysis.stockSummary(db, asOn, { godownId }).find((r) => r.stockItemId === item)!.closingValue

describe('voucherCosting — rule selection and additional-cost precedence', () => {
  afterEach(() => stockAnalysis.setDerivedCostingSource(null))

  it('default: nothing is derived — a manufacture keeps its stored inward value (+ ledger extra)', () => {
    const db = seededDb()
    const raw = newItem(db, 'Raw', 'weighted_avg', 10000, 100000)
    const fg = newItem(db, 'FG', 'weighted_avg')
    const v = post(db, 'stock_journal', '2025-05-01', [
      { item: raw, dir: 'out', qty: 4000 },
      { item: fg, dir: 'in', qty: 1000, amount: 99999 }
    ], { extra: 500 })
    expect(stockAnalysis.voucherCosting(db, '2025-12-31').get(v)).toEqual({ rule: 'stored', additionalCostPaise: 500 })
    expect(closing(db, fg)).toBe(100499)
  })

  it('marked mixed stock journal → derived; no explicit labour → the Dr ledger total is the additional cost', () => {
    const db = seededDb()
    const mark = markDerivedVia(db)
    const raw = newItem(db, 'Raw', 'weighted_avg', 10000, 100000)
    const fg = newItem(db, 'FG', 'weighted_avg')
    const v = post(db, 'stock_journal', '2025-05-01', [
      { item: raw, dir: 'out', qty: 4000 },
      { item: fg, dir: 'in', qty: 1000, amount: 99999 }
    ], { extra: 500 })
    mark(v)
    expect(stockAnalysis.voucherCosting(db, '2025-12-31').get(v)).toEqual({ rule: 'derived', additionalCostPaise: 500 })
    expect(closing(db, fg)).toBe(40000 + 500)
    expect(closing(db, raw)).toBe(60000)
  })

  it('explicit labour wins over the ledger-line total (never summed)', () => {
    const db = seededDb()
    const mark = markDerivedVia(db)
    const raw = newItem(db, 'Raw', 'fifo', 10000, 100000)
    const fg = newItem(db, 'FG', 'fifo')
    const v = post(db, 'stock_journal', '2025-05-01', [
      { item: raw, dir: 'out', qty: 4000 },
      { item: fg, dir: 'in', qty: 1000 }
    ], { extra: 500 })
    mark(v, 700)
    expect(stockAnalysis.voucherCosting(db, '2025-12-31').get(v)).toEqual({ rule: 'derived', additionalCostPaise: 700 })
    expect(closing(db, fg)).toBe(40700)
    mark(v, 0) // an explicit zero is still explicit
    expect(closing(db, fg)).toBe(40000)
  })

  it("marks on ineligible or out-of-books vouchers are ignored — they stay 'stored'", () => {
    const db = seededDb()
    const mark = markDerivedVia(db)
    const raw = newItem(db, 'Raw', 'weighted_avg', 10000, 100000)
    const fg = newItem(db, 'FG', 'weighted_avg')
    const mixed = (date: string, o: { deleted?: boolean; postDated?: boolean } = {}): number =>
      post(db, 'stock_journal', date, [{ item: raw, dir: 'out', qty: 1000 }, { item: fg, dir: 'in', qty: 1000, amount: 5 }], o)
    const vouchers = [
      post(db, 'stock_journal', '2025-05-01', [{ item: fg, dir: 'in', qty: 1000, amount: 1234 }]), // inward only
      post(db, 'sales', '2025-05-02', [{ item: raw, dir: 'out', qty: 1000 }, { item: fg, dir: 'in', qty: 1000, amount: 10 }]),
      post(db, 'stock_journal', '2025-05-03', [{ item: raw, dir: 'out', qty: 1000 }, { item: fg, dir: 'in', qty: 3000, abs: true }]),
      mixed('2025-05-04', { deleted: true }),
      mixed('2025-05-04', { postDated: true })
    ]
    const later = mixed('2026-05-04')
    for (const v of [...vouchers, later]) mark(v, 100)
    const costing = stockAnalysis.voucherCosting(db, '2025-12-31')
    expect([...costing.values()].filter((c) => c.rule === 'derived')).toEqual([])
    const marked = stockAnalysis.stockSummary(db, '2025-12-31')
    expect(stockAnalysis.voucherCosting(db, '2026-12-31').get(later)).toEqual({ rule: 'derived', additionalCostPaise: 100 })
    stockAnalysis.setDerivedCostingSource(null)
    expect(stockAnalysis.stockSummary(db, '2025-12-31')).toEqual(marked)
  })

  it('godown view books a derived inward line at its company-wide value', () => {
    const db = seededDb()
    const mark = markDerivedVia(db)
    const [ga, gb] = ['A', 'B'].map((n) => Number(db.prepare('INSERT INTO godowns (name) VALUES (?)').run(`G${n}`).lastInsertRowid))
    const raw = newItem(db, 'Raw', 'weighted_avg')
    const fg = newItem(db, 'FG', 'weighted_avg')
    post(db, 'purchase', '2025-05-01', [{ item: raw, dir: 'in', qty: 10000, amount: 100000, godown: ga }])
    const v = post(db, 'stock_journal', '2025-05-02', [
      { item: raw, dir: 'out', qty: 5000, godown: ga },
      { item: fg, dir: 'in', qty: 1000, amount: 1, godown: gb }
    ])
    mark(v, 250)
    expect(closing(db, fg, '2025-12-31', gb)).toBe(50250)
    expect(closing(db, fg)).toBe(50250)
    expect(closing(db, raw, '2025-12-31', ga)).toBe(50000)
    expect(stockAnalysis.stockByGodown(db, '2025-12-31').find((r) => r.stockItemId === fg)).toMatchObject({ godownId: gb, closingValue: 50250 })
  })

  it('derived fixture: multi-date reports agree with single-date ones, and derived really re-values', () => {
    const db = seededDb()
    const mark = markDerivedVia(db)
    const fx = seedStockFixture(db, { vouchers: 1500, items: 25, seed: 3 })
    fx.mixedJournalIds.forEach((v, i) => mark(v, i % 2 === 0 ? null : 100 + i))
    const ends = ['2025-06-30', '2025-09-30', '2026-03-31']
    const at = stockAnalysis.stockValuesAt(db, ends)
    for (const d of ends) expect(at.get(d)).toBe(stockAnalysis.stockValue(db, d))
    // Consumption over adjacent periods adds up (checkpoint arithmetic through derived vouchers).
    const whole = stockAnalysis.periodConsumption(db, '2025-04-01', '2026-03-31')
    const first = stockAnalysis.periodConsumption(db, '2025-04-01', '2025-09-30')
    const second = stockAnalysis.periodConsumption(db, '2025-10-01', '2026-03-31')
    for (const [id, c] of whole) {
      expect(first.get(id)!.consumedValue + second.get(id)!.consumedValue).toBe(c.consumedValue)
      expect(first.get(id)!.outwardQtyMilli + second.get(id)!.outwardQtyMilli).toBe(c.outwardQtyMilli)
    }
    const derivedValue = stockAnalysis.stockValue(db, '2026-03-31')
    stockAnalysis.setDerivedCostingSource(null)
    expect(stockAnalysis.stockValue(db, '2026-03-31')).not.toBe(derivedValue)
  })
})

describe('costAsOf', () => {
  afterEach(() => stockAnalysis.setDerivedCostingSource(null))

  it('prices raw materials as of the voucher date exactly as saving a derived voucher books them', () => {
    const db = seededDb()
    const mark = markDerivedVia(db)
    const a = newItem(db, 'Steel', 'weighted_avg', 10000, 100000)
    const b = newItem(db, 'Bolts', 'fifo', 100000, 50000)
    const fg = newItem(db, 'Frame', 'weighted_avg')
    post(db, 'purchase', '2025-05-01', [
      { item: a, dir: 'in', qty: 10000, amount: 300000 },
      { item: b, dir: 'in', qty: 100000, amount: 80000 }
    ])
    post(db, 'purchase', '2025-06-01', [{ item: a, dir: 'in', qty: 10000, amount: 900000 }]) // after the voucher date

    const lines = [{ itemId: a, qtyMilli: 3000 }, { itemId: b, qtyMilli: 150000 }]
    const q = stockAnalysis.costAsOf(db, { date: '2025-05-10', lines })
    expect(q.positions.map((p) => [p.itemId, p.qtyMilli, p.value, p.averageCostPerUnitPaise])).toEqual([
      [a, 20000, 400000, 20000],
      [b, 200000, 130000, 650]
    ])
    expect(q.positions[1]!.nextLayer).toEqual({ qtyMilli: 100000, value: 50000, perUnitPaise: 500 })
    // Steel 3 @ avg ₹200 = 60000; Bolts 100 @ ₹5 + 50 @ ₹8 = 50000 + 40000.
    expect(q.consumption!.lines.map((l) => l.costPaise)).toEqual([60000, 90000])
    expect(q.consumption!.totalPaise).toBe(150000)

    const v = post(db, 'stock_journal', '2025-05-10', [
      { item: fg, dir: 'in', qty: 1000 },
      { item: a, dir: 'out', qty: 3000 },
      { item: b, dir: 'out', qty: 150000 }
    ])
    mark(v, 1500)
    expect(closing(db, fg)).toBe(151500)
    // Editing that voucher: its own lines are left out, so the figures are unchanged.
    expect(stockAnalysis.costAsOf(db, { date: '2025-05-10', voucherId: v, lines }).consumption!.totalPaise).toBe(150000)
    // A new voucher the same day is priced after it.
    expect(stockAnalysis.costAsOf(db, { date: '2025-05-10', itemIds: [a] }).positions[0]!.qtyMilli).toBe(17000)
  })
})
