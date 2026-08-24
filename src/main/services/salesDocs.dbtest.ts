import { describe, it, expect } from 'vitest'
import { postSimpleVoucher, seededDb, TEST_INFO } from '../db/testdb'
import { createLedger, createStockItem, createUnit } from './masters'
import {
  closeDocument,
  convert,
  deleteDocument,
  getDocument,
  invoiceDraft,
  listDocuments,
  markInvoiced,
  nextNumber,
  pipeline,
  saveDocument
} from './salesDocs'

type Db = ReturnType<typeof seededDb>

/**
 * The chain: quotation → order → challan → invoice.
 *
 * The property that matters is that a document converts once. Everything else here — numbering,
 * partial fulfilment, expiry — is convenience; converting twice is a customer billed twice.
 */
const LEDGER_DEFAULTS = {
  openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

function books(): { db: Db; buyer: number; widget: number } {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const unit =
    (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined) ??
    createUnit(db, { name: 'Pieces', symbol: 'pcs', decimals: 3, uqc: 'PCS' })
  const widget = createStockItem(db, {
    name: 'Widget', groupId: null, unitId: unit.id, hsn: '8471', gstRate: 18, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
  } as never).id
  const buyer = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Kumar Stores', groupId: groupId('Sundry Debtors'), stateCode: '27' }).id
  return { db, buyer, widget }
}

const quote = (db: Db, buyer: number, widget: number, qtyMilli = 10_000): ReturnType<typeof saveDocument> =>
  saveDocument(db, TEST_INFO, {
    stage: 'quotation',
    date: '2026-04-01',
    partyLedgerId: buyer,
    validUntil: '2026-04-30',
    lines: [{ stockItemId: widget, description: 'Widget', qtyMilli, ratePaise: 10000 }]
  })

describe('writing a quotation', () => {
  it('numbers itself, and the next one follows', () => {
    const { db, buyer, widget } = books()
    expect(nextNumber(db, 'quotation')).toBe('QT-0001')
    const q = quote(db, buyer, widget)
    expect(q.number).toBe('QT-0001')
    expect(nextNumber(db, 'quotation')).toBe('QT-0002')
  })

  it('computes tax from the item’s own band without being told', () => {
    const { db, buyer, widget } = books()
    const q = quote(db, buyer, widget)
    expect(q.taxablePaise).toBe(1_00_000)
    expect(q.gst.cgst).toBe(9_000)
    expect(q.gst.sgst).toBe(9_000)
    expect(q.totalPaise).toBe(1_18_000)
  })

  it('can be addressed to somebody who is not a customer yet', () => {
    const { db, widget } = books()
    const q = saveDocument(db, TEST_INFO, {
      stage: 'quotation',
      date: '2026-04-01',
      partyName: 'A stranger who rang up',
      lines: [{ stockItemId: widget, description: 'Widget', qtyMilli: 1000, ratePaise: 10000 }]
    })
    expect(q.partyLedgerId).toBeNull()
    expect(q.partyName).toBe('A stranger who rang up')
  })

  it('but not to nobody at all, and not with no lines', () => {
    const { db, widget } = books()
    expect(() =>
      saveDocument(db, TEST_INFO, {
        stage: 'quotation', date: '2026-04-01',
        lines: [{ stockItemId: widget, description: 'Widget', qtyMilli: 1000, ratePaise: 10000 }]
      })
    ).toThrow('Who is this for')
    expect(() => saveDocument(db, TEST_INFO, { stage: 'quotation', date: '2026-04-01', partyName: 'X', lines: [] }))
      .toThrow('at least one line')
  })

  it('goes stale after its validity', () => {
    const { db, buyer, widget } = books()
    quote(db, buyer, widget)
    expect(listDocuments(db, TEST_INFO, { asOn: '2026-04-15' })[0]!.expired).toBe(false)
    expect(listDocuments(db, TEST_INFO, { asOn: '2026-05-15' })[0]!.expired).toBe(true)
  })
})

describe('converting', () => {
  it('turns a quotation into an order, and remembers both directions', () => {
    const { db, buyer, widget } = books()
    const q = quote(db, buyer, widget)
    const order = convert(db, q.id, TEST_INFO, { date: '2026-04-05' })
    expect(order.stage).toBe('order')
    expect(order.number).toBe('SO-0001')
    expect(order.fromDocumentId).toBe(q.id)
    expect(order.reference).toBe(q.number)
    expect(getDocument(db, q.id, TEST_INFO)!.convertedToId).toBe(order.id)
    expect(getDocument(db, q.id, TEST_INFO)!.status).toBe('converted')
  })

  it('refuses to convert the same quotation twice', () => {
    const { db, buyer, widget } = books()
    const q = quote(db, buyer, widget)
    convert(db, q.id, TEST_INFO)
    expect(() => convert(db, q.id, TEST_INFO)).toThrow('already been converted')
  })

  it('carries the values through unchanged', () => {
    const { db, buyer, widget } = books()
    const q = quote(db, buyer, widget)
    const order = convert(db, q.id, TEST_INFO)
    expect(order.totalPaise).toBe(q.totalPaise)
  })

  it('a part delivery leaves the order open with the rest still pending', () => {
    const { db, buyer, widget } = books()
    const q = quote(db, buyer, widget)
    const order = convert(db, q.id, TEST_INFO)
    const challan = convert(db, order.id, TEST_INFO, { quantities: [{ lineId: order.lines[0]!.id, qtyMilli: 4_000 }] })
    expect(challan.lines[0]!.qtyMilli).toBe(4_000)

    const reread = getDocument(db, order.id, TEST_INFO)!
    expect(reread.status).toBe('open')
    expect(reread.lines[0]!.fulfilledMilli).toBe(4_000)
    expect(reread.lines[0]!.pendingMilli).toBe(6_000)

    const second = convert(db, order.id, TEST_INFO)
    expect(second.lines[0]!.qtyMilli).toBe(6_000)
    expect(getDocument(db, order.id, TEST_INFO)!.status).toBe('converted')
  })

  it('refuses a conversion once nothing is left to carry', () => {
    const { db, buyer, widget } = books()
    const order = convert(db, quote(db, buyer, widget).id, TEST_INFO)
    convert(db, order.id, TEST_INFO)
    expect(() => convert(db, order.id, TEST_INFO)).toThrow('already been converted')
  })

  it('needs a ledger before it becomes an order, not just a name', () => {
    const { db, widget } = books()
    const q = saveDocument(db, TEST_INFO, {
      stage: 'quotation', date: '2026-04-01', partyName: 'A stranger',
      lines: [{ stockItemId: widget, description: 'Widget', qtyMilli: 1000, ratePaise: 10000 }]
    })
    expect(() => convert(db, q.id, TEST_INFO)).toThrow('party ledger')
  })

  it('refuses to convert a quotation that was lost', () => {
    const { db, buyer, widget } = books()
    const q = quote(db, buyer, widget)
    closeDocument(db, q.id, TEST_INFO, 'lost', 'Cheaper elsewhere')
    expect(() => convert(db, q.id, TEST_INFO)).toThrow('lost')
    expect(getDocument(db, q.id, TEST_INFO)!.closedReason).toBe('Cheaper elsewhere')
  })
})

describe('the invoice', () => {
  it('is a draft, and it balances', () => {
    const { db, buyer, widget } = books()
    const challan = convert(db, convert(db, quote(db, buyer, widget).id, TEST_INFO).id, TEST_INFO)
    const draft = invoiceDraft(db, challan.id, TEST_INFO)
    const dr = draft.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = draft.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
    expect(dr).toBe(challan.totalPaise)
    // Drafting an invoice posts nothing.
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
  })

  it('refuses to invoice the same challan twice', () => {
    const { db, buyer, widget } = books()
    const challan = convert(db, convert(db, quote(db, buyer, widget).id, TEST_INFO).id, TEST_INFO)
    const invoice = postSimpleVoucher(db, { date: '2026-04-10', amount: 1_18_000, kind: 'sales' })
    markInvoiced(db, challan.id, invoice.id, TEST_INFO)
    expect(() => markInvoiced(db, challan.id, invoice.id, TEST_INFO)).toThrow('already been invoiced')
    expect(() => invoiceDraft(db, challan.id, TEST_INFO)).toThrow('already been invoiced')
  })
})

describe('housekeeping', () => {
  it('will not delete a document something was built on', () => {
    const { db, buyer, widget } = books()
    const q = quote(db, buyer, widget)
    convert(db, q.id, TEST_INFO)
    expect(() => deleteDocument(db, q.id, TEST_INFO)).toThrow('already been converted')
  })

  it('will not let a converted document be edited', () => {
    const { db, buyer, widget } = books()
    const q = quote(db, buyer, widget)
    convert(db, q.id, TEST_INFO)
    expect(() =>
      saveDocument(db, TEST_INFO, {
        stage: 'quotation', date: '2026-04-01', partyLedgerId: buyer,
        lines: [{ stockItemId: widget, description: 'Widget', qtyMilli: 1, ratePaise: 1 }]
      }, q.id)
    ).toThrow('already become')
  })

  it('counts the pipeline by stage', () => {
    const { db, buyer, widget } = books()
    quote(db, buyer, widget)
    const lost = quote(db, buyer, widget)
    closeDocument(db, lost.id, TEST_INFO, 'lost', 'Price')
    const p = pipeline(db, TEST_INFO, '2026-04-10')
    const quotations = p.stages.find((s) => s.stage === 'quotation')!
    expect(quotations.open).toBe(1)
    expect(quotations.lost).toBe(1)
    expect(p.expiringSoon).toHaveLength(1)
  })
})
