// WP 2.3 — stock visibility: the movement register reads the valuation pass (its closing equals
// the stock summary's), godown transfers conserve value, serial numbers follow the line serials
// through save / edit / bin / restore, per-item valuation method switches, reorder planning,
// expiry report, barcode labels, and migration 021 on a populated fixture.
import { describe, it, expect } from 'vitest'
import { freshPartialDb, seededDb, TEST_INFO } from '../db/testdb'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { seedCompany } from '../db/seed'
import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import type { VoucherInput } from '@shared/schemas'
import { buildTransferPayload, emptyTransferState, transferCostQuery, type TransferRowState } from '@shared/voucherEdit'
import { createBatch, createGodown, createLedger, createStockItem, listStockItems, updateStockItem } from './masters'
import { deleteVoucher, getVoucher, restoreVoucher, saveVoucher } from './vouchers'
import * as stock from './stockAnalysis'
import { availableSerials, listSerials } from './serials'
import { savePriceLevel, saveRate } from './priceLevels'
import { seedStockFixture } from './stockFixture.testutil'

const typeId = (db: DB, kind: VoucherKind): number =>
  (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

function unitId(db: DB): number {
  const u = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined
  return u?.id ?? Number(db.prepare("INSERT INTO units (name, symbol, decimals) VALUES ('Numbers', 'nos', 0)").run().lastInsertRowid)
}

function item(db: DB, name: string, opts: { method?: 'weighted_avg' | 'fifo'; serials?: boolean; reorder?: number | null; barcode?: string | null; opening?: [number, number] } = {}): number {
  return createStockItem(db, {
    name, groupId: null, unitId: unitId(db), hsn: null, gstRate: null, cessRate: null,
    openingQtyMilli: opts.opening?.[0] ?? 0, openingValue: opts.opening?.[1] ?? 0, barcode: opts.barcode ?? null,
    reorderLevelMilli: opts.reorder ?? null, valuationMethod: opts.method ?? 'weighted_avg', trackSerials: opts.serials ?? false
  }).id
}

function ledger(db: DB, name: string, group: string): number {
  const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(group) as { id: number }
  return createLedger(db, {
    name, groupId: g.id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

const header = {
  number: undefined, partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
  transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null
}

interface Line {
  item: number
  qty: number // whole units
  amount?: number
  dir: 'in' | 'out'
  godown?: number | null
  batch?: number | null
  serials?: string[]
}

const inv = (l: Line): VoucherInput['inventory'] extends (infer T)[] | undefined ? T : never => ({
  stockItemId: l.item, godownId: l.godown ?? null, batchId: l.batch ?? null, qtyMilli: l.qty * 1000,
  ratePaise: l.amount ? Math.round(l.amount / l.qty) : 0, amount: l.amount ?? 0, direction: l.dir,
  ...(l.serials ? { serials: l.serials } : {})
})

interface Books {
  db: DB
  party: number
  supplier: number
  sales: number
  purchases: number
}

function books(): Books {
  const db = seededDb()
  return {
    db,
    party: ledger(db, 'Buyer', 'Sundry Debtors'),
    supplier: ledger(db, 'Supplier', 'Sundry Creditors'),
    sales: ledger(db, 'Sales', 'Sales Accounts'),
    purchases: ledger(db, 'Purchases', 'Purchase Accounts')
  }
}

/** A trading voucher with balanced party / sales-or-purchase lines. */
function trade(b: Books, kind: 'sales' | 'purchase' | 'credit_note' | 'debit_note', date: string, lines: Line[], id?: number): number {
  const total = lines.reduce((s, l) => s + (l.amount ?? 0), 0) || 100
  const party = kind === 'sales' || kind === 'credit_note' ? b.party : b.supplier
  const account = kind === 'sales' || kind === 'credit_note' ? b.sales : b.purchases
  const partyDr = kind === 'sales' || kind === 'debit_note'
  return saveVoucher(b.db, {
    ...header, voucherTypeId: typeId(b.db, kind), date, partyLedgerId: party,
    lines: [
      { ledgerId: party, drCr: partyDr ? 'dr' : 'cr', amount: total },
      { ledgerId: account, drCr: partyDr ? 'cr' : 'dr', amount: total }
    ],
    inventory: lines.map(inv)
  }, id).id
}

function journal(db: DB, date: string, lines: Line[], kind: 'stock_journal' | 'physical_stock' = 'stock_journal'): number {
  return saveVoucher(db, { ...header, voucherTypeId: typeId(db, kind), date, lines: [], inventory: lines.map(inv) }).id
}

const summaryRow = (db: DB, itemId: number, asOn: string, godownId?: number) =>
  stock.stockSummary(db, asOn, { godownId }).find((r) => r.stockItemId === itemId)!

// ---------- movement register ----------

describe('stock movement register', () => {
  it('closing equals stock summary closing for every item, company-wide and per godown (randomised fixture)', () => {
    const db = seededDb()
    const fx = seedStockFixture(db, { vouchers: 400, items: 12, seed: 4242 })
    let rowsSeen = 0
    for (const asOf of ['2025-09-30', '2026-03-31']) {
      for (const itemId of fx.itemIds) {
        const reg = stock.stockMovements(db, itemId, '2025-07-01', asOf)
        const s = summaryRow(db, itemId, asOf)
        expect(reg.closing).toEqual({ qtyMilli: s.closingQtyMilli, value: s.closingValue })
        // Running figures chain from the opening through every row.
        let q = reg.opening.qtyMilli
        for (const r of reg.rows) {
          q += r.inwardQtyMilli - r.outwardQtyMilli
          expect(r.runningQtyMilli).toBe(q)
        }
        rowsSeen += reg.rows.length
        if (reg.rows.length) expect(reg.rows.at(-1)!.runningValue).toBe(reg.closing.value)
        expect(reg.opening.qtyMilli + reg.totals.inwardQtyMilli - reg.totals.outwardQtyMilli).toBe(reg.closing.qtyMilli)
        expect(reg.opening.value + reg.totals.inwardValue - reg.totals.outwardValue).toBe(reg.closing.value)
        for (const g of fx.godownIds) {
          const gr = stock.stockMovements(db, itemId, '2025-07-01', asOf, g)
          const gs = summaryRow(db, itemId, asOf, g)
          expect(gr.closing).toEqual({ qtyMilli: gs.closingQtyMilli, value: gs.closingValue })
        }
      }
    }
    expect(rowsSeen).toBeGreaterThan(200)
  })

  it('also with derived (manufacture) costing installed', () => {
    const db = seededDb()
    const fx = seedStockFixture(db, { vouchers: 300, items: 8, seed: 99 })
    stock.setDerivedCostingSource(() => fx.mixedJournalIds.filter((_, i) => i % 2 === 0).map((voucherId) => ({ voucherId, additionalCostPaise: null })))
    try {
      for (const itemId of fx.itemIds) {
        const s = summaryRow(db, itemId, '2026-03-31')
        expect(stock.stockMovements(db, itemId, '2025-04-01', '2026-03-31').closing).toEqual({ qtyMilli: s.closingQtyMilli, value: s.closingValue })
        const g = fx.godownIds[0]!
        const gs = summaryRow(db, itemId, '2026-03-31', g)
        expect(stock.stockMovements(db, itemId, '2025-10-01', '2026-03-31', g).closing).toEqual({ qtyMilli: gs.closingQtyMilli, value: gs.closingValue })
      }
    } finally {
      stock.setDerivedCostingSource(null)
    }
  })

  it('opening is the position before `from`; binned / post-dated / optional vouchers never appear', () => {
    const b = books()
    const it = item(b.db, 'Widget', { opening: [10_000, 100_000] })
    trade(b, 'purchase', '2025-04-10', [{ item: it, qty: 10, amount: 120_000, dir: 'in' }])
    const sale = trade(b, 'sales', '2025-05-02', [{ item: it, qty: 4, amount: 80_000, dir: 'out' }])
    const binned = trade(b, 'sales', '2025-05-03', [{ item: it, qty: 1, amount: 20_000, dir: 'out' }])
    deleteVoucher(b.db, binned)
    saveVoucher(b.db, { ...header, voucherTypeId: typeId(b.db, 'stock_journal'), date: '2025-05-04', postDated: true, lines: [], inventory: [inv({ item: it, qty: 1, dir: 'out' })] })
    saveVoucher(b.db, { ...header, voucherTypeId: typeId(b.db, 'stock_journal'), date: '2025-05-05', isOptional: true, lines: [], inventory: [inv({ item: it, qty: 1, dir: 'out' })] })

    const reg = stock.stockMovements(b.db, it, '2025-05-01', '2025-05-31')
    expect(reg.opening).toEqual({ qtyMilli: 20_000, value: 220_000 })
    expect(reg.rows.map((r) => r.voucherId)).toEqual([sale])
    // Weighted average: 4 × 11,000 out.
    expect(reg.rows[0]).toMatchObject({ outwardQtyMilli: 4000, value: 44_000, runningQtyMilli: 16_000, runningValue: 176_000, particulars: 'Buyer' })
    expect(reg.closing).toEqual({ qtyMilli: 16_000, value: 176_000 })
  })
})

// ---------- godown transfer ----------

describe('godown transfer (stock journal transfer mode)', () => {
  for (const method of ['weighted_avg', 'fifo'] as const) {
    it(`${method}: priced via costAsOf, the transfer conserves the item's value and moves it between godowns`, () => {
      const b = books()
      const a = createGodown(b.db, { name: 'Main' }).id
      const annex = createGodown(b.db, { name: 'Annex' }).id
      const it = item(b.db, `Bolt ${method}`, { method })
      trade(b, 'purchase', '2025-05-01', [{ item: it, qty: 10, amount: 100_000, dir: 'in', godown: a }])
      trade(b, 'purchase', '2025-05-02', [{ item: it, qty: 5, amount: 65_000, dir: 'in', godown: a }])
      const before = summaryRow(b.db, it, '2025-05-31')

      const rows: TransferRowState[] = [{ itemId: it, fromGodownId: a, toGodownId: annex, qtyText: '12', batchId: null }]
      const state = { ...emptyTransferState('2025-05-10'), rows }
      const priced = stock.costAsOf(b.db, { date: '2025-05-10', lines: transferCostQuery(state) })
      const built = buildTransferPayload(state, { voucherTypeId: typeId(b.db, 'stock_journal'), costs: priced.consumption!.lines.map((l) => l.costPaise) })
      if (!built.ok) throw new Error(built.error)
      const id = saveVoucher(b.db, built.payload).id

      const after = summaryRow(b.db, it, '2025-05-31')
      expect(after.closingQtyMilli).toBe(before.closingQtyMilli)
      expect(after.closingValue).toBe(before.closingValue)
      const inA = summaryRow(b.db, it, '2025-05-31', a)
      const inAnnex = summaryRow(b.db, it, '2025-05-31', annex)
      expect(inA.closingQtyMilli).toBe(3000)
      expect(inAnnex.closingQtyMilli).toBe(12_000)
      expect(inA.closingValue + inAnnex.closingValue).toBe(before.closingValue)
      // FIFO: 10 @ 10,000 + 2 @ 13,000 left Main; weighted average: 12 × 11,000.
      expect(inAnnex.closingValue).toBe(method === 'fifo' ? 126_000 : 132_000)

      // The movement register shows both legs, value in = value out.
      const reg = stock.stockMovements(b.db, it, '2025-05-01', '2025-05-31')
      const legs = reg.rows.filter((r) => r.voucherId === id)
      expect(legs.map((r) => [r.godownName, r.inwardQtyMilli, r.outwardQtyMilli])).toEqual([['Main', 0, 12_000], ['Annex', 12_000, 0]])
      expect(legs[0]!.value).toBe(legs[1]!.value)
      expect(getVoucher(b.db, id)!.inventory.map((l) => l.amount)).toEqual([legs[0]!.value, legs[0]!.value])
    })
  }

  it('refuses incomplete rows: no godowns, same godown, zero quantity', () => {
    const base = { ...emptyTransferState('2025-05-10') }
    const vt = 1
    const r = (row: Partial<TransferRowState>) =>
      buildTransferPayload({ ...base, rows: [{ itemId: 5, fromGodownId: 1, toGodownId: 2, qtyText: '1', batchId: null, ...row }] }, { voucherTypeId: vt, costs: [100] })
    expect(r({ fromGodownId: null })).toEqual({ ok: false, error: expect.stringMatching(/both godowns/) })
    expect(r({ toGodownId: 1 })).toEqual({ ok: false, error: expect.stringMatching(/same/) })
    expect(r({ qtyText: '0' })).toEqual({ ok: false, error: expect.stringMatching(/positive quantity/) })
    expect(buildTransferPayload({ ...base, rows: [] }, { voucherTypeId: vt, costs: [] }).ok).toBe(false)
  })
})

// ---------- serial numbers ----------

describe('serial numbers', () => {
  const statuses = (db: DB, itemId: number) => listSerials(db, { stockItemId: itemId }).map((r) => `${r.serial}:${r.status}`)

  it('lifecycle: purchase → sale → bin releases → restore re-applies → credit-note return → resale', () => {
    const b = books()
    const phone = item(b.db, 'Phone', { serials: true })
    trade(b, 'purchase', '2025-05-01', [{ item: phone, qty: 3, amount: 300_000, dir: 'in', serials: ['P1', 'P2', 'P3'] }])
    expect(statuses(b.db, phone)).toEqual(['P1:in_stock', 'P2:in_stock', 'P3:in_stock'])

    const sale = trade(b, 'sales', '2025-05-05', [{ item: phone, qty: 1, amount: 150_000, dir: 'out', serials: ['P2'] }])
    expect(statuses(b.db, phone)).toEqual(['P1:in_stock', 'P2:sold', 'P3:in_stock'])
    expect(getVoucher(b.db, sale)!.inventory[0]!.serials).toEqual(['P2'])
    expect(availableSerials(b.db, phone)).toEqual(['P1', 'P3'])
    expect(availableSerials(b.db, phone, sale)).toEqual(['P1', 'P2', 'P3'])

    deleteVoucher(b.db, sale)
    expect(statuses(b.db, phone)).toContain('P2:in_stock')
    restoreVoucher(b.db, sale)
    expect(statuses(b.db, phone)).toContain('P2:sold')

    trade(b, 'credit_note', '2025-05-08', [{ item: phone, qty: 1, amount: 150_000, dir: 'in', serials: ['P2'] }])
    expect(statuses(b.db, phone)).toContain('P2:in_stock')
    trade(b, 'sales', '2025-05-09', [{ item: phone, qty: 1, amount: 150_000, dir: 'out', serials: ['P2'] }])
    expect(statuses(b.db, phone)).toContain('P2:sold')

    trade(b, 'debit_note', '2025-05-10', [{ item: phone, qty: 1, amount: 100_000, dir: 'out', serials: ['P3'] }])
    expect(statuses(b.db, phone)).toEqual(['P1:in_stock', 'P2:sold', 'P3:returned'])
  })

  it('rules: count = units, a serial is in stock once, outward needs it in stock — all roll back', () => {
    const b = books()
    const phone = item(b.db, 'Phone', { serials: true })
    expect(() => trade(b, 'purchase', '2025-05-01', [{ item: phone, qty: 2, amount: 2, dir: 'in', serials: ['A'] }])).toThrow(/2 units need 2 serial numbers \(got 1\)/)
    expect(() => trade(b, 'purchase', '2025-05-01', [{ item: phone, qty: 2, amount: 2, dir: 'in' }])).toThrow(/got 0/)
    trade(b, 'purchase', '2025-05-01', [{ item: phone, qty: 2, amount: 200, dir: 'in', serials: ['A', 'B'] }])
    expect(() => trade(b, 'purchase', '2025-05-02', [{ item: phone, qty: 1, amount: 100, dir: 'in', serials: ['A'] }])).toThrow(/serial A is already in stock/)
    expect(() => trade(b, 'sales', '2025-05-03', [{ item: phone, qty: 1, amount: 100, dir: 'out', serials: ['Z'] }])).toThrow(/serial Z is not in stock .* never came in/)
    // Dated before the purchase: not in stock on that date.
    expect(() => trade(b, 'sales', '2025-04-30', [{ item: phone, qty: 1, amount: 100, dir: 'out', serials: ['A'] }])).toThrow(/serial A is not in stock/)
    expect(() => trade(b, 'sales', '2025-05-03', [{ item: phone, qty: 2, amount: 100, dir: 'out', serials: ['A', 'A'] }])).toThrow(/appears twice/)
    // Nothing of the refused vouchers stuck.
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 1 })
    expect(statuses(b.db, phone)).toEqual(['A:in_stock', 'B:in_stock'])
  })

  it('binning a purchase whose serial was sold is refused; restoring a sale whose serial was resold is refused', () => {
    const b = books()
    const phone = item(b.db, 'Phone', { serials: true })
    const purchase = trade(b, 'purchase', '2025-05-01', [{ item: phone, qty: 1, amount: 100, dir: 'in', serials: ['S1'] }])
    const sale = trade(b, 'sales', '2025-05-02', [{ item: phone, qty: 1, amount: 100, dir: 'out', serials: ['S1'] }])
    expect(() => deleteVoucher(b.db, purchase)).toThrow(/serial S1 is not in stock .* never came in/)
    expect(getVoucher(b.db, purchase)!.deletedAt).toBeNull()

    deleteVoucher(b.db, sale)
    trade(b, 'sales', '2025-05-03', [{ item: phone, qty: 1, amount: 100, dir: 'out', serials: ['S1'] }])
    expect(() => restoreVoucher(b.db, sale)).toThrow(/serial S1 is not in stock/)
    expect(getVoucher(b.db, sale)!.deletedAt).not.toBeNull()
  })

  it('editing a sale swaps its serials; a transfer keeps them in stock at the new godown; physical counts name none', () => {
    const b = books()
    const a = createGodown(b.db, { name: 'Main' }).id
    const annex = createGodown(b.db, { name: 'Annex' }).id
    const phone = item(b.db, 'Phone', { serials: true })
    trade(b, 'purchase', '2025-05-01', [{ item: phone, qty: 2, amount: 200, dir: 'in', godown: a, serials: ['X', 'Y'] }])
    const sale = trade(b, 'sales', '2025-05-02', [{ item: phone, qty: 1, amount: 100, dir: 'out', godown: a, serials: ['X'] }])
    trade(b, 'sales', '2025-05-02', [{ item: phone, qty: 1, amount: 100, dir: 'out', godown: a, serials: ['Y'] }], sale)
    expect(statuses(b.db, phone)).toEqual(['X:in_stock', 'Y:sold'])

    journal(b.db, '2025-05-03', [
      { item: phone, qty: 1, dir: 'out', godown: a, serials: ['X'] },
      { item: phone, qty: 1, dir: 'in', godown: annex, serials: ['X'] }
    ])
    expect(listSerials(b.db, { stockItemId: phone, status: 'in_stock' })).toEqual([expect.objectContaining({ serial: 'X', godownName: 'Annex' })])
    expect(() => journal(b.db, '2025-05-04', [{ item: phone, qty: 1, dir: 'in', serials: ['X'] }], 'physical_stock')).toThrow()
  })

  it('untracked items drop serials; switching tracking re-projects from the line serials', () => {
    const b = books()
    const plain = item(b.db, 'Cable')
    const id = trade(b, 'purchase', '2025-05-01', [{ item: plain, qty: 1, amount: 100, dir: 'in', serials: ['C1'] }])
    expect(getVoucher(b.db, id)!.inventory[0]!.serials).toEqual([])
    const phone = item(b.db, 'Phone', { serials: true })
    trade(b, 'purchase', '2025-05-01', [{ item: phone, qty: 1, amount: 100, dir: 'in', serials: ['Q1'] }])
    const current = listStockItems(b.db).find((i) => i.id === phone)!
    updateStockItem(b.db, phone, { ...current, trackSerials: false })
    expect(listSerials(b.db, { stockItemId: phone })).toEqual([])
    updateStockItem(b.db, phone, { ...current, trackSerials: true })
    expect(statuses(b.db, phone)).toEqual(['Q1:in_stock'])
  })
})

// ---------- valuation method per item ----------

describe('valuation method switch', () => {
  it('weighted average ↔ FIFO changes the closing value exactly as each method prices it, from the next valuation', () => {
    const b = books()
    const it = item(b.db, 'Ink', { method: 'weighted_avg' })
    trade(b, 'purchase', '2025-05-01', [{ item: it, qty: 10, amount: 100_000, dir: 'in' }]) // 10 @ 10,000
    trade(b, 'purchase', '2025-05-02', [{ item: it, qty: 10, amount: 200_000, dir: 'in' }]) // 10 @ 20,000
    trade(b, 'sales', '2025-05-03', [{ item: it, qty: 15, amount: 1, dir: 'out' }])
    // Weighted average: 300,000 / 20 = 15,000 → 5 left = 75,000.
    expect(summaryRow(b.db, it, '2025-05-31').closingValue).toBe(75_000)
    const current = listStockItems(b.db).find((i) => i.id === it)!
    updateStockItem(b.db, it, { ...current, valuationMethod: 'fifo' })
    // FIFO: the 10 @ 10,000 and 5 of the 20,000 lot go out → 5 @ 20,000 = 100,000 left.
    expect(summaryRow(b.db, it, '2025-05-31').closingValue).toBe(100_000)
    expect(stock.stockMovements(b.db, it, '2025-05-01', '2025-05-31').rows.at(-1)!.value).toBe(200_000)
    updateStockItem(b.db, it, { ...current, valuationMethod: 'weighted_avg' })
    expect(summaryRow(b.db, it, '2025-05-31').closingValue).toBe(75_000)
  })
})

// ---------- reports ----------

describe('reorder planning, expiry report, labels', () => {
  it('lists items below their reorder level with the average monthly consumption and max(0, 2R − closing)', () => {
    const b = books()
    const low = item(b.db, 'Low', { reorder: 10_000 })
    const fine = item(b.db, 'Fine', { reorder: 2_000 })
    item(b.db, 'No level')
    trade(b, 'purchase', '2025-04-01', [{ item: low, qty: 40, amount: 4000, dir: 'in' }, { item: fine, qty: 40, amount: 4000, dir: 'in' }])
    trade(b, 'sales', '2025-04-20', [{ item: low, qty: 36, amount: 3600, dir: 'out' }])
    const rows = stock.reorderPlan(b.db, '2025-04-01', '2025-05-30') // 60 days
    expect(rows).toEqual([
      expect.objectContaining({ name: 'Low', closingQtyMilli: 4000, consumedMilli: 36_000, avgMonthlyMilli: 18_000, below: true, suggestedMilli: 16_000 })
    ])
    expect(stock.reorderPlan(b.db, '2025-04-01', '2025-05-30', { onlyBelow: false }).map((r) => [r.name, r.suggestedMilli])).toEqual([
      ['Fine', 0],
      ['Low', 16_000]
    ])
  })

  it('expiry report: batches with stock, expired or expiring within N days, soonest first', () => {
    const b = books()
    const med = item(b.db, 'Syrup')
    const soon = createBatch(b.db, { stockItemId: med, name: 'SOON', mfgDate: null, expiryDate: '2025-06-10' })
    const later = createBatch(b.db, { stockItemId: med, name: 'LATER', mfgDate: null, expiryDate: '2025-12-31' })
    const gone = createBatch(b.db, { stockItemId: med, name: 'GONE', mfgDate: null, expiryDate: '2025-05-01' })
    trade(b, 'purchase', '2025-04-01', [
      { item: med, qty: 5, amount: 500, dir: 'in', batch: soon.id },
      { item: med, qty: 5, amount: 500, dir: 'in', batch: later.id },
      { item: med, qty: 5, amount: 500, dir: 'in', batch: gone.id }
    ])
    const rows = stock.expiryReport(b.db, '2025-06-01', 30)
    expect(rows.map((r) => [r.batchName, r.daysToExpiry])).toEqual([['GONE', -31], ['SOON', 9]])
  })

  it('label sheet: copies × items, Code-128 SVG from the barcode, price from the first price list', () => {
    const b = books()
    const w = item(b.db, 'Widget', { barcode: 'W-0042' })
    const n = item(b.db, 'Nameless')
    const level = savePriceLevel(b.db, { name: 'Retail' })
    saveRate(b.db, { priceLevelId: level.id, stockItemId: w, rate: 12_500, effectiveFrom: '2025-04-01' })
    const html = stock.labelsHtml(b.db, { items: [{ itemId: w, copies: 3 }, { itemId: n, copies: 1 }], date: '2025-05-01' })
    expect(html.match(/class="label"/g)).toHaveLength(4)
    expect(html.match(/<svg /g)).toHaveLength(3)
    expect(html).toContain('W-0042')
    expect(html).toContain('125.00')
    expect(stock.labelsHtml(b.db, { items: [{ itemId: w, copies: 1 }], priceLevelId: null, date: '2025-05-01' })).not.toContain('125.00')
  })
})

// ---------- migration 021 ----------

describe('migration 021 (serial numbers)', () => {
  const at = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE serial_numbers'))

  it('is migration 021', () => {
    expect(at + 1).toBe(21)
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(21)
  })

  it('applies on a populated pre-021 fixture: columns added, data and stock figures unchanged', () => {
    expect(at).toBe(20)
    const db = freshPartialDb(at)
    seedCompany(db, { ...TEST_INFO, booksFrom: 2025 })
    const fx = seedStockFixture(db, { vouchers: 300, items: 8, seed: 21 })
    const before = stock.stockSummary(db, '2026-03-31')
    const lines = (db.prepare('SELECT COUNT(*) AS n FROM inventory_lines').get() as { n: number }).n
    migrate(db)
    expect(lines).toBe(fx.inventoryLines)
    const itemCols = (db.prepare('PRAGMA table_info(stock_items)').all() as { name: string; dflt_value: string | null }[])
    expect(itemCols.find((c) => c.name === 'track_serials')?.dflt_value).toBe('0')
    expect((db.prepare('PRAGMA table_info(inventory_lines)').all() as { name: string }[]).map((c) => c.name)).toContain('serials')
    expect(db.prepare('SELECT COUNT(*) AS n FROM serial_numbers').get()).toEqual({ n: 0 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM inventory_lines WHERE serials IS NOT NULL').get() as { n: number }).n).toBe(0)
    expect(stock.stockSummary(db, '2026-03-31')).toEqual(before)
    // The CHECK and UNIQUE constraints hold.
    const line = db.prepare('SELECT id, stock_item_id FROM inventory_lines LIMIT 1').get() as { id: number; stock_item_id: number }
    db.prepare("INSERT INTO serial_numbers (stock_item_id, serial, status, inward_line_id) VALUES (?, 'S', 'in_stock', ?)").run(line.stock_item_id, line.id)
    expect(() => db.prepare("INSERT INTO serial_numbers (stock_item_id, serial, status, inward_line_id) VALUES (?, 'S', 'in_stock', ?)").run(line.stock_item_id, line.id)).toThrow(/UNIQUE/)
    expect(() => db.prepare("INSERT INTO serial_numbers (stock_item_id, serial, status, inward_line_id) VALUES (?, 'T', 'lost', ?)").run(line.stock_item_id, line.id)).toThrow(/CHECK/)
  })
})
