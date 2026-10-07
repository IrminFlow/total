import { describe, expect, it } from 'vitest'
import type { Voucher, VoucherKind } from '../domain'
import {
  accountingStateFromVoucher, buildAccountingPayload, buildInvoicePayload, buildManufacturePayload, buildPhysicalPayload,
  buildStockLinesPayload, computeInvoice, diffPayloads, emptyInvoiceState, emptyManufactureState, emptyPhysicalState,
  invoiceRepresentation, manufactureRepresentation, modeForKind, physicalRepresentation, planVoucherEdit,
  stockLinesStateFromVoucher, voucherToPayload, applyTdsToAccountingRows, appliedTdsAmount, tdsStateFromSaved,
  type BomComponent, type EditPlanContext, type InvoiceContext, type InvoiceFormState, type TaxLedgerIds, type VoucherPayload
} from './index'

// ---------- fixtures ----------

const PARTY = 10 // debtor, MH
const PARTY_KA = 11 // debtor, KA (inter-state)
const SALES = 20
const SALES_2 = 21
const BANK = 30
const EXPENSE = 31
const TAX: TaxLedgerIds = { cgst: 40, sgst: 41, igst: 42, cess: 43, roundOff: 44 }
const WIDGET = 100 // 18%
const GADGET = 101 // 5% + 1% cess
const STEEL = 200
const PAINT = 201
const CHAIR = 300

const baseCtx: Omit<InvoiceContext, 'kind'> = {
  companyStateCode: '27',
  items: new Map([
    [WIDGET, { gstRate: 18, cessRate: null }],
    [GADGET, { gstRate: 5, cessRate: 1 }]
  ]),
  ledgers: new Map([
    [PARTY, { stateCode: '27', gstRate: null }],
    [PARTY_KA, { stateCode: '29', gstRate: null }],
    [SALES, { stateCode: null, gstRate: null }],
    [SALES_2, { stateCode: null, gstRate: null }]
  ])
}
const ctxFor = (kind: VoucherKind): InvoiceContext => ({ ...baseCtx, kind })

let nextId = 1
/** What saveVoucher + getVoucher would hand back for a payload (fresh ids). */
function stored(p: VoucherPayload, over: Partial<Voucher> = {}): Voucher {
  return {
    id: nextId++,
    voucherTypeId: p.voucherTypeId,
    date: p.date,
    number: p.number ?? 'AUTO-1',
    partyLedgerId: p.partyLedgerId,
    narration: p.narration,
    reference: p.reference,
    instrumentNo: p.instrumentNo,
    instrumentDate: p.instrumentDate,
    transporterId: p.transporterId,
    vehicleNo: p.vehicleNo,
    transportDistanceKm: p.transportDistanceKm,
    posOverride: p.posOverride,
    currencyCode: p.currencyCode,
    exchangeRate: p.exchangeRate,
    irn: null, irnAckNo: null, irnAckDate: null, ewbNo: null, ewbValidUpto: null,
    postDated: p.postDated ?? false,
    isOptional: p.isOptional ?? false,
    isYearEndClose: false,
    deletedAt: null,
    createdAt: '2025-05-01 10:00:00',
    updatedAt: '2025-05-01 10:00:00',
    lines: p.lines.map((l) => ({
      id: nextId++, ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount, bankDate: null,
      costAllocations: (l.costAllocations ?? []).map((a) => ({ ...a }))
    })),
    inventory: p.inventory.map((l) => ({
      id: nextId++, stockItemId: l.stockItemId, godownId: l.godownId ?? null, batchId: l.batchId ?? null,
      qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, discountPaise: l.discountPaise ?? 0, amount: l.amount,
      direction: l.direction, isAbsolute: l.isAbsolute ?? false
    })),
    billRefs: p.billRefs.map((r) => ({ kind: r.kind, name: r.name, amount: r.amount, dueDate: r.dueDate ?? null })),
    tds: p.tds,
    ...over
  }
}

function invoiceState(over: Partial<InvoiceFormState> = {}): InvoiceFormState {
  return {
    ...emptyInvoiceState('2025-05-01'),
    number: 'INV-7',
    partyId: PARTY,
    accountId: SALES,
    rows: [
      { itemId: WIDGET, qtyText: '2.5', rate: 40000, discount: 5000, godownId: 3, batchId: 9 },
      { itemId: GADGET, qtyText: '1', rate: 9999, discount: null, godownId: null, batchId: null }
    ],
    narration: 'Being goods sold',
    vehicleNo: 'MH01AB1234',
    transporterId: '27ABCDE1234F1Z5',
    distanceKm: '120',
    billName: 'INV-7',
    billDueDate: '2025-05-31',
    ...over
  }
}

function built(r: ReturnType<typeof buildInvoicePayload>): VoucherPayload {
  if (!r.ok) throw new Error(r.error)
  return r.payload
}

// ---------- payload plumbing ----------

describe('voucherToPayload / diffPayloads', () => {
  it('a stored voucher re-saved verbatim diffs to nothing', () => {
    const v = stored(built(buildInvoicePayload(invoiceState(), ctxFor('sales'), 1, TAX)))
    expect(diffPayloads(voucherToPayload(v), voucherToPayload(v))).toEqual([])
  })

  it('names the field that would change, including every inventory-line field', () => {
    const v = stored(built(buildInvoicePayload(invoiceState(), ctxFor('sales'), 1, TAX)))
    const p = voucherToPayload(v)
    for (const field of ['batchId', 'godownId', 'discountPaise', 'isAbsolute'] as const) {
      const changed = { ...p, inventory: p.inventory.map((l, i) => (i === 0 ? { ...l, [field]: field === 'isAbsolute' ? true : 99 } : l)) }
      expect(diffPayloads(changed, p)).toEqual([`inventory[0].${field}`])
    }
    // Dropping a field (as the old AccountingEntry remap did) is a change too.
    const dropped = { ...p, inventory: p.inventory.map((l) => ({ ...l, batchId: undefined, discountPaise: undefined })) }
    expect(diffPayloads(dropped, p)).toEqual(expect.arrayContaining(['inventory[0].batchId', 'inventory[0].discountPaise']))
  })

  it('treats absent postDated/isOptional as "keep" but compares them when both are stated', () => {
    const v = stored(built(buildInvoicePayload(invoiceState(), ctxFor('sales'), 1, TAX)), { postDated: true })
    const p = voucherToPayload(v)
    expect(diffPayloads({ ...p, postDated: undefined }, p)).toEqual([])
    expect(diffPayloads({ ...p, postDated: false }, p)).toEqual(['postDated'])
  })
})

// ---------- invoice ----------

describe('invoice mode state ⇄ payload', () => {
  it('builds party / sales / CGST / SGST / cess / round-off lines and keeps godown + batch + discount', () => {
    const p = built(buildInvoicePayload(invoiceState(), ctxFor('sales'), 1, TAX))
    // Widget: 2.5 × 400.00 = 1000.00 − 50.00 = 950.00 @18%; Gadget 99.99 @5% + 1% cess.
    expect(p.inventory).toEqual([
      { stockItemId: WIDGET, godownId: 3, batchId: 9, qtyMilli: 2500, ratePaise: 40000, discountPaise: 5000, amount: 95000, direction: 'out' },
      { stockItemId: GADGET, godownId: null, batchId: null, qtyMilli: 1000, ratePaise: 9999, discountPaise: 0, amount: 9999, direction: 'out' }
    ])
    const ids = p.lines.map((l) => [l.ledgerId, l.drCr])
    expect(ids).toEqual([[PARTY, 'dr'], [SALES, 'cr'], [40, 'cr'], [41, 'cr'], [43, 'cr'], [44, expect.any(String)]])
    const dr = p.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = p.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
    expect(p.lines[0]!.amount % 100).toBe(0)
    expect(p.billRefs).toEqual([{ kind: 'new', name: 'INV-7', amount: p.lines[0]!.amount, dueDate: '2025-05-31' }])
  })

  it('refuses to build without a tax ledger it needs', () => {
    const r = buildInvoicePayload(invoiceState(), ctxFor('sales'), 1, { ...TAX, cess: null })
    expect(r).toEqual({ ok: false, error: 'No CESS ledger' })
  })

  const cases: [string, VoucherKind, Partial<InvoiceFormState>][] = [
    ['sales with discount, batch, godown, transport', 'sales', {}],
    ['inter-state sales (IGST) with POS override + optional', 'sales', { partyId: PARTY_KA, posOverride: '29', optional: true }],
    ['purchase (goods in, party credited)', 'purchase', { accountId: SALES_2 }],
    ['foreign-currency sales', 'sales', { currencyCode: 'USD', fxRateText: '83.5', rows: [{ itemId: WIDGET, qtyText: '3', rate: 1250, discount: 100, godownId: null, batchId: null }] }],
    ['credit note against open bills', 'credit_note', { billName: '', noteBillRefs: [] }],
    ['debit note as a new bill', 'debit_note', { manualNewBillMode: true }],
    ['sales without a bill ref, carrying a reference + cheque no', 'sales', { billName: '', reference: 'PO-77', instrumentNo: 'CHQ1', instrumentDate: '2025-04-30' }]
  ]
  for (const [name, kind, over] of cases) {
    it(`round-trips: ${name}`, () => {
      let state = invoiceState(over)
      if (kind === 'credit_note') {
        const total = computeInvoice(state, ctxFor(kind)).rounded
        state = { ...state, noteBillRefs: [{ kind: 'against', name: 'INV-1', amount: total - 10000, dueDate: null }, { kind: 'against', name: 'INV-2', amount: 10000, dueDate: null }] }
      }
      const v = stored(built(buildInvoicePayload(state, ctxFor(kind), 1, TAX)))
      const rep = invoiceRepresentation(v, ctxFor(kind), TAX)
      expect(rep).toMatchObject({ ok: true })
      if (!rep.ok) return
      const again = built(buildInvoicePayload(rep.state, ctxFor(kind), 1, TAX))
      expect(diffPayloads(again, voucherToPayload(v))).toEqual([])
      expect(rep.state.rows.map((r) => [r.itemId, r.qtyText, r.rate, r.discount, r.godownId, r.batchId])).toEqual(
        state.rows.map((r) => [r.itemId, r.qtyText, r.rate, r.discount, r.godownId, r.batchId])
      )
    })
  }

  it('a loaded invoice whose quantity is changed recomputes tax and total', () => {
    const v = stored(built(buildInvoicePayload(invoiceState(), ctxFor('sales'), 1, TAX)))
    const rep = invoiceRepresentation(v, ctxFor('sales'), TAX)
    if (!rep.ok) throw new Error(rep.reason)
    const edited = { ...rep.state, rows: rep.state.rows.map((r, i) => (i === 0 ? { ...r, qtyText: '5' } : r)) }
    const p = built(buildInvoicePayload(edited, ctxFor('sales'), 1, TAX))
    expect(p.inventory[0]).toMatchObject({ qtyMilli: 5000, amount: 195000, discountPaise: 5000, batchId: 9, godownId: 3 })
    expect(p.lines[1]!.amount).toBe(195000 + 9999)
    expect(p.billRefs[0]!.amount).toBe(p.lines[0]!.amount)
    expect(p.number).toBe(v.number)
  })

  describe('not representable → accounting fallback', () => {
    const v0 = (): Voucher => stored(built(buildInvoicePayload(invoiceState(), ctxFor('sales'), 1, TAX)))

    it('item GST rate changed since the voucher was saved', () => {
      const ctx = { ...ctxFor('sales'), items: new Map([...baseCtx.items, [WIDGET, { gstRate: 12, cessRate: null }]]) }
      const rep = invoiceRepresentation(v0(), ctx, TAX)
      expect(rep.ok).toBe(false)
    })
    it('hand-built in accounting mode with an extra freight line', () => {
      const v = v0()
      const freight = { id: 999, ledgerId: EXPENSE, drCr: 'cr' as const, amount: 5000, bankDate: null, costAllocations: [] }
      v.lines = [{ ...v.lines[0]!, amount: v.lines[0]!.amount + 5000 }, ...v.lines.slice(1), freight]
      expect(invoiceRepresentation(v, ctxFor('sales'), TAX)).toMatchObject({ ok: false })
    })
    it('two sales ledgers', () => {
      const v = v0()
      v.lines.push({ id: 998, ledgerId: SALES_2, drCr: 'cr', amount: 100, bankDate: null, costAllocations: [] })
      expect(invoiceRepresentation(v, ctxFor('sales'), TAX)).toMatchObject({ ok: false, reason: expect.stringContaining('exactly one') })
    })
    it('cost-centre allocations, TDS, physical-count lines, unrounded total, a non-standard tax ledger', () => {
      const a = v0()
      a.lines[1]!.costAllocations = [{ costCentreId: 1, amount: 100 }]
      expect(invoiceRepresentation(a, ctxFor('sales'), TAX).ok).toBe(false)
      const b = v0()
      b.tds = { sectionId: 1, baseAmount: 100, tdsAmount: 1 }
      expect(invoiceRepresentation(b, ctxFor('sales'), TAX).ok).toBe(false)
      const c = v0()
      c.inventory[0]!.isAbsolute = true
      expect(invoiceRepresentation(c, ctxFor('sales'), TAX).ok).toBe(false)
      const d = v0()
      d.lines = d.lines.filter((l) => l.ledgerId !== TAX.roundOff)
      expect(invoiceRepresentation(d, ctxFor('sales'), TAX).ok).toBe(false)
      const e = v0()
      e.lines = e.lines.map((l) => (l.ledgerId === TAX.cgst ? { ...l, ledgerId: 77 } : l))
      expect(invoiceRepresentation(e, ctxFor('sales'), TAX).ok).toBe(false)
    })
    it('line amount that is not qty × rate − discount (e.g. a Tally import)', () => {
      const v = v0()
      v.inventory[0]!.amount += 1
      expect(invoiceRepresentation(v, ctxFor('sales'), TAX).ok).toBe(false)
    })
  })
})

// ---------- accounting ----------

describe('accounting mode state ⇄ payload', () => {
  const journal = (): Voucher =>
    stored({
      voucherTypeId: 5, date: '2025-05-02', number: 'J-3', partyLedgerId: PARTY, narration: 'adj',
      reference: 'REF-1', instrumentNo: 'UTR9', instrumentDate: '2025-04-28', transporterId: 'T1', vehicleNo: 'V1',
      transportDistanceKm: 5, posOverride: '29', currencyCode: 'USD', exchangeRate: 80, isOptional: false,
      lines: [
        { ledgerId: EXPENSE, drCr: 'dr', amount: 10000, costAllocations: [{ costCentreId: 2, amount: 6000 }, { costCentreId: 1, amount: 4000 }] },
        { ledgerId: PARTY, drCr: 'cr', amount: 9000, costAllocations: [] },
        { ledgerId: 50, drCr: 'cr', amount: 1000, costAllocations: [] }
      ],
      inventory: [
        { stockItemId: WIDGET, godownId: 4, batchId: 8, qtyMilli: 1500, ratePaise: 100, discountPaise: 12, amount: 138, direction: 'out', isAbsolute: false },
        { stockItemId: GADGET, godownId: null, batchId: null, qtyMilli: 0, ratePaise: 0, discountPaise: 0, amount: 0, direction: 'in', isAbsolute: true }
      ],
      billRefs: [{ kind: 'new', name: 'J-3', amount: 9000, dueDate: '2025-06-01' }],
      tds: { sectionId: 3, baseAmount: 10000, tdsAmount: 1000, isManual: false, autoPayable: false }
    })

  it('load → save is the identity: every inventory field, header passthrough, party, cheque date, TDS', () => {
    const v = journal()
    const r = buildAccountingPayload(accountingStateFromVoucher(v), { kind: 'journal', voucherTypeId: 5, derivedPartyId: null })
    if (!r.ok) throw new Error(r.error)
    expect(diffPayloads(r.payload, voucherToPayload(v))).toEqual([])
    expect(r.payload.inventory[0]).toEqual({ stockItemId: WIDGET, godownId: 4, batchId: 8, qtyMilli: 1500, ratePaise: 100, discountPaise: 12, amount: 138, direction: 'out', isAbsolute: false })
    expect(r.payload.inventory[1]!.isAbsolute).toBe(true)
  })

  it('keeps the stored party while the same ledgers are posted, even if derivation disagrees', () => {
    const v = journal()
    const state = accountingStateFromVoucher(v)
    const r = buildAccountingPayload(state, { kind: 'journal', voucherTypeId: 5, derivedPartyId: 777 })
    expect(r.ok && r.payload.partyLedgerId).toBe(PARTY)
    // Once the party line is replaced, the derived party takes over.
    const swapped = { ...state, rows: state.rows.map((x) => (x.ledgerId === PARTY ? { ...x, ledgerId: PARTY_KA } : x)) }
    const r2 = buildAccountingPayload(swapped, { kind: 'journal', voucherTypeId: 5, derivedPartyId: PARTY_KA })
    expect(r2.ok && r2.payload.partyLedgerId).toBe(PARTY_KA)
  })

  it('a changed cheque number re-dates the instrument; an unchanged one keeps its date', () => {
    const state = accountingStateFromVoucher(journal())
    const r1 = buildAccountingPayload(state, { kind: 'journal', voucherTypeId: 5, derivedPartyId: PARTY })
    expect(r1.ok && r1.payload.instrumentDate).toBe('2025-04-28')
    const r2 = buildAccountingPayload({ ...state, instrumentNo: 'UTR10' }, { kind: 'journal', voucherTypeId: 5, derivedPartyId: PARTY })
    expect(r2.ok && r2.payload.instrumentDate).toBe('2025-05-02')
  })

  it('new receipt with an advance posts the unallocated remainder as a new bill', () => {
    const r = buildAccountingPayload(
      {
        date: '2025-05-01', number: 'R-1', narration: '', instrumentNo: '', billRefs: [], advanceReceipt: true, optional: false, tds: null, original: null,
        rows: [
          { drCr: 'dr', ledgerId: BANK, amount: 5000, costAllocations: [] },
          { drCr: 'cr', ledgerId: PARTY, amount: 5000, costAllocations: [] },
          { drCr: 'cr', ledgerId: null, amount: null, costAllocations: [] }
        ]
      },
      { kind: 'receipt', voucherTypeId: 6, derivedPartyId: PARTY }
    )
    expect(r.ok && r.payload.billRefs).toEqual([{ kind: 'new', name: 'R-1', amount: 5000, dueDate: null }])
    expect(r.ok && r.payload.inventory).toEqual([])
  })
})

// ---------- manufacture ----------

const BOM: BomComponent[] = [
  { componentId: PAINT, qtyMilliPerUnit: 250 },
  { componentId: STEEL, qtyMilliPerUnit: 2000 }
]
const names = (id: number): string => ({ [CHAIR]: 'Chair', [STEEL]: 'Steel', [PAINT]: 'Paint' })[id] ?? ''
const avg = (id: number): number => ({ [STEEL]: 15000, [PAINT]: 33333 })[id] ?? 0

describe('manufacture mode state ⇄ payload', () => {
  const made = (over: Partial<ReturnType<typeof emptyManufactureState>> = {}): Voucher => {
    const r = buildManufacturePayload(
      { ...emptyManufactureState('2025-05-03'), number: 'SJ-1', producedId: CHAIR, qtyText: '3', extraPctText: '12.5', ...over },
      { voucherTypeId: 9, bom: BOM, avgCost: avg, itemName: names }
    )
    if (!r.ok) throw new Error(r.error)
    return stored(r.payload)
  }

  it('reconstructs produced item, qty, overhead % and the saved rates; rebuild is identical', () => {
    const v = made()
    expect(v.narration).toBe('Manufactured 3 × Chair')
    const rep = manufactureRepresentation(v, { bomFor: () => BOM, itemName: names })
    if (!rep.ok) throw new Error(rep.reason)
    expect(rep.state).toMatchObject({ producedId: CHAIR, qtyText: '3', extraPctText: '12.5', autoNarration: true, frozenRates: { [STEEL]: 15000, [PAINT]: 33333 } })
  })

  it('a qty change on a loaded journal re-uses the saved component rates, not today\'s average', () => {
    const v = made()
    const rep = manufactureRepresentation(v, { bomFor: () => BOM, itemName: names })
    if (!rep.ok) throw new Error(rep.reason)
    const r = buildManufacturePayload({ ...rep.state, qtyText: '4' }, { voucherTypeId: 9, bom: BOM, avgCost: () => 1, itemName: names })
    if (!r.ok) throw new Error(r.error)
    expect(r.payload.inventory.map((l) => [l.stockItemId, l.qtyMilli, l.ratePaise])).toEqual([[PAINT, 1000, 33333], [STEEL, 8000, 15000], [CHAIR, 4000, expect.any(Number)]])
    expect(r.payload.narration).toBe('Manufactured 4 × Chair')
    expect(r.payload.number).toBe('SJ-1')
  })

  it('keeps godown/batch on components and on the produced line, and a custom narration', () => {
    const v = made()
    v.inventory[0]!.batchId = 5
    v.inventory[2]!.godownId = 2
    v.narration = 'Batch run #4'
    const rep = manufactureRepresentation(v, { bomFor: () => BOM, itemName: names })
    expect(rep.ok).toBe(true)
  })

  it('transfers, a changed BOM, ledger lines, absolute lines are not manufacture', () => {
    const transfer = stored({
      ...voucherToPayload(made()),
      inventory: [
        { stockItemId: STEEL, godownId: 1, batchId: null, qtyMilli: 1000, ratePaise: 100, discountPaise: 0, amount: 100, direction: 'out', isAbsolute: false },
        { stockItemId: STEEL, godownId: 2, batchId: null, qtyMilli: 1000, ratePaise: 100, discountPaise: 0, amount: 100, direction: 'in', isAbsolute: false }
      ]
    })
    expect(manufactureRepresentation(transfer, { bomFor: () => undefined, itemName: names }).ok).toBe(false)
    expect(manufactureRepresentation(made(), { bomFor: () => [BOM[1]!], itemName: names }).ok).toBe(false)
    expect(manufactureRepresentation(made(), { bomFor: () => [{ ...BOM[0]!, qtyMilliPerUnit: 300 }, BOM[1]!], itemName: names }).ok).toBe(false)
    const withLedger = made()
    withLedger.lines = [{ id: 1, ledgerId: EXPENSE, drCr: 'dr', amount: 1, bankDate: null, costAllocations: [] }]
    expect(manufactureRepresentation(withLedger, { bomFor: () => BOM, itemName: names }).ok).toBe(false)
  })
})

// ---------- physical stock ----------

describe('physical stock mode state ⇄ payload', () => {
  const counted = (): Voucher => {
    const r = buildPhysicalPayload(
      {
        ...emptyPhysicalState('2025-05-04'), number: 'PS-1', narration: 'Year-end count',
        rows: [
          { itemId: STEEL, qtyText: '12.25', godownId: 2, batchId: 7 },
          { itemId: PAINT, qtyText: '0', godownId: null, batchId: null },
          { itemId: null, qtyText: '', godownId: null, batchId: null }
        ]
      },
      { voucherTypeId: 10, itemName: names }
    )
    if (!r.ok) throw new Error(r.error)
    return stored(r.payload)
  }

  it('round-trips counts (including a zero count), godown and batch', () => {
    const v = counted()
    expect(v.inventory.every((l) => l.isAbsolute && l.direction === 'in')).toBe(true)
    const rep = physicalRepresentation(v, { itemName: names })
    if (!rep.ok) throw new Error(rep.reason)
    expect(rep.state.rows).toEqual([
      { itemId: STEEL, qtyText: '12.25', godownId: 2, batchId: 7 },
      { itemId: PAINT, qtyText: '0', godownId: null, batchId: null }
    ])
  })

  it('valued lines, movement lines or a twice-counted item are not representable', () => {
    const a = counted()
    a.inventory[0]!.ratePaise = 5
    expect(physicalRepresentation(a, { itemName: names }).ok).toBe(false)
    const b = counted()
    b.inventory[0]!.isAbsolute = false
    expect(physicalRepresentation(b, { itemName: names }).ok).toBe(false)
    const c = counted()
    c.inventory[1]!.stockItemId = STEEL
    expect(physicalRepresentation(c, { itemName: names })).toMatchObject({ ok: false, reason: 'Steel is counted twice' })
  })
})

// ---------- generic stock lines ----------

describe('generic stock-lines editor', () => {
  it('is lossless for any stock voucher, ledger lines and all', () => {
    const v = stored({
      voucherTypeId: 9, date: '2025-05-05', number: 'SJ-T', partyLedgerId: null, narration: 'Godown transfer',
      reference: 'TR-1', instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null, isOptional: true,
      lines: [
        { ledgerId: EXPENSE, drCr: 'dr', amount: 500, costAllocations: [{ costCentreId: 1, amount: 500 }] },
        { ledgerId: BANK, drCr: 'cr', amount: 500, costAllocations: [] }
      ],
      inventory: [
        { stockItemId: STEEL, godownId: 1, batchId: 3, qtyMilli: 1000, ratePaise: 100, discountPaise: 7, amount: 93, direction: 'out', isAbsolute: false },
        { stockItemId: STEEL, godownId: 2, batchId: 3, qtyMilli: 1000, ratePaise: 100, discountPaise: 0, amount: 100, direction: 'in', isAbsolute: false },
        { stockItemId: PAINT, godownId: null, batchId: null, qtyMilli: 0, ratePaise: 0, discountPaise: 0, amount: 0, direction: 'in', isAbsolute: true }
      ],
      billRefs: [], tds: null
    })
    const r = buildStockLinesPayload(stockLinesStateFromVoucher(v), { voucherTypeId: 9 })
    if (!r.ok) throw new Error(r.error)
    expect(diffPayloads(r.payload, voucherToPayload(v))).toEqual([])
  })
})

// ---------- routing ----------

describe('planVoucherEdit routes a saved voucher to the mode that creates its kind', () => {
  const ctx: EditPlanContext = { invoice: baseCtx, taxLedgers: TAX, bomFor: () => BOM, itemName: names }

  it('new-voucher modes by kind', () => {
    expect(modeForKind('sales')).toBe('invoice')
    expect(modeForKind('debit_note')).toBe('invoice')
    expect(modeForKind('stock_journal')).toBe('manufacture')
    expect(modeForKind('physical_stock')).toBe('physical')
    expect(modeForKind('payment')).toBe('accounting')
  })

  it('invoice when representable, accounting (with reason) otherwise', () => {
    const v = stored(built(buildInvoicePayload(invoiceState(), ctxFor('sales'), 1, TAX)))
    expect(planVoucherEdit(v, 'sales', ctx).mode).toBe('invoice')
    v.inventory[0]!.amount += 1
    const plan = planVoucherEdit(v, 'sales', ctx)
    expect(plan).toMatchObject({ mode: 'accounting', fallbackReason: expect.any(String) })
  })

  it('stock journal → manufacture or the generic stock-lines editor; physical → physical or stock lines', () => {
    const r = buildManufacturePayload(
      { ...emptyManufactureState('2025-05-03'), producedId: CHAIR, qtyText: '1' },
      { voucherTypeId: 9, bom: BOM, avgCost: avg, itemName: names }
    )
    if (!r.ok) throw new Error(r.error)
    const sj = stored(r.payload)
    expect(planVoucherEdit(sj, 'stock_journal', ctx).mode).toBe('manufacture')
    expect(planVoucherEdit(sj, 'stock_journal', { ...ctx, bomFor: () => undefined }).mode).toBe('stockLines')
    const ps = buildPhysicalPayload({ ...emptyPhysicalState('2025-05-04'), rows: [{ itemId: STEEL, qtyText: '1', godownId: null, batchId: null }] }, { voucherTypeId: 10, itemName: names })
    if (!ps.ok) throw new Error(ps.error)
    const pv = stored(ps.payload)
    expect(planVoucherEdit(pv, 'physical_stock', ctx).mode).toBe('physical')
    pv.inventory[0]!.amount = 5
    expect(planVoucherEdit(pv, 'physical_stock', ctx).mode).toBe('stockLines')
  })

  it('everything else → accounting without a fallback banner', () => {
    const v = stored({
      voucherTypeId: 2, date: '2025-05-01', number: 'P-1', partyLedgerId: null, narration: null, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
      posOverride: null, currencyCode: null, exchangeRate: null,
      lines: [{ ledgerId: EXPENSE, drCr: 'dr', amount: 1, costAllocations: [] }, { ledgerId: BANK, drCr: 'cr', amount: 1, costAllocations: [] }],
      inventory: [], billRefs: [], tds: null
    })
    expect(planVoucherEdit(v, 'payment', ctx)).toMatchObject({ mode: 'accounting', fallbackReason: null })
  })
})

// ---------- TDS in both entry modes (WP 3.1) ----------

describe('TDS on a purchase invoice', () => {
  const VENDOR = 12
  const PURCHASE = 22
  const PAYABLE = 50 // tagged TDS payable for section 3
  const SECTION = 3
  const purchaseCtx: InvoiceContext = {
    ...baseCtx,
    kind: 'purchase',
    ledgers: new Map([
      ...baseCtx.ledgers,
      [VENDOR, { stateCode: '27', gstRate: null }],
      [PURCHASE, { stateCode: null, gstRate: null }],
      [PAYABLE, { stateCode: null, gstRate: null, tdsPayableSectionId: SECTION }]
    ])
  }
  const bill = (tds: InvoiceFormState['tds']): InvoiceFormState =>
    invoiceState({ partyId: VENDOR, accountId: PURCHASE, number: 'P-1', billName: 'P-1', vehicleNo: '', transporterId: '', distanceKm: '', tds })

  it('reduces the vendor credit, credits the payable ledger last, and the bill ref follows the vendor line', () => {
    const plain = built(buildInvoicePayload(bill(null), purchaseCtx, 2, TAX))
    const total = plain.lines[0]!.amount
    const taxable = computeInvoice(bill(null), purchaseCtx).gst.taxable
    const tds = { sectionId: SECTION, baseAmount: taxable, tdsAmount: 1000, isManual: false, payableLedgerId: PAYABLE, pending: false }
    const p = built(buildInvoicePayload(bill(tds), purchaseCtx, 2, TAX))
    expect(p.lines[0]).toMatchObject({ ledgerId: VENDOR, drCr: 'cr', amount: total - 1000 })
    expect(p.lines[p.lines.length - 1]).toMatchObject({ ledgerId: PAYABLE, drCr: 'cr', amount: 1000 })
    expect(p.billRefs[0]!.amount).toBe(total - 1000)
    expect(p.tds).toEqual({ sectionId: SECTION, baseAmount: taxable, tdsAmount: 1000, isManual: false, autoPayable: false })
    const dr = p.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = p.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
  })

  it('pending (no payable ledger yet): no payable line, autoPayable for the server to add', () => {
    const tds = { sectionId: SECTION, baseAmount: 100, tdsAmount: 1000, isManual: false, payableLedgerId: null, pending: true }
    const p = built(buildInvoicePayload(bill(tds), purchaseCtx, 2, TAX))
    expect(p.lines.some((l) => l.ledgerId === PAYABLE)).toBe(false)
    expect(p.tds!.autoPayable).toBe(true)
  })

  it('round-trips: a saved purchase with TDS opens in invoice mode, identical on save', () => {
    const tds = { sectionId: SECTION, baseAmount: 5000, tdsAmount: 1000, isManual: true, payableLedgerId: PAYABLE, pending: false }
    const v = stored(built(buildInvoicePayload(bill(tds), purchaseCtx, 2, TAX)))
    const rep = invoiceRepresentation(v, purchaseCtx, TAX)
    if (!rep.ok) throw new Error(rep.reason)
    expect(rep.state.tds).toEqual(tds)
    expect(diffPayloads(built(buildInvoicePayload(rep.state, purchaseCtx, 2, TAX)), voucherToPayload(v))).toEqual([])
  })

  it('falls back to accounting mode when the payable credit is not the tagged last line, or on a sales invoice', () => {
    const tds = { sectionId: SECTION, baseAmount: 5000, tdsAmount: 1000, isManual: false, payableLedgerId: PAYABLE, pending: false }
    const v = stored(built(buildInvoicePayload(bill(tds), purchaseCtx, 2, TAX)))
    const untagged = { ...purchaseCtx, ledgers: new Map([...purchaseCtx.ledgers, [PAYABLE, { stateCode: null, gstRate: null }]]) }
    expect(invoiceRepresentation(v, untagged, TAX)).toMatchObject({ ok: false, reason: expect.stringContaining('TDS payable') })
    const wrongSection = { ...v, tds: { ...v.tds!, sectionId: 99 } }
    expect(invoiceRepresentation(wrongSection, purchaseCtx, TAX).ok).toBe(false)
    expect(buildInvoicePayload(invoiceState({ tds }), ctxFor('sales'), 1, TAX)).toMatchObject({ ok: false })
    const plan = planVoucherEdit(v, 'purchase', { invoice: purchaseCtx, taxLedgers: TAX, bomFor: () => undefined, itemName: () => '' })
    expect(plan.mode).toBe('invoice')
  })

  it('isManual is part of the comparison', () => {
    const tds = { sectionId: SECTION, baseAmount: 5000, tdsAmount: 1000, isManual: false, payableLedgerId: PAYABLE, pending: false }
    const p = built(buildInvoicePayload(bill(tds), purchaseCtx, 2, TAX))
    expect(diffPayloads({ ...p, tds: { ...p.tds!, isManual: true } }, p)).toEqual(['tds.isManual'])
  })
})

describe('TDS in accounting mode', () => {
  const VENDOR = 12
  const PAYABLE = 50
  type Row = { drCr: 'dr' | 'cr'; ledgerId: number | null; amount: number | null; tag?: string }
  const make = (ledgerId: number, amount: number): Row => ({ drCr: 'cr', ledgerId, amount, tag: 'new' })
  const payment = (): Row[] => [
    { drCr: 'dr', ledgerId: VENDOR, amount: 5000000 },
    { drCr: 'cr', ledgerId: BANK, amount: 5000000 },
    { drCr: 'cr', ledgerId: null, amount: null }
  ]

  it('fresh apply: the target gives up the deduction and the payable row goes before the trailing blank', () => {
    const out = applyTdsToAccountingRows(payment(), { targetIdx: 1, tdsAmount: 100000, payableLedgerId: PAYABLE, previous: null, makeRow: make })
    expect(out.map((r) => [r.ledgerId, r.amount])).toEqual([[VENDOR, 5000000], [BANK, 4900000], [PAYABLE, 100000], [null, null]])
  })

  it('re-apply adjusts the existing payable credit by the difference', () => {
    const first = applyTdsToAccountingRows(payment(), { targetIdx: 1, tdsAmount: 100000, payableLedgerId: PAYABLE, previous: null, makeRow: make })
    const prev = { sectionId: 1, baseAmount: 5000000, tdsAmount: 100000, isManual: false, payableLedgerId: PAYABLE, pending: false }
    const again = applyTdsToAccountingRows(first, { targetIdx: 1, tdsAmount: 120000, payableLedgerId: PAYABLE, previous: prev, makeRow: make })
    expect(again.map((r) => [r.ledgerId, r.amount])).toEqual([[VENDOR, 5000000], [BANK, 4880000], [PAYABLE, 120000], [null, null]])
    expect(appliedTdsAmount(again, { ...prev, tdsAmount: 120000 })).toBe(120000)
  })

  it('pending: no payable row; re-apply moves the target by the delta; the credit counts as applied', () => {
    const pendingOut = applyTdsToAccountingRows(payment(), { targetIdx: 1, tdsAmount: 100000, payableLedgerId: null, previous: null, makeRow: make })
    expect(pendingOut.map((r) => [r.ledgerId, r.amount])).toEqual([[VENDOR, 5000000], [BANK, 4900000], [null, null]])
    const prev = { sectionId: 1, baseAmount: 5000000, tdsAmount: 100000, isManual: false, payableLedgerId: null, pending: true }
    expect(appliedTdsAmount(pendingOut, prev)).toBe(100000)
    const again = applyTdsToAccountingRows(pendingOut, { targetIdx: 1, tdsAmount: 150000, payableLedgerId: null, previous: prev, makeRow: make })
    expect(again[1]!.amount).toBe(4850000)
    // The ledger exists by now: the credit materialises as a row.
    const real = applyTdsToAccountingRows(pendingOut, { targetIdx: 1, tdsAmount: 100000, payableLedgerId: PAYABLE, previous: prev, makeRow: make })
    expect(real.map((r) => [r.ledgerId, r.amount])).toEqual([[VENDOR, 5000000], [BANK, 4900000], [PAYABLE, 100000], [null, null]])
  })

  it('tdsStateFromSaved finds the payable credit by tag, else by amount', () => {
    const rows: Row[] = [
      { drCr: 'dr', ledgerId: EXPENSE, amount: 10000 },
      { drCr: 'cr', ledgerId: VENDOR, amount: 9000 },
      { drCr: 'cr', ledgerId: PAYABLE, amount: 1000 }
    ]
    const saved = { sectionId: 3, baseAmount: 10000, tdsAmount: 1000, isManual: true }
    expect(tdsStateFromSaved(saved, rows, VENDOR, (id) => (id === PAYABLE ? 3 : null))).toEqual({ ...saved, payableLedgerId: PAYABLE, pending: false })
    expect(tdsStateFromSaved(saved, rows, VENDOR, () => null).payableLedgerId).toBe(PAYABLE)
  })

  it('the accounting payload carries isManual / autoPayable', () => {
    const r = buildAccountingPayload(
      {
        date: '2025-05-01', number: '', narration: '', instrumentNo: '', billRefs: [], advanceReceipt: false, optional: false, original: null,
        tds: { sectionId: 1, baseAmount: 5000000, tdsAmount: 100000, autoPayable: true },
        rows: [
          { drCr: 'dr', ledgerId: VENDOR, amount: 5000000, costAllocations: [] },
          { drCr: 'cr', ledgerId: BANK, amount: 4900000, costAllocations: [] }
        ]
      },
      { kind: 'payment', voucherTypeId: 3, derivedPartyId: VENDOR }
    )
    expect(r.ok && r.payload.tds).toEqual({ sectionId: 1, baseAmount: 5000000, tdsAmount: 100000, isManual: false, autoPayable: true })
  })
})
