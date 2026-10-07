// WP 2.5a valuation (design §3): GRN re-pricing by the bill, the lock freeze, return costing.
import { describe, it, expect } from 'vitest'
import type { DB } from '../db/connection'
import * as stock from './stockAnalysis'
import { deleteVoucher, restoreVoucher, setLockDate } from './vouchers'
import { postSimpleVoucher } from '../db/testdb'
import { dc, grn, item, resave, trade, tradeBooks, uid } from './tradeFixture.testutil'

const value = (db: DB, itemId: number, asOn = '2026-03-31'): number =>
  stock.stockSummary(db, asOn).find((r) => r.stockItemId === itemId)!.closingValue
const qty = (db: DB, itemId: number, asOn = '2026-03-31'): number =>
  stock.stockSummary(db, asOn).find((r) => r.stockItemId === itemId)!.closingQtyMilli
const reprices = (db: DB): number[] => (db.prepare('SELECT reprices FROM line_links ORDER BY id').all() as { reprices: number }[]).map((r) => r.reprices)

describe('GRN re-pricing', () => {
  it('a bill re-prices its GRN: billed share at the bill, the rest at the GRN rate', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const g = grn(b, '2025-05-01', [{ item: a, qty: 10, amount: 100000 }])
    expect(value(b.db, a)).toBe(100000)
    const bill = trade(b, 'purchase', '2025-05-05', [{ item: a, qty: 6, amount: 66000, from: uid(b.db, g.id) }])
    expect(reprices(b.db)).toEqual([1])
    expect(bill.inventory[0]!.movesStock).toBe(false)
    expect(qty(b.db, a)).toBe(10000)
    expect(value(b.db, a)).toBe(106000) // 660 + (1000 − 600)
    // A second bill for the rest: fully billed = Σ billed amounts.
    trade(b, 'purchase', '2025-05-06', [{ item: a, qty: 4, amount: 46000, from: uid(b.db, g.id) }])
    expect(value(b.db, a)).toBe(112000)
  })

  it('bill dated before the GRN: allowed with a warning; re-pricing is positional at the GRN', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const g = grn(b, '2025-05-10', [{ item: a, qty: 10, amount: 100000 }])
    const bill = trade(b, 'purchase', '2025-05-02', [{ item: a, qty: 10, amount: 120000, from: uid(b.db, g.id) }])
    expect(bill.warnings.linkDates).toHaveLength(1)
    expect(value(b.db, a, '2025-05-05')).toBe(0)
    expect(value(b.db, a, '2025-05-10')).toBe(120000)
  })

  it('consumption between GRN and bill is re-costed at the billed price (weighted average and FIFO)', () => {
    for (const method of ['weighted_avg', 'fifo'] as const) {
      const b = tradeBooks()
      const a = item(b.db, 'Widget', { method, opening: [10, 50000] }) // opening @ ₹50
      const g = grn(b, '2025-05-01', [{ item: a, qty: 10, amount: 100000 }]) // GRN @ ₹100
      trade(b, 'sales', '2025-05-03', [{ item: a, qty: 15, amount: 300000 }])
      const cogsBefore = stock.periodConsumption(b.db, '2025-04-01', '2026-03-31').get(a)!.consumedValue
      trade(b, 'purchase', '2025-05-20', [{ item: a, qty: 10, amount: 130000, from: uid(b.db, g.id) }]) // billed @ ₹130
      const cogsAfter = stock.periodConsumption(b.db, '2025-04-01', '2026-03-31').get(a)!.consumedValue
      if (method === 'fifo') {
        expect(cogsBefore).toBe(50000 + 50000)
        expect(cogsAfter).toBe(50000 + 65000)
        expect(value(b.db, a)).toBe(65000)
      } else {
        expect(cogsBefore).toBe(112500) // 15 × (150000 / 20)
        expect(cogsAfter).toBe(135000) // 15 × (180000 / 20)
        expect(value(b.db, a)).toBe(45000)
      }
      // Value conservation and checkpoint equality hold with the re-priced GRN.
      for (const d of ['2025-05-01', '2025-05-03', '2025-05-20']) {
        expect(stock.stockValuesAt(b.db, [d]).get(d)).toBe(stock.stockValue(b.db, d))
      }
    }
  })

  it('a binned bill reverts its share; restoring brings it back; the GRN shows unbilled again', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const g = grn(b, '2025-05-01', [{ item: a, qty: 10, amount: 100000 }])
    const bill = trade(b, 'purchase', '2025-05-05', [{ item: a, qty: 10, amount: 110000, from: uid(b.db, g.id) }])
    expect(value(b.db, a)).toBe(110000)
    expect(() => deleteVoucher(b.db, g.id)).toThrow(/bin that first/)
    deleteVoucher(b.db, bill.id)
    expect(value(b.db, a)).toBe(100000)
    expect(stock.stockSummary(b.db, '2026-03-31', { godownId: undefined }).find((r) => r.stockItemId === a)!.closingQtyMilli).toBe(10000)
    restoreVoucher(b.db, bill.id)
    expect(value(b.db, a)).toBe(110000)
  })

  it('GRN alteration after billing: a rate change moves only the unbilled share; qty below billed is refused', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const g = grn(b, '2025-05-01', [{ item: a, qty: 10, amount: 100000 }])
    trade(b, 'purchase', '2025-05-05', [{ item: a, qty: 6, amount: 66000, from: uid(b.db, g.id) }])
    resave(b.db, g.id, (p) => ({ ...p, inventory: [{ ...p.inventory![0]!, ratePaise: 12000, amount: 120000 }] }))
    expect(value(b.db, a)).toBe(66000 + 120000 - 72000) // unbilled 4 @ ₹120
    expect(() => resave(b.db, g.id, (p) => ({ ...p, inventory: [{ ...p.inventory![0]!, qtyMilli: 5000 }] }))).toThrow(/linked to Purchase 1/)
  })

  it('the godown view and the movement register take the re-priced value', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const g = grn(b, '2025-05-01', [{ item: a, qty: 10, amount: 100000, godown: b.godown }])
    trade(b, 'purchase', '2025-05-05', [{ item: a, qty: 10, amount: 125000, godown: b.godown, from: uid(b.db, g.id) }])
    expect(stock.stockSummary(b.db, '2026-03-31', { godownId: b.godown }).find((r) => r.stockItemId === a)!.closingValue).toBe(125000)
    const reg = stock.stockMovements(b.db, a, '2025-04-01', '2026-03-31')
    expect(reg.rows.map((r) => [r.kind, r.value])).toEqual([['receipt_note', 125000]])
    expect(reg.closing.value).toBe(125000)
  })
})

describe('locked periods (§3.4)', () => {
  it('a bill against a GRN inside the lock is frozen (reprices = 0) with a note', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const g = grn(b, '2025-05-01', [{ item: a, qty: 10, amount: 100000 }])
    setLockDate(b.db, '2025-05-31')
    const bill = trade(b, 'purchase', '2025-06-05', [{ item: a, qty: 10, amount: 110000, from: uid(b.db, g.id) }])
    expect(reprices(b.db)).toEqual([0])
    expect(bill.warnings.frozenRepricing).toEqual([expect.stringMatching(/not loaded into stock/)])
    expect(value(b.db, a)).toBe(100000)
    // Unlocking later doesn't flip it: reprices is an entry fact.
    setLockDate(b.db, null)
    resave(b.db, bill.id, (p) => ({ ...p, narration: 'altered after unlock' }))
    expect(reprices(b.db)).toEqual([0])
  })

  it('a GRN in a year closed by a live year-end journal is frozen too', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const g = grn(b, '2025-05-01', [{ item: a, qty: 10, amount: 100000 }])
    const close = postSimpleVoucher(b.db, { date: '2026-03-31', amount: 100, kind: 'journal' })
    b.db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(close.id)
    trade(b, 'purchase', '2026-04-05', [{ item: a, qty: 10, amount: 110000, from: uid(b.db, g.id) }])
    expect(reprices(b.db)).toEqual([0])
  })

  it('once its GRN is locked, a re-pricing bill can only be altered without moving qty / amount, and not binned', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const g = grn(b, '2025-05-01', [{ item: a, qty: 10, amount: 100000 }])
    const bill = trade(b, 'purchase', '2025-06-05', [{ item: a, qty: 10, amount: 110000, from: uid(b.db, g.id) }])
    expect(reprices(b.db)).toEqual([1])
    setLockDate(b.db, '2025-05-31')
    const locked = value(b.db, a, '2025-05-31')
    expect(() => resave(b.db, bill.id, (p) => ({
      ...p,
      lines: p.lines.map((l) => ({ ...l, amount: 120000 })),
      inventory: [{ ...p.inventory![0]!, amount: 120000, ratePaise: 12000 }]
    }))).toThrow(/locked period or closed year/)
    expect(() => resave(b.db, bill.id, (p) => ({ ...p, inventory: [{ ...p.inventory![0]!, source: null }] }))).toThrow(/locked period/)
    expect(() => deleteVoucher(b.db, bill.id)).toThrow(/can't be moved to the bin/)
    resave(b.db, bill.id, (p) => ({ ...p, narration: 'harmless' }))
    expect(reprices(b.db)).toEqual([1])
    expect(value(b.db, a, '2025-05-31')).toBe(locked)
  })
})

describe('return costing (§3.4)', () => {
  it('a credit note linked to an invoice line brings goods back at the cost they left at', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [10, 100000] }) // @ ₹100
    const s = trade(b, 'sales', '2025-05-01', [{ item: a, qty: 4, amount: 60000 }])
    trade(b, 'purchase', '2025-05-02', [{ item: a, qty: 10, amount: 200000 }]) // avg moves up
    // The credit note's stored amount is the SALE value (₹150/unit); it re-enters at cost (₹100).
    trade(b, 'credit_note', '2025-05-10', [{ item: a, qty: 2, amount: 30000, from: uid(b.db, s.id), link: 'return' }])
    const reg = stock.stockMovements(b.db, a, '2025-04-01', '2026-03-31')
    expect(reg.rows.find((r) => r.kind === 'credit_note')!.value).toBe(20000)
  })

  it('a credit note against a challan-backed invoice returns at the challan cost', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [10, 100000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 4, amount: 48000 }])
    const inv = trade(b, 'sales', '2025-05-03', [{ item: a, qty: 4, amount: 60000, from: uid(b.db, d.id) }])
    trade(b, 'purchase', '2025-05-04', [{ item: a, qty: 10, amount: 300000 }])
    trade(b, 'credit_note', '2025-05-10', [{ item: a, qty: 1, amount: 15000, from: uid(b.db, inv.id), link: 'return' }])
    const reg = stock.stockMovements(b.db, a, '2025-04-01', '2026-03-31')
    expect(reg.rows.map((r) => [r.kind, r.value])).toEqual([['delivery_note', 40000], ['purchase', 300000], ['credit_note', 10000]])
  })

  it('a rejection GRN against a challan line returns at the challan cost', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [10, 100000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 4, amount: 48000 }])
    grn(b, '2025-05-08', [{ item: a, qty: 1, amount: 0, from: uid(b.db, d.id), link: 'return' }], { party: b.buyer, purpose: 'return' })
    expect(qty(b.db, a)).toBe(7000)
    expect(value(b.db, a)).toBe(70000)
  })

  it('unlinked credit notes are valued exactly as before (stored amount)', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [10, 100000] })
    trade(b, 'sales', '2025-05-01', [{ item: a, qty: 4, amount: 60000 }])
    trade(b, 'credit_note', '2025-05-10', [{ item: a, qty: 2, amount: 30000 }])
    expect(value(b.db, a)).toBe(60000 + 30000)
  })
})
