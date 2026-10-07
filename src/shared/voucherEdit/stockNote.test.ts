import { describe, it, expect } from 'vitest'
import {
  addFromFor, addFromIsAllowed, buildStockNotePayload, computeStockNote, documentNumberWarning, emptyStockNoteState,
  rowsFromSourcePicks, sourceLocksGoods, type StockNoteContext
} from '.'
import type { OpenSourceLine } from '../tradeCycle/types'

const ctx = (kind: 'delivery_note' | 'receipt_note'): StockNoteContext => ({
  kind, companyStateCode: '27',
  items: new Map([[1, { gstRate: 18, cessRate: null }]]),
  ledgers: new Map([[7, { stateCode: '27' }], [8, { stateCode: '29' }]])
})

describe('stock-note mode (WP 2.5b)', () => {
  it('builds a challan: no ledger lines, goods out, purpose, transport fields; an empty rate is a zero value', () => {
    const s = {
      ...emptyStockNoteState('delivery_note', '2025-05-01'), partyId: 7, vehicleNo: ' mh01ab1 ', distanceKm: '12.4',
      rows: [
        { itemId: 1, qtyText: '2', rate: 10000, discount: 500, godownId: 3, batchId: null },
        { itemId: 1, qtyText: '1', rate: null, discount: null, godownId: null, batchId: null },
        { itemId: null, qtyText: '', rate: null, discount: null, godownId: null, batchId: null }
      ]
    }
    const r = buildStockNotePayload(s, ctx('delivery_note'), 5)
    if (!r.ok) throw new Error(r.error)
    expect(r.payload.lines).toEqual([])
    expect(r.payload.trade).toEqual({ purpose: 'supply' })
    expect(r.payload.vehicleNo).toBe('MH01AB1')
    expect(r.payload.transportDistanceKm).toBe(12)
    expect(r.payload.inventory.map((l) => [l.direction, l.amount, l.discountPaise])).toEqual([['out', 19500, 500], ['out', 0, 0]])
  })

  it('shows tax only for a supply; inter-state is IGST', () => {
    const base = { ...emptyStockNoteState('delivery_note', '2025-05-01'), partyId: 8, rows: [{ itemId: 1, qtyText: '1', rate: 100000, discount: null, godownId: null, batchId: null }] }
    expect(computeStockNote(base, ctx('delivery_note')).gst).toMatchObject({ taxable: 100000, igst: 18000, total: 118000 })
    expect(computeStockNote({ ...base, purpose: 'job_work' }, ctx('delivery_note')).gst).toMatchObject({ taxable: 100000, igst: 0, total: 100000 })
  })

  it('a GRN takes goods in and defaults to purpose purchase', () => {
    const r = buildStockNotePayload(
      { ...emptyStockNoteState('receipt_note', '2025-05-01'), partyId: 7, rows: [{ itemId: 1, qtyText: '1', rate: 1, discount: null, godownId: null, batchId: null }] },
      ctx('receipt_note'), 6
    )
    expect(r.ok && [r.payload.inventory[0]!.direction, r.payload.trade]).toEqual(['in', { purpose: 'purchase' }])
    expect(buildStockNotePayload(emptyStockNoteState('receipt_note', '2025-05-01'), ctx('receipt_note'), 6).ok).toBe(false)
  })

  it('warns past 16 characters', () => {
    expect(documentNumberWarning('DC/25-26/0000001')).toBeNull()
    expect(documentNumberWarning('DC/2025-26/000001')).toMatch(/17 characters/)
  })
})

describe('"Add from…" rows (WP 2.5b)', () => {
  const line: OpenSourceLine = {
    lineUid: 'a'.repeat(32), voucherId: 3, tradeDocId: null, kind: 'delivery_note', label: 'Delivery Note 1 line 1', date: '2025-05-01',
    stockItemId: 1, godownId: 4, batchId: 9, serials: ['S1', 'S2', 'S3'], qtyMilli: 3000, doneMilli: 0, pendingMilli: 3000,
    ratePaise: 10000, amount: 27000
  }
  it('carries item, godown, batch, the first serials, the rate and a pro-rata discount, capped at pending', () => {
    const [r] = rowsFromSourcePicks([{ line, qtyMilli: 2000 }], { linkType: 'fulfil' })
    expect(r).toEqual({
      itemId: 1, qtyText: '2', rate: 10000, discount: 2000, godownId: 4, batchId: 9, serials: ['S1', 'S2'],
      source: { lineUid: 'a'.repeat(32), linkType: 'fulfil' }
    })
    expect(rowsFromSourcePicks([{ line, qtyMilli: 9000 }], { linkType: 'fulfil' })[0]!.qtyText).toBe('3')
    expect(rowsFromSourcePicks([{ line, qtyMilli: 1000 }], { linkType: 'fulfil', fxRate: 80 })[0]!.rate).toBe(125)
  })
  it('names an allowed pair for every trading kind; challan / GRN rows lock their goods, returns do not', () => {
    for (const k of ['sales', 'purchase', 'credit_note', 'debit_note', 'delivery_note', 'receipt_note'] as const) expect(addFromIsAllowed(k)).toBe(true)
    expect(addFromFor('journal')).toBeNull()
    expect(sourceLocksGoods('delivery_note', 'sales', 'fulfil')).toBe(true)
    expect(sourceLocksGoods('receipt_note', 'purchase', 'fulfil')).toBe(true)
    expect(sourceLocksGoods('sales', 'credit_note', 'return')).toBe(false)
  })
})
