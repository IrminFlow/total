// WP 2.5c pure trade-doc form: totals come from the invoice computation, the payload is exact,
// a saved document round-trips through the form, and status labels per kind.
import { describe, expect, it } from 'vitest'
import { computeInvoice, emptyInvoiceState } from '../voucherEdit/invoice'
import {
  buildTradeDocPayload, computeTradeDoc, emptyTradeDocState, storedTradeDocTotals, tradeDocStateFromDoc, tradeDocStateFromDraft,
  tradeDocToPayload, tradeStatusLabel, type TradeDocContext
} from './edit'
import { linkRuleFor, sourceKindsFor } from './rules'
import type { TradeDoc } from './types'

const ctx: TradeDocContext = {
  kind: 'sales_order',
  companyStateCode: '27',
  items: new Map([[1, { gstRate: 18, cessRate: null }], [2, { gstRate: 5, cessRate: 1 }]]),
  ledgers: new Map([[10, { stateCode: '27' }], [11, { stateCode: '29' }]])
}

const rows = [
  { itemId: 1, qtyText: '3', rate: 33_333, discount: 1_000, godownId: null, batchId: null },
  { itemId: 2, qtyText: '1.5', rate: 10_000, discount: null, godownId: null, batchId: null }
]

describe('trade doc totals', () => {
  it('are exactly the invoice computation', () => {
    for (const partyId of [10, 11]) {
      const s = { ...emptyTradeDocState('sales_order', '2025-06-01'), partyId, rows }
      const inv = computeInvoice({ ...emptyInvoiceState('2025-06-01'), partyId, rows }, {
        kind: 'sales', companyStateCode: '27', items: ctx.items, ledgers: new Map([[partyId, { stateCode: ctx.ledgers.get(partyId)!.stateCode, gstRate: null }]])
      })
      const c = computeTradeDoc(s, ctx)
      expect(c.gst).toEqual(inv.gst)
      expect(c.rounded).toBe(inv.rounded)
      expect(c.supply).toBe(partyId === 10 ? 'intra' : 'inter')
    }
  })

  it('stored totals at the snapshot rate equal the form totals', () => {
    const s = { ...emptyTradeDocState('sales_order', '2025-06-01'), partyId: 11, rows }
    const c = computeTradeDoc(s, ctx)
    const stored = storedTradeDocTotals(
      c.detail.map((d) => ({ stockItemId: d.itemId, qtyMilli: d.qtyMilli, ratePaise: d.ratePaise, discountPaise: d.discountPaise, gstRate: d.rate, cessRate: d.cessRate })),
      { kind: 'sales_order', companyStateCode: '27', partyStateCode: '29', posOverride: null, date: '2025-06-01' }
    )
    expect(stored).toEqual({ taxable: c.gst.taxable, cgst: 0, sgst: 0, igst: c.gst.igst, cess: c.gst.cess, total: c.rounded, roundOff: c.roundDiff })
  })
})

describe('trade doc payload', () => {
  it('validates the form', () => {
    const s = emptyTradeDocState('quotation', '2025-06-01')
    expect(buildTradeDocPayload(s, { ...ctx, kind: 'quotation' }, 1)).toEqual({ ok: false, error: 'Pick the party first' })
    const noRate = { ...s, partyId: 10, rows: [{ ...rows[0]!, rate: null }] }
    expect(buildTradeDocPayload(noRate, { ...ctx, kind: 'quotation' }, 1)).toMatchObject({ ok: false, error: /rate/ })
    const early = { ...s, partyId: 10, rows, validUntil: '2025-05-01' }
    expect(buildTradeDocPayload(early, { ...ctx, kind: 'quotation' }, 1)).toMatchObject({ ok: false, error: /Valid until/ })
    const blank = { ...s, partyId: 10, rows: [{ itemId: null, qtyText: '', rate: null, discount: null, godownId: null, batchId: null }] }
    expect(buildTradeDocPayload(blank, { ...ctx, kind: 'quotation' }, 1)).toMatchObject({ ok: false })
  })

  it('round-trips a saved document', () => {
    const doc: TradeDoc = {
      id: 4, docTypeId: 2, kind: 'sales_order', typeName: 'Sales Order', number: 'SO-4', date: '2025-06-01', partyLedgerId: 10,
      partyName: 'Buyer', validUntil: null, dueDate: '2025-06-20', reference: 'PO 77', terms: 'Net 30', narration: null, posOverride: null,
      currencyCode: null, exchangeRate: null, manualStatus: 'open', status: 'open', closedAt: null, closeReason: null, deletedAt: null,
      lines: [
        {
          id: 1, lineUid: 'a'.repeat(32), stockItemId: 1, description: 'Blue', godownId: null, qtyMilli: 3000, ratePaise: 33_333,
          discountPaise: 1_000, amount: 98_999, gstRate: 18, cessRate: 0, dueDate: '2025-06-15',
          source: { lineUid: 'b'.repeat(32), linkType: 'fulfil' }, doneMilli: 0, pendingMilli: 3000
        }
      ],
      totals: { taxable: 98_999, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0, roundOff: 0 }, pendingValue: 0,
      downstream: [], upstream: [], createdAt: '', updatedAt: ''
    }
    const built = buildTradeDocPayload(tradeDocStateFromDoc(doc), ctx, 2)
    expect(built).toEqual({ ok: true, payload: tradeDocToPayload(doc) })
  })

  it('a converted draft keeps its sources', () => {
    const s = tradeDocStateFromDraft({
      kind: 'sales_order', partyLedgerId: 10, reference: null, terms: null, narration: null, posOverride: null,
      lines: [{ stockItemId: 1, description: null, godownId: null, qtyMilli: 2500, ratePaise: 1000, discountPaise: 0, dueDate: null, source: { lineUid: 'c'.repeat(32), linkType: 'fulfil' } }]
    }, '2025-06-02')
    const r = buildTradeDocPayload(s, ctx, 2)
    expect(r.ok && r.payload.lines[0]).toMatchObject({ qtyMilli: 2500, amount: 2500, source: { lineUid: 'c'.repeat(32) } })
  })
})

describe('trade kinds', () => {
  it('labels and the doc → doc pair', () => {
    expect(tradeStatusLabel('quotation', 'fulfilled')).toBe('Converted')
    expect(tradeStatusLabel('purchase_order', 'partly_fulfilled')).toBe('Partly received')
    expect(tradeStatusLabel('sales_order', 'closed')).toBe('Short-closed')
    // Quotation → sales order is the one doc → doc link; orders feed challans / GRNs / invoices / bills.
    expect(linkRuleFor('quotation', 'sales_order', 'fulfil')?.nonMoving).toBe(false)
    expect(linkRuleFor('quotation', 'purchase_order', 'fulfil')).toBeNull()
    expect(linkRuleFor('sales_order', 'sales_order', 'fulfil')).toBeNull()
    expect(sourceKindsFor('sales_order', 'fulfil')).toEqual(['quotation'])
    expect(sourceKindsFor('delivery_note', 'fulfil')).toEqual(['sales_order'])
    expect(sourceKindsFor('purchase', 'fulfil')).toEqual(['purchase_order', 'receipt_note'])
  })
})
