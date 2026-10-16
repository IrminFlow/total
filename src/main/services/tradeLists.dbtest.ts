// WP 2.5b lists: trade:noteList — the challan / GRN list screens. Pending quantity and value per
// note equal the pending reports (pendingStockNotes) and so GRNI / GDNI, to the paisa; the status
// follows partial / full invoicing, returns, short-closing and binning; filters and the as-on date.
import { describe, it, expect } from 'vitest'
import type { NoteListFilter, StockNoteListRow } from '@shared/tradeCycle/types'
import { createStockItem, createUnit } from './masters'
import { deleteVoucher } from './vouchers'
import { listStockNotes } from './tradeLists'
import { pendingStockNotes } from './tradeReports'
import { unbilledGoods } from './tradeAnalysis'
import { closeStockNote } from './tradeClosure'
import { dc, grn, item, trade, tradeBooks, uid, type TradeBooks } from './tradeFixture.testutil'

const FROM = '2025-04-01'
const TO = '2026-03-31'

interface Books extends TradeBooks {
  w: number
  g: number
}

function books(): Books {
  const b = tradeBooks()
  const w = item(b.db, 'Widget', { opening: [100, 1_000_000] }) // 100 @ ₹100
  const g = item(b.db, 'Gadget', { opening: [50, 500_000], gstRate: 5 })
  return { ...b, w, g }
}

const list = (b: Books, stage: 'delivery_note' | 'receipt_note', filter: NoteListFilter = 'all', asOn = TO): StockNoteListRow[] =>
  listStockNotes(b.db, { stage, from: FROM, to: TO, asOn, filter })
const rowOf = (rows: StockNoteListRow[], id: number): StockNoteListRow | undefined => rows.find((r) => r.voucherId === id)

/** Every note's pending quantity / value / lines must be the pending report's for that note. */
function expectEqualsPendingReport(b: Books, stage: 'delivery_note' | 'receipt_note', asOn = TO): void {
  const report = pendingStockNotes(b.db, stage, asOn)
  const rows = listStockNotes(b.db, { stage, from: '2000-01-01', to: asOn, asOn, filter: 'all' })
  for (const r of rows) {
    const lines = report.filter((x) => x.voucherId === r.voucherId)
    expect(r.pendingLines).toBe(lines.length)
    expect(r.pendingValue).toBe(lines.reduce((s, x) => s + x.pendingValue, 0))
    if (r.pendingMilli != null) expect(r.pendingMilli).toBe(lines.reduce((s, x) => s + x.pendingMilli, 0))
  }
  // And nothing pending in the report is missing from the list.
  for (const x of report) expect(rowOf(rows, x.voucherId)).toBeDefined()
}

describe('challan list (trade:noteList)', () => {
  it('pending = the pending report and GDNI to the paisa; status after partial / full invoice, close and bin', () => {
    const b = books()
    // DC-A: 10 widgets @ ₹123.45 (an odd amount so the pro-rata rounding is exercised), 7 gadgets.
    const a = dc(b, '2025-05-01', [{ item: b.w, qty: 10, amount: 123_450 }, { item: b.g, qty: 7, amount: 70_001 }])
    const full = dc(b, '2025-05-02', [{ item: b.w, qty: 4, amount: 40_000 }], { purpose: 'approval' })
    const closed = dc(b, '2025-05-03', [{ item: b.w, qty: 5, amount: 50_000 }])
    const job = dc(b, '2025-05-04', [{ item: b.w, qty: 2, amount: 0 }], { purpose: 'job_work' })
    const other = dc(b, '2025-05-05', [{ item: b.w, qty: 3, amount: 30_000 }], { party: b.buyer2 })

    // Partial: 3 widgets of DC-A invoiced (and 1 more returned on a rejection GRN — shared capacity).
    const inv = trade(b, 'sales', '2025-05-10', [{ item: b.w, qty: 3, amount: 37_035, from: uid(b.db, a.id, 0) }])
    grn(b, '2025-05-11', [{ item: b.w, qty: 1, amount: 12_345, from: uid(b.db, a.id, 0), link: 'return' }], { party: b.buyer, purpose: 'return' })
    // Full: the approval challan.
    const inv2 = trade(b, 'sales', '2025-05-12', [{ item: b.w, qty: 4, amount: 40_000, from: uid(b.db, full.id) }])
    // Short-close after 2 of 5.
    trade(b, 'sales', '2025-05-13', [{ item: b.w, qty: 2, amount: 20_000, from: uid(b.db, closed.id) }])
    closeStockNote(b.db, closed.id, 'Rest kept as samples')

    const rows = list(b, 'delivery_note')
    const ra = rowOf(rows, a.id)!
    expect(ra).toMatchObject({ status: 'partly', lineCount: 2, items: 'Widget, Gadget', pendingLines: 2, convertible: true, partyLedgerId: b.buyer })
    expect(ra.qtyMilli).toBe(17_000)
    expect(ra.pendingMilli).toBe(13_000) // 6 widgets + 7 gadgets
    // 123 450 × 6 / 10 = 74 070, plus the untouched gadget line 70 001.
    expect(ra.pendingValue).toBe(74_070 + 70_001)
    expect(ra.value).toBe(193_451)
    expect(ra.targets.map((t) => [t.voucherId, t.kind, t.linkType])).toEqual([
      [inv.id, 'sales', 'fulfil'], [expect.any(Number), 'receipt_note', 'return']
    ])
    expect(rowOf(rows, full.id)).toMatchObject({ status: 'done', pendingMilli: 0, pendingValue: 0, convertible: false, purpose: 'approval' })
    expect(rowOf(rows, full.id)!.targets.map((t) => t.voucherId)).toEqual([inv2.id])
    expect(rowOf(rows, closed.id)).toMatchObject({ status: 'closed', pendingMilli: 0, pendingValue: 0, convertible: false, closeReason: 'Rest kept as samples' })
    // A job-work challan is listed with its pending quantity but is not a supply to invoice.
    expect(rowOf(rows, job.id)).toMatchObject({ status: 'pending', pendingMilli: 2000, convertible: false, purpose: 'job_work' })
    expect(rowOf(rows, other.id)).toMatchObject({ status: 'pending', partyLedgerId: b.buyer2, convertible: true })

    expectEqualsPendingReport(b, 'delivery_note')
    // GDNI (supply / approval) = the convertible notes' pending value.
    const gdni = unbilledGoods(b.db, TO).gdni
    const supply = rows.filter((r) => r.purpose === 'supply' || r.purpose === 'approval')
    expect(gdni.value).toBe(supply.reduce((s, r) => s + r.pendingValue, 0))
    expect(gdni.notes).toBe(supply.filter((r) => r.pendingLines > 0).length)

    // Filters: pending = still to invoice; closed = invoiced or short-closed; all = both.
    expect(list(b, 'delivery_note', 'pending').map((r) => r.voucherId)).toEqual([a.id, job.id, other.id])
    expect(list(b, 'delivery_note', 'closed').map((r) => r.voucherId)).toEqual([full.id, closed.id])
    expect(list(b, 'delivery_note', 'all')).toHaveLength(5)

    // Binning the full invoice re-opens its challan; the list follows the live links.
    deleteVoucher(b.db, inv2.id)
    expect(rowOf(list(b, 'delivery_note'), full.id)).toMatchObject({ status: 'pending', pendingMilli: 4000, pendingValue: 40_000, targets: [] })
    expectEqualsPendingReport(b, 'delivery_note')
  })

  it('reads as on a date: invoices after it do not count; pending lists older notes, the period only for closed / all', () => {
    const b = books()
    const a = dc(b, '2025-05-01', [{ item: b.w, qty: 10, amount: 100_000 }])
    trade(b, 'sales', '2025-06-15', [{ item: b.w, qty: 10, amount: 100_000, from: uid(b.db, a.id) }])
    const before = listStockNotes(b.db, { stage: 'delivery_note', from: '2025-06-01', to: '2025-06-10', filter: 'pending' })
    expect(before.map((r) => [r.voucherId, r.status, r.pendingMilli, r.targets.length])).toEqual([[a.id, 'pending', 10_000, 0]])
    expectEqualsPendingReport(b, 'delivery_note', '2025-06-10')
    // The challan is dated before this period: not in "all" for June, but pending above.
    expect(listStockNotes(b.db, { stage: 'delivery_note', from: '2025-06-01', to: '2025-06-10', filter: 'all' })).toEqual([])
    expect(rowOf(list(b, 'delivery_note'), a.id)).toMatchObject({ status: 'done' })
    expect(list(b, 'delivery_note', 'pending')).toEqual([])
  })

  it('GRN list = the pending report and GRNI; optional and binned notes are not listed; mixed units', () => {
    const b = books()
    const kg = createUnit(b.db, { name: 'Kilogram', symbol: 'kg', decimals: 3, uqc: 'KGS' })
    const rice = createStockItem(b.db, {
      name: 'Rice', groupId: null, unitId: kg.id, hsn: '1006', gstRate: 5, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null,
      reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false
    }).id
    const g1 = grn(b, '2025-07-01', [{ item: b.w, qty: 8, amount: 80_000 }, { item: rice, qty: 25, amount: 125_000 }])
    const g2 = grn(b, '2025-07-02', [{ item: b.g, qty: 6, amount: 60_000 }])
    grn(b, '2025-07-03', [{ item: b.g, qty: 1, amount: 10_000 }], { optional: true })
    const binned = grn(b, '2025-07-04', [{ item: b.g, qty: 1, amount: 10_000 }])
    deleteVoucher(b.db, binned.id)
    trade(b, 'purchase', '2025-07-10', [{ item: b.w, qty: 5, amount: 50_000, from: uid(b.db, g1.id, 0) }])

    const rows = list(b, 'receipt_note')
    expect(rows.map((r) => r.voucherId)).toEqual([g1.id, g2.id])
    expect(rowOf(rows, g1.id)).toMatchObject({ status: 'partly', qtyMilli: null, pendingMilli: null, unit: null, pendingLines: 2, pendingValue: 30_000 + 125_000 })
    expect(rowOf(rows, g2.id)).toMatchObject({ status: 'pending', qtyMilli: 6000, pendingMilli: 6000, decimals: 0, convertible: true })
    expectEqualsPendingReport(b, 'receipt_note')
    expect(unbilledGoods(b.db, TO).grni.value).toBe(rows.reduce((s, r) => s + r.pendingValue, 0))
  })
})
