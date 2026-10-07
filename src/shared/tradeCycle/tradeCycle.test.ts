// WP 2.5a pure rules: link pairs, fulfilment status, stock-note validation, and the voucherEdit
// round trips that carry line uids / link sources / the challan purpose.
import { describe, expect, it } from 'vitest'
import { LINK_RULES, linkRuleFor, movesStockFor, sourceKindsFor, SHARED_CAPACITY_SOURCES } from './rules'
import { docStatus, lineFulfilment } from './fulfilment'
import { validateVoucher, type LedgerFacts, type VoucherInput } from '../posting'
import { VOUCHER_KINDS, type Voucher } from '../domain'
import {
  buildInvoicePayload, buildPhysicalPayload, buildStockLinesPayload, buildTransferPayload, diffPayloads, invoiceStateFromVoucher,
  modeForKind, physicalRepresentation, planVoucherEdit, stockLinesStateFromVoucher, transferRepresentation, voucherToPayload,
  type EditPlanContext, type VoucherPayload
} from '../voucherEdit'

describe('link rules', () => {
  it('movesStockFor: only challan → invoice and GRN → bill fulfilment is non-moving', () => {
    const nonMoving = LINK_RULES.filter((r) => r.nonMoving).map((r) => `${r.source}>${r.target}`)
    expect(nonMoving).toEqual(['delivery_note>sales', 'receipt_note>purchase'])
    for (const r of LINK_RULES) expect(movesStockFor(r.source, r.target, r.linkType)).toBe(!r.nonMoving)
    expect(movesStockFor('delivery_note', 'purchase', 'fulfil')).toBeNull()
    expect(movesStockFor('sales', 'credit_note', 'fulfil')).toBeNull()
    expect(linkRuleFor('receipt_note', 'purchase', 'fulfil')!.reprices).toBe(true)
    expect(LINK_RULES.filter((r) => r.reprices)).toHaveLength(1)
  })

  it('every pair, as data', () => {
    expect(LINK_RULES.map((r) => `${r.linkType}:${r.source}>${r.target}`)).toEqual([
      'fulfil:quotation>sales_order', 'fulfil:quotation>sales', 'fulfil:sales_order>delivery_note', 'fulfil:sales_order>sales',
      'fulfil:delivery_note>sales', 'fulfil:purchase_order>receipt_note', 'fulfil:purchase_order>purchase', 'fulfil:receipt_note>purchase',
      'return:sales>credit_note', 'return:purchase>debit_note', 'return:delivery_note>receipt_note', 'return:receipt_note>delivery_note'
    ])
    expect(sourceKindsFor('sales', 'fulfil')).toEqual(['quotation', 'sales_order', 'delivery_note'])
    expect(sourceKindsFor('receipt_note', 'return')).toEqual(['delivery_note'])
    expect(SHARED_CAPACITY_SOURCES).toEqual(['delivery_note', 'receipt_note'])
    // No link ever touches a plain stock voucher.
    expect(LINK_RULES.some((r) => ['stock_journal', 'physical_stock'].includes(r.source) || ['stock_journal', 'physical_stock'].includes(r.target))).toBe(false)
  })
})

describe('fulfilment / docStatus', () => {
  const lines = [{ lineUid: 'a', qtyMilli: 5000 }, { lineUid: 'b', qtyMilli: 2000 }]
  const q = (a: number, b: number) => new Map([['a', a], ['b', b]])
  it('derives the status; manual close / cancel win', () => {
    expect(docStatus({ status: 'open' }, lines, q(0, 0), '2025-05-01')).toBe('open')
    expect(docStatus({ status: 'open' }, lines, q(1000, 0), '2025-05-01')).toBe('partly_fulfilled')
    expect(docStatus({ status: 'open' }, lines, q(5000, 2000), '2025-05-01')).toBe('fulfilled')
    expect(docStatus({ status: 'closed' }, lines, q(1000, 0), '2025-05-01')).toBe('closed')
    expect(docStatus({ status: 'cancelled' }, lines, q(0, 0), '2025-05-01')).toBe('cancelled')
    expect(docStatus({ status: 'open', validUntil: '2025-04-30' }, lines, q(0, 0), '2025-05-01')).toBe('expired')
    expect(docStatus({ status: 'open', validUntil: '2025-04-30' }, lines, q(1000, 0), '2025-05-01')).toBe('partly_fulfilled')
    expect(docStatus({ status: 'open', validUntil: '2025-05-01' }, lines, q(0, 0), '2025-05-01')).toBe('open')
  })
  it('done / pending per line, clamped', () => {
    expect(lineFulfilment(lines, q(6000, 500))).toEqual([
      { lineUid: 'a', qtyMilli: 5000, doneMilli: 5000, pendingMilli: 0 },
      { lineUid: 'b', qtyMilli: 2000, doneMilli: 500, pendingMilli: 1500 }
    ])
  })
})

describe('validateVoucher — stock notes', () => {
  const facts = (): LedgerFacts => ({ exists: true, isCashOrBank: false })
  const note = (over: Partial<VoucherInput> = {}): VoucherInput => ({
    voucherTypeId: 1, date: '2025-05-01', partyLedgerId: 7, narration: null, reference: null, lines: [],
    inventory: [{ stockItemId: 1, godownId: null, qtyMilli: 1000, ratePaise: 100, amount: 100, direction: 'out' }], ...over
  })
  const codes = (v: VoucherInput, kind: 'delivery_note' | 'receipt_note') => validateVoucher(v, kind, facts).map((e) => e.code)

  it('a challan: party, goods out, nothing else', () => {
    expect(codes(note(), 'delivery_note')).toEqual([])
    expect(codes(note({ inventory: [] }), 'delivery_note')).toEqual(['no_inventory'])
    expect(codes(note({ partyLedgerId: null }), 'delivery_note')).toEqual(['stock_note_party'])
    expect(codes(note({ lines: [{ ledgerId: 1, drCr: 'dr', amount: 5 }, { ledgerId: 2, drCr: 'cr', amount: 5 }] }), 'delivery_note')).toEqual(['stock_note_ledger_lines'])
    expect(codes(note({ billRefs: [{ kind: 'new', name: 'x', amount: 1, dueDate: null }] }), 'delivery_note')).toContain('stock_note_bills')
    expect(codes(note({ tds: { sectionId: 1, baseAmount: 1, tdsAmount: 1 } }), 'delivery_note')).toEqual(['stock_note_bills'])
    expect(codes(note(), 'receipt_note')).toEqual(['stock_note_direction'])
    expect(codes(note({ inventory: [{ stockItemId: 1, godownId: null, qtyMilli: 0, ratePaise: 0, amount: 0, direction: 'out', isAbsolute: true }] }), 'delivery_note')).toContain('stock_note_direction')
  })

  it('a GRN takes goods in', () => {
    expect(codes(note({ inventory: [{ stockItemId: 1, godownId: null, qtyMilli: 1000, ratePaise: 100, amount: 100, direction: 'in' }] }), 'receipt_note')).toEqual([])
  })

  it('links: never on optional vouchers, stock journals or physical stock', () => {
    const linked = note({ inventory: [{ stockItemId: 1, godownId: null, qtyMilli: 1000, ratePaise: 0, amount: 0, direction: 'out', source: { lineUid: 'a'.repeat(32), linkType: 'fulfil' } }] })
    expect(validateVoucher(linked, 'stock_journal', facts).map((e) => e.code)).toContain('link_kind')
    expect(codes({ ...linked, isOptional: true }, 'delivery_note')).toContain('link_optional')
  })

  it('every kind has a validation path (no kind falls through to an exception)', () => {
    for (const k of VOUCHER_KINDS) expect(() => validateVoucher(note(), k, facts)).not.toThrow()
  })
})

// ---------- voucherEdit round trips ----------

const UID = (n: number): string => n.toString(16).padStart(32, '0')

function stored(p: VoucherPayload, id = 50): Voucher {
  return {
    id, voucherTypeId: p.voucherTypeId, date: p.date, number: p.number ?? '1', partyLedgerId: p.partyLedgerId, narration: p.narration,
    reference: p.reference, instrumentNo: p.instrumentNo, instrumentDate: p.instrumentDate, transporterId: p.transporterId,
    vehicleNo: p.vehicleNo, transportDistanceKm: p.transportDistanceKm, posOverride: p.posOverride, currencyCode: p.currencyCode,
    exchangeRate: p.exchangeRate, irn: null, irnAckNo: null, irnAckDate: null, ewbNo: null, ewbValidUpto: null,
    postDated: false, isOptional: p.isOptional ?? false, isYearEndClose: false, deletedAt: null, createdAt: '', updatedAt: '',
    lines: p.lines.map((l, i) => ({ id: i + 1, ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, bankDate: null, costAllocations: [] })),
    inventory: p.inventory.map((l, i) => ({
      id: 100 + i, stockItemId: l.stockItemId, godownId: l.godownId ?? null, batchId: l.batchId ?? null, qtyMilli: l.qtyMilli,
      ratePaise: l.ratePaise, discountPaise: l.discountPaise ?? 0, amount: l.amount, direction: l.direction, isAbsolute: l.isAbsolute ?? false,
      serials: l.serials ? [...l.serials] : [], lineUid: l.lineUid ?? UID(900 + i), movesStock: true, source: l.source ?? null
    })),
    billRefs: [], tds: null, trade: p.trade ?? null
  }
}

const EMPTY_HEADER = {
  number: '3', partyLedgerId: 7, narration: 'n', reference: null, instrumentNo: null, instrumentDate: null, transporterId: 'T1',
  vehicleNo: 'MH01', transportDistanceKm: 40, posOverride: null, currencyCode: null, exchangeRate: null, billRefs: [], tds: null
}

const ctx: EditPlanContext = {
  invoice: { companyStateCode: '27', items: new Map([[1, { gstRate: 0, cessRate: null }]]), ledgers: new Map([[7, { stateCode: '27', gstRate: null }]]) },
  taxLedgers: { cgst: null, sgst: null, igst: null, cess: null, roundOff: null },
  itemName: () => 'Item'
}

describe('voucherEdit — stock notes and links', () => {
  const dcPayload: VoucherPayload = {
    voucherTypeId: 1, date: '2025-05-01', ...EMPTY_HEADER, lines: [], trade: { purpose: 'job_work' },
    inventory: [
      { stockItemId: 1, godownId: 2, batchId: 3, qtyMilli: 2000, ratePaise: 500, discountPaise: 0, amount: 1000, direction: 'out', isAbsolute: false, serials: ['A', 'B'], lineUid: UID(1) },
      { stockItemId: 1, godownId: null, batchId: null, qtyMilli: 1000, ratePaise: 500, discountPaise: 0, amount: 500, direction: 'out', isAbsolute: false, lineUid: UID(2), source: { lineUid: UID(77), linkType: 'return' } }
    ]
  }

  it('delivery / receipt notes open in the stock-note form; the stock-lines fallback saves back unchanged (uids, source, purpose, party)', () => {
    expect(modeForKind('delivery_note')).toBe('stockNote')
    expect(modeForKind('receipt_note')).toBe('stockNote')
    const v = stored(dcPayload)
    expect(planVoucherEdit(v, 'delivery_note', ctx).mode).toBe('stockNote')
    // An amount that isn't qty × rate − discount can't be shown by the note form → lossless fallback.
    const odd = stored({ ...dcPayload, inventory: [{ ...dcPayload.inventory[0]!, amount: 999 }, dcPayload.inventory[1]!] })
    const fb = planVoucherEdit(odd, 'delivery_note', ctx)
    expect(fb.mode).toBe('stockLines')
    expect(fb.mode === 'stockLines' && fb.fallbackReason).toMatch(/would change/)
    const plan = { mode: 'stockLines' as const, state: stockLinesStateFromVoucher(v) }
    const r = buildStockLinesPayload(plan.state, { voucherTypeId: 1 })
    expect(r.ok && diffPayloads(r.payload, voucherToPayload(v))).toEqual([])
    expect(r.ok && r.payload.inventory.map((l) => l.lineUid)).toEqual([UID(1), UID(2)])
    expect(r.ok && r.payload.trade).toEqual({ purpose: 'job_work' })
    // A dropped / changed source or purpose is a real difference.
    const s2 = { ...plan.state, rows: [plan.state.rows[0]!, { ...plan.state.rows[1]!, source: null }] }
    const r2 = buildStockLinesPayload(s2, { voucherTypeId: 1 })
    expect(r2.ok && diffPayloads(r2.payload, voucherToPayload(v))).toEqual(['inventory[1].source'])
    const r3 = buildStockLinesPayload({ ...plan.state, passthrough: { ...plan.state.passthrough, trade: { purpose: 'supply' } } }, { voucherTypeId: 1 })
    expect(r3.ok && diffPayloads(r3.payload, voucherToPayload(v))).toEqual(['trade'])
    expect(stockLinesStateFromVoucher(v).rows[1]!.source).toEqual({ lineUid: UID(77), linkType: 'return' })
  })

  it('line uids compare only when both sides name one (absent = a new line)', () => {
    const v = stored(dcPayload)
    const p = voucherToPayload(v)
    const dropped = { ...p, inventory: p.inventory.map(({ lineUid: _u, ...l }) => l) }
    expect(diffPayloads(dropped, p)).toEqual([])
    const swapped = { ...p, inventory: [{ ...p.inventory[0]!, lineUid: UID(2) }, { ...p.inventory[1]!, lineUid: UID(1) }] }
    expect(diffPayloads(swapped, p)).toEqual(['inventory[0].lineUid', 'inventory[1].lineUid'])
  })

  it('an invoice drawn from a challan carries uid + source through its form', () => {
    const inv: VoucherPayload = {
      voucherTypeId: 5, date: '2025-05-02', ...EMPTY_HEADER, transporterId: null, vehicleNo: null, transportDistanceKm: null, narration: null, isOptional: false,
      lines: [{ ledgerId: 7, drCr: 'dr', amount: 1500, costAllocations: [] }, { ledgerId: 20, drCr: 'cr', amount: 1500, costAllocations: [] }],
      inventory: [{ stockItemId: 1, godownId: 2, batchId: 3, qtyMilli: 1000, ratePaise: 1500, discountPaise: 0, amount: 1500, direction: 'out', serials: ['A'], lineUid: UID(5), source: { lineUid: UID(1), linkType: 'fulfil' } }]
    }
    const v = stored(inv)
    const loaded = invoiceStateFromVoucher(v, 'sales', ctx.taxLedgers)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.state.rows[0]).toMatchObject({ lineUid: UID(5), source: { lineUid: UID(1), linkType: 'fulfil' } })
    const rebuilt = buildInvoicePayload(loaded.state, { ...ctx.invoice, kind: 'sales' }, 5, ctx.taxLedgers)
    expect(rebuilt.ok && diffPayloads(rebuilt.payload, voucherToPayload(v))).toEqual([])
    expect(rebuilt.ok && rebuilt.payload.inventory[0]).toMatchObject({ lineUid: UID(5), source: { lineUid: UID(1), linkType: 'fulfil' } })
    expect(planVoucherEdit(v, 'sales', ctx).mode).toBe('invoice')
  })

  it('physical counts and godown transfers keep their line uids', () => {
    const count: VoucherPayload = {
      voucherTypeId: 9, date: '2025-05-02', ...EMPTY_HEADER, partyLedgerId: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, narration: null, lines: [],
      inventory: [{ stockItemId: 1, godownId: null, batchId: null, qtyMilli: 4000, ratePaise: 0, amount: 0, direction: 'in', isAbsolute: true, lineUid: UID(8) }]
    }
    const pr = physicalRepresentation(stored(count), { itemName: () => 'Item' })
    expect(pr.ok).toBe(true)
    if (pr.ok) {
      const b = buildPhysicalPayload(pr.state, { voucherTypeId: 9, itemName: () => 'Item' })
      expect(b.ok && b.payload.inventory[0]!.lineUid).toBe(UID(8))
    }
    const transfer: VoucherPayload = {
      ...count, inventory: [
        { stockItemId: 1, godownId: 2, batchId: null, qtyMilli: 1000, ratePaise: 700, discountPaise: 0, amount: 700, direction: 'out', isAbsolute: false, lineUid: UID(10) },
        { stockItemId: 1, godownId: 3, batchId: null, qtyMilli: 1000, ratePaise: 700, discountPaise: 0, amount: 700, direction: 'in', isAbsolute: false, lineUid: UID(11) }
      ]
    }
    const tr = transferRepresentation(stored(transfer))
    expect(tr.ok).toBe(true)
    if (tr.ok) {
      const b = buildTransferPayload(tr.state, { voucherTypeId: 9, costs: [] })
      expect(b.ok && b.payload.inventory.map((l) => l.lineUid)).toEqual([UID(10), UID(11)])
    }
  })
})
