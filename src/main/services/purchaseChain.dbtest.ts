import { describe, it, expect } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger, createStockItem, createUnit } from './masters'
import { saveVoucher } from './vouchers'
import {
  closeDocument,
  convert,
  getDocument,
  invoiceDraft,
  listDocuments,
  markInvoiced,
  nextNumber,
  pipeline,
  saveDocument,
  threeWayMatchFor
} from './salesDocs'

type Db = ReturnType<typeof seededDb>

/**
 * The inward chain: purchase order → receipt note → the supplier's bill (roadmap #188, #189).
 *
 * The same three stages as the sale, read the other way, and the property that carries the value
 * is not the document — it is the balance. What was ordered, what has arrived, what is still
 * owed, and what turned up that nobody asked for. A part-received order that reports itself as
 * either "open" or "closed" is the failure this half exists to prevent.
 */
const LEDGER_DEFAULTS = {
  openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

function books(): { db: Db; supplier: number; bolt: number } {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const unit =
    (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined) ??
    createUnit(db, { name: 'Pieces', symbol: 'pcs', decimals: 3, uqc: 'PCS' })
  const bolt = createStockItem(db, {
    name: 'Bolt', groupId: null, unitId: unit.id, hsn: '7318', gstRate: 18, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
  } as never).id
  const supplier = createLedger(db, {
    ...LEDGER_DEFAULTS, name: 'Fasteners Ltd', groupId: groupId('Sundry Creditors'), stateCode: '27'
  }).id
  return { db, supplier, bolt }
}

const order = (db: Db, supplier: number, bolt: number, qtyMilli = 100_000): ReturnType<typeof saveDocument> =>
  saveDocument(db, TEST_INFO, {
    stage: 'order',
    side: 'purchase',
    date: '2026-04-01',
    partyLedgerId: supplier,
    lines: [{ stockItemId: bolt, description: 'Bolt', qtyMilli, ratePaise: 1000 }]
  })

/** A supplier bill carrying inventory, which is what the three-way match reads. */
function bill(db: Db, supplier: number, bolt: number, qtyMilli: number): { id: number; number: string } {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }
  const purchases = (db.prepare("SELECT id FROM ledgers WHERE name = 'Purchase Account'").get() as { id: number } | undefined)
    ?? createLedger(db, {
      ...LEDGER_DEFAULTS,
      name: 'Purchase Account',
      groupId: (db.prepare("SELECT id FROM groups WHERE name = 'Purchase Accounts'").get() as { id: number }).id
    })
  const amount = Math.round((qtyMilli * 1000) / 1000)
  const v = saveVoucher(db, {
    voucherTypeId: vt.id,
    date: '2026-04-20',
    partyLedgerId: supplier,
    lines: [
      { ledgerId: purchases.id, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: supplier, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [
      { stockItemId: bolt, godownId: null, qtyMilli, ratePaise: 1000, amount, direction: 'in' }
    ],
    billRefs: [],
    tds: null
  } as never)
  return { id: v.id, number: v.number }
}

describe('the purchase order', () => {
  it('numbers itself apart from the sales chain', () => {
    const { db, supplier, bolt } = books()
    expect(nextNumber(db, 'order', 'purchase')).toBe('PO-0001')
    const po = order(db, supplier, bolt)
    expect(po.number).toBe('PO-0001')
    expect(po.side).toBe('purchase')
    expect(po.stageLabel).toBe('Purchase order')
    // The outward series is untouched by it.
    expect(nextNumber(db, 'order', 'sales')).toBe('SO-0001')
  })

  it('is listed on its own side, never mixed with the sales chain', () => {
    const { db, supplier, bolt } = books()
    order(db, supplier, bolt)
    expect(listDocuments(db, TEST_INFO, { side: 'purchase' })).toHaveLength(1)
    expect(listDocuments(db, TEST_INFO, { side: 'sales' })).toHaveLength(0)
    // Defaulted rather than optional: a caller that forgets gets the sales chain, not both.
    expect(listDocuments(db, TEST_INFO, {})).toHaveLength(0)
  })

  it('needs a supplier ledger, because the bill that follows lands in one', () => {
    const { db, bolt } = books()
    expect(() =>
      saveDocument(db, TEST_INFO, {
        stage: 'order', side: 'purchase', date: '2026-04-01', partyName: 'Somebody on the phone',
        lines: [{ stockItemId: bolt, description: 'Bolt', qtyMilli: 1000, ratePaise: 1000 }]
      })
    ).toThrow('supplier ledger')
  })

  it('has no quotation stage — the supplier issues that, not us', () => {
    const { db, supplier, bolt } = books()
    expect(() =>
      saveDocument(db, TEST_INFO, {
        stage: 'quotation', side: 'purchase', date: '2026-04-01', partyLedgerId: supplier,
        lines: [{ stockItemId: bolt, description: 'Bolt', qtyMilli: 1000, ratePaise: 1000 }]
      })
    ).toThrow('no request for quotation stage')
  })
})

describe('receiving against it', () => {
  it('an order received in three parts stays open until the last delivery', () => {
    const { db, supplier, bolt } = books()
    const po = order(db, supplier, bolt, 90_000)
    const lineId = po.lines[0]!.id

    for (const part of [20_000, 30_000]) {
      convert(db, po.id, TEST_INFO, { quantities: [{ lineId, qtyMilli: part }], date: '2026-04-05' })
      const mid = getDocument(db, po.id, TEST_INFO)!
      expect(mid.status).toBe('open')
      expect(mid.fulfilment.state).toBe('partial')
    }
    expect(getDocument(db, po.id, TEST_INFO)!.fulfilment.pendingMilli).toBe(40_000)

    convert(db, po.id, TEST_INFO, { quantities: [{ lineId, qtyMilli: 40_000 }], date: '2026-04-09' })
    const done = getDocument(db, po.id, TEST_INFO)!
    expect(done.status).toBe('converted')
    expect(done.fulfilment.state).toBe('complete')
    expect(done.fulfilment.pendingMilli).toBe(0)
    expect(listDocuments(db, TEST_INFO, { side: 'purchase', stage: 'challan' })).toHaveLength(3)
  })

  it('records an over-delivery instead of clipping it — the goods are in the godown either way', () => {
    const { db, supplier, bolt } = books()
    const po = order(db, supplier, bolt, 100_000)
    const grn = convert(db, po.id, TEST_INFO, {
      quantities: [{ lineId: po.lines[0]!.id, qtyMilli: 110_000 }],
      allowOver: true
    })
    expect(grn.lines[0]!.qtyMilli).toBe(110_000)
    const after = getDocument(db, po.id, TEST_INFO)!
    expect(after.fulfilment.state).toBe('over')
    expect(after.fulfilment.overMilli).toBe(10_000)
    expect(after.fulfilment.pendingMilli).toBe(0)
    expect(after.status).toBe('converted')
  })

  it('refuses an over-delivery outward — our own challan cannot exceed our own order', () => {
    const { db, supplier, bolt } = books()
    const groupId = (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id
    const buyer = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Kumar Stores', groupId, stateCode: '27' }).id
    const so = saveDocument(db, TEST_INFO, {
      stage: 'order', date: '2026-04-01', partyLedgerId: buyer,
      lines: [{ stockItemId: bolt, description: 'Bolt', qtyMilli: 1_000, ratePaise: 1000 }]
    })
    expect(() => convert(db, so.id, TEST_INFO, { quantities: [{ lineId: so.lines[0]!.id, qtyMilli: 5_000 }], allowOver: true }))
      .toThrow('Only an inward receipt')
    // Without the flag it is clamped to what is pending, exactly as before.
    const dc = convert(db, so.id, TEST_INFO, { quantities: [{ lineId: so.lines[0]!.id, qtyMilli: 5_000 }] })
    expect(dc.lines[0]!.qtyMilli).toBe(1_000)
    void supplier
  })

  it('does not net an excess on one line against a shortfall on another', () => {
    const { db, supplier, bolt } = books()
    const nut = createStockItem(db, {
      name: 'Nut', groupId: null, unitId: (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id,
      hsn: '7318', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
    } as never).id
    const po = saveDocument(db, TEST_INFO, {
      stage: 'order', side: 'purchase', date: '2026-04-01', partyLedgerId: supplier,
      lines: [
        { stockItemId: bolt, description: 'Bolt', qtyMilli: 10_000, ratePaise: 1000 },
        { stockItemId: nut, description: 'Nut', qtyMilli: 10_000, ratePaise: 1000 }
      ]
    })
    convert(db, po.id, TEST_INFO, {
      quantities: [
        { lineId: po.lines[0]!.id, qtyMilli: 20_000 },
        { lineId: po.lines[1]!.id, qtyMilli: 0 }
      ],
      allowOver: true
    })
    const after = getDocument(db, po.id, TEST_INFO)!
    expect(after.status).toBe('open')
    expect(after.fulfilment.pendingMilli).toBe(10_000)
    expect(after.fulfilment.overMilli).toBe(10_000)
  })

  it('can be closed short, and says why', () => {
    const { db, supplier, bolt } = books()
    const po = order(db, supplier, bolt)
    convert(db, po.id, TEST_INFO, { quantities: [{ lineId: po.lines[0]!.id, qtyMilli: 60_000 }] })
    closeDocument(db, po.id, TEST_INFO, 'closed', 'Supplier discontinued the size')
    const after = getDocument(db, po.id, TEST_INFO)!
    expect(after.status).toBe('closed')
    expect(after.closedReason).toBe('Supplier discontinued the size')
    // Closing it does not pretend the balance was delivered.
    expect(after.fulfilment.pendingMilli).toBe(40_000)
  })
})

describe('a receipt note with no order behind it', () => {
  it('is allowed, and says so about itself', () => {
    const { db, supplier, bolt } = books()
    const grn = saveDocument(db, TEST_INFO, {
      stage: 'challan', side: 'purchase', date: '2026-04-03', partyLedgerId: supplier,
      lines: [{ stockItemId: bolt, description: 'Bolt', qtyMilli: 5_000, ratePaise: 1000 }]
    })
    expect(grn.number).toBe('GRN-0001')
    expect(grn.unordered).toBe(true)
    expect(pipeline(db, TEST_INFO, '2026-04-10', 'purchase').unordered.map((d) => d.number)).toEqual(['GRN-0001'])
  })

  it('matches as not_ordered on every line, rather than reporting nothing', () => {
    const { db, supplier, bolt } = books()
    const grn = saveDocument(db, TEST_INFO, {
      stage: 'challan', side: 'purchase', date: '2026-04-03', partyLedgerId: supplier,
      lines: [{ stockItemId: bolt, description: 'Bolt', qtyMilli: 5_000, ratePaise: 1000 }]
    })
    const m = threeWayMatchFor(db, grn.id, TEST_INFO)
    expect(m.orderNumber).toBeNull()
    expect(m.rows).toHaveLength(1)
    expect(m.rows[0]!.status).toBe('not_ordered')
    expect(m.clean).toBe(false)
  })

  it('a receipt note raised against an order is not unordered', () => {
    const { db, supplier, bolt } = books()
    const po = order(db, supplier, bolt)
    const grn = convert(db, po.id, TEST_INFO, { quantities: [{ lineId: po.lines[0]!.id, qtyMilli: 100_000 }] })
    expect(grn.unordered).toBe(false)
  })
})

describe('the three-way match', () => {
  it('agrees when the order, the receipts and the bill all say the same', () => {
    const { db, supplier, bolt } = books()
    const po = order(db, supplier, bolt, 10_000)
    const grn = convert(db, po.id, TEST_INFO, { quantities: [{ lineId: po.lines[0]!.id, qtyMilli: 10_000 }] })
    markInvoiced(db, grn.id, bill(db, supplier, bolt, 10_000).id, TEST_INFO)
    const m = threeWayMatchFor(db, po.id, TEST_INFO)
    expect(m.clean).toBe(true)
    expect(m.rows[0]).toMatchObject({ orderedMilli: 10_000, receivedMilli: 10_000, invoicedMilli: 10_000 })
  })

  it('flags a bill for more than arrived, which is the one that costs money', () => {
    const { db, supplier, bolt } = books()
    const po = order(db, supplier, bolt, 10_000)
    const grn = convert(db, po.id, TEST_INFO, { quantities: [{ lineId: po.lines[0]!.id, qtyMilli: 6_000 }] })
    markInvoiced(db, grn.id, bill(db, supplier, bolt, 10_000).id, TEST_INFO)
    const m = threeWayMatchFor(db, po.id, TEST_INFO)
    expect(m.exceptions[0]!.status).toBe('over_invoiced')
    expect(m.exceptions[0]!.invoiceVarianceMilli).toBe(4_000)
  })

  it('adds up several receipts against one order', () => {
    const { db, supplier, bolt } = books()
    const po = order(db, supplier, bolt, 10_000)
    convert(db, po.id, TEST_INFO, { quantities: [{ lineId: po.lines[0]!.id, qtyMilli: 4_000 }] })
    convert(db, po.id, TEST_INFO, { quantities: [{ lineId: po.lines[0]!.id, qtyMilli: 6_000 }] })
    const m = threeWayMatchFor(db, po.id, TEST_INFO)
    expect(m.receiptNumbers).toHaveLength(2)
    expect(m.rows[0]!.receivedMilli).toBe(10_000)
    // Nothing billed yet is not a mismatch — it is a bill that has not arrived.
    expect(m.rows[0]!.status).toBe('matched')
  })

  it('ignores a bill that has been moved to the bin', () => {
    const { db, supplier, bolt } = books()
    const po = order(db, supplier, bolt, 10_000)
    const grn = convert(db, po.id, TEST_INFO, { quantities: [{ lineId: po.lines[0]!.id, qtyMilli: 10_000 }] })
    const v = bill(db, supplier, bolt, 10_000)
    markInvoiced(db, grn.id, v.id, TEST_INFO)
    db.prepare("UPDATE vouchers SET deleted_at = '2026-04-25' WHERE id = ?").run(v.id)
    const m = threeWayMatchFor(db, po.id, TEST_INFO)
    expect(m.rows[0]!.invoicedMilli).toBe(0)
    expect(m.invoiceNumbers).toEqual([])
  })

  it('is an inward report and says so when pointed outward', () => {
    const { db, bolt } = books()
    const groupId = (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id
    const buyer = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Kumar Stores', groupId, stateCode: '27' }).id
    const so = saveDocument(db, TEST_INFO, {
      stage: 'order', date: '2026-04-01', partyLedgerId: buyer,
      lines: [{ stockItemId: bolt, description: 'Bolt', qtyMilli: 1_000, ratePaise: 1000 }]
    })
    expect(() => threeWayMatchFor(db, so.id, TEST_INFO)).toThrow('inward report')
  })
})

describe('the supplier’s bill', () => {
  it('drafts the posting the other way round, and it balances', () => {
    const { db, supplier, bolt } = books()
    const po = order(db, supplier, bolt, 10_000)
    const grn = convert(db, po.id, TEST_INFO, { quantities: [{ lineId: po.lines[0]!.id, qtyMilli: 10_000 }] })
    const draft = invoiceDraft(db, grn.id, TEST_INFO)
    const dr = draft.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = draft.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
    // The supplier is credited, purchases and the input tax are debited.
    expect(draft.lines.find((l) => l.group === 'Sundry Creditors')!.drCr).toBe('cr')
    expect(draft.lines.find((l) => l.group === 'Purchase Accounts')!.drCr).toBe('dr')
    expect(draft.lines.filter((l) => l.group === 'Duties & Taxes').every((l) => l.drCr === 'dr')).toBe(true)
    // Drafting posts nothing.
    expect(db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL").get()).toEqual({ n: 0 })
  })

  it('counts fulfilment in the pipeline, which is not the same as counting open documents', () => {
    const { db, supplier, bolt } = books()
    const partly = order(db, supplier, bolt, 10_000)
    convert(db, partly.id, TEST_INFO, { quantities: [{ lineId: partly.lines[0]!.id, qtyMilli: 4_000 }] })
    order(db, supplier, bolt, 10_000)
    const p = pipeline(db, TEST_INFO, '2026-04-10', 'purchase')
    const orders = p.stages.find((s) => s.stage === 'order')!
    expect(orders.label).toBe('Purchase order')
    expect(orders.open).toBe(2)
    expect(orders.partlyFulfilled).toBe(1)
    expect(orders.pendingMilli).toBe(16_000)
    // The outward pipeline knows nothing about any of it.
    expect(pipeline(db, TEST_INFO, '2026-04-10', 'sales').stages.every((s) => s.open === 0)).toBe(true)
  })
})
