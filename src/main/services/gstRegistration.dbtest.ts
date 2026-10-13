// WP 8.0 — only a regular GST registration charges GST on a bill (shared/gst/registration.ts):
// new sales / purchase / note saves with tax lines in a composition or unregistered company are
// refused with a plain message; an alteration of a voucher that already carried tax keeps it;
// counter billing posts no tax and prints a "Bill of supply"; imports restore history as it was.
import { describe, it, expect } from 'vitest'
import { autoPlan, parseImportFile } from './importFiles'
import { runImport, undoImport } from './dataImport'
import { createLedger } from './masters'
import { computeInvoice, emptyInvoiceState } from '@shared/voucherEdit'
import { gstRegistrationOf, nextRegistrationFacts } from '@shared/gst/registration'
import { pricingFixture, imbalance } from './pricingFixture.testutil'
import { TEST_INFO } from '../db/testdb'
import { writeCompanyInfo } from '../db/seed'
import { getVoucher, saveVoucher } from './vouchers'
import { counterCheckout, counterQuote } from './counter'
import { documentHtml, getTemplate } from './printTemplates'
import { extractOutwardDocs, gstr3b } from './gst'
import type { CompanyInfo } from '@shared/domain'
import type { DB } from '../db/connection'
import type { VoucherInput } from '@shared/schemas'

const DATE = '2025-10-07'
const typeId = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
const ledgerId = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id

/** A hand-built sales invoice: 1 pen for ₹100 + CGST / SGST ₹9 each (accounting-mode shape). */
function taxedSale(db: DB, partyId: number, kind = 'sales'): VoucherInput {
  const out = kind === 'sales' || kind === 'credit_note' ? 'cr' : 'dr'
  const party = out === 'cr' ? 'dr' : 'cr'
  return {
    voucherTypeId: typeId(db, kind), date: DATE, partyLedgerId: partyId, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: partyId, drCr: party, amount: 11800, costAllocations: [] },
      { ledgerId: ledgerId(db, 'Sales A/c'), drCr: out, amount: 10000, costAllocations: [] },
      { ledgerId: ledgerId(db, 'CGST Output'), drCr: out, amount: 900, costAllocations: [] },
      { ledgerId: ledgerId(db, 'SGST Output'), drCr: out, amount: 900, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  }
}

function as(db: DB, type: CompanyInfo['gstRegistrationType']): CompanyInfo {
  const info = { ...TEST_INFO, gstRegistrationType: type }
  writeCompanyInfo(db, info)
  return info
}

describe('WP 8.0 registration rule at save', () => {
  for (const type of ['unregistered', 'composition'] as const) {
    it(`${type}: a new sale / purchase / note with tax lines is refused with a plain message`, () => {
      const { db, umbrella } = pricingFixture()
      as(db, type)
      const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
      const before = count()
      for (const kind of ['sales', 'purchase', 'credit_note', 'debit_note']) {
        expect(() => saveVoucher(db, taxedSale(db, umbrella, kind))).toThrow(type === 'composition' ? /composition scheme.*can’t charge GST/ : /not registered for GST.*can’t charge GST/)
      }
      expect(count()).toBe(before)
      // The same supply without tax lines saves.
      const plain = taxedSale(db, umbrella)
      plain.lines = [plain.lines[0]!, plain.lines[1]!].map((l, i) => ({ ...l, amount: i === 0 ? 10000 : 10000 }))
      expect(saveVoucher(db, plain).id).toBeGreaterThan(0)
    })
  }

  it('an alteration of a voucher saved with tax before the rule keeps its tax; adding tax to an untaxed one is refused', () => {
    const { db, umbrella } = pricingFixture()
    const legacy = saveVoucher(db, taxedSale(db, umbrella)) // saved while regular
    const plainInput = taxedSale(db, umbrella)
    plainInput.lines = [{ ...plainInput.lines[0]!, amount: 10000 }, plainInput.lines[1]!]
    const plain = saveVoucher(db, plainInput)
    as(db, 'unregistered')
    // Re-saving the legacy voucher (narration edited) passes and keeps its tax lines.
    const again = saveVoucher(db, { ...taxedSale(db, umbrella), narration: 'edited' }, legacy.id)
    expect(getVoucher(db, again.id)!.lines.filter((l) => l.ledgerId === ledgerId(db, 'CGST Output'))).toHaveLength(1)
    expect(() => saveVoucher(db, taxedSale(db, umbrella), plain.id)).toThrow(/not registered for GST/)
  })

  it('a payment to a GST ledger (an old liability) and a regular company are untouched; imports restore history', () => {
    const { db, umbrella, bank } = pricingFixture()
    expect(saveVoucher(db, taxedSale(db, umbrella)).id).toBeGreaterThan(0) // regular: unchanged
    as(db, 'unregistered')
    const pay = saveVoucher(db, {
      ...taxedSale(db, umbrella), voucherTypeId: typeId(db, 'payment'), partyLedgerId: null,
      lines: [{ ledgerId: ledgerId(db, 'CGST Output'), drCr: 'dr', amount: 900, costAllocations: [] }, { ledgerId: bank, drCr: 'cr', amount: 900, costAllocations: [] }]
    })
    expect(pay.id).toBeGreaterThan(0)
    expect(saveVoucher(db, taxedSale(db, umbrella), undefined, { historicImport: true }).id).toBeGreaterThan(0)
  })
})

describe('WP 8.0 counter billing and print', () => {
  it('an unregistered counter sale charges no GST and prints a Bill of supply', () => {
    const { db, pen, tea } = pricingFixture() // pen 18%, tea 12% + 12% cess in the item master
    const info = as(db, 'unregistered')
    const lines = [{ itemId: pen, qtyMilli: 3000, ratePaise: 1099, discountPaise: 0 }, { itemId: tea, qtyMilli: 1000, ratePaise: 4750, discountPaise: 250 }]
    const quote = counterQuote(db, info, { date: DATE, lines })
    expect(quote).toMatchObject({ taxable: 7797, cgst: 0, sgst: 0, igst: 0, cess: 0 })
    expect(quote.total).toBe(7800) // 77.97 → ₹78
    const r = counterCheckout(db, info, { date: DATE, lines, payments: [{ mode: 'cash', amountPaise: 7800 }] })
    const inv = getVoucher(db, r.invoiceId)!
    expect(imbalance(db, inv.id)).toBe(0)
    const taxIds = (db.prepare("SELECT id FROM ledgers WHERE tax_type IS NOT NULL").all() as { id: number }[]).map((x) => x.id)
    expect(inv.lines.some((l) => taxIds.includes(l.ledgerId))).toBe(false)
    const a4 = documentHtml(db, info, inv.id, getTemplate(db, 'classic')).html
    // Rule 49 is for registered persons: an unregistered business prints a plain INVOICE, with no
    // GST column, tax table, CGST / SGST rows, place of supply or "this invoice" declaration.
    expect(a4).toContain('<b>INVOICE</b>')
    expect(a4).not.toMatch(/TAX INVOICE|BILL OF SUPPLY|print-composition-note/)
    expect(a4).toContain('78.00') // the voucher's total — the print computes no GST from the item master
    expect(a4).not.toContain('5.67')
    expect(a4).not.toMatch(/GST %|GST rate|HSN\/SAC|>CGST<|>SGST<|Place of supply|this invoice/i)
    const roll = documentHtml(db, info, inv.id, getTemplate(db, 'receipt-80mm')).html
    expect(roll).toContain('>INVOICE<')
    expect(roll).not.toMatch(/TAX INVOICE|Taxable value|<th>GST<\/th>|CGST/)
    expect(roll).toContain('Subtotal')
    // GSTR-3B: the item master's 18% never applies — nothing is owed.
    const ret = gstr3b(db, info, '2025-10-01', '2025-10-31', '102025')
    expect(ret.outward).toMatchObject({ cgst: 0, sgst: 0, igst: 0, cess: 0 })
    expect(ret.netPayable).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
  })

  it('GSTR-3B still reports a legacy taxed sale after the company became unregistered', () => {
    const { db, pen } = pricingFixture()
    counterCheckout(db, TEST_INFO, { date: DATE, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 10000 }], payments: [{ mode: 'cash', amountPaise: 11800 }] })
    const info = as(db, 'unregistered')
    expect(gstr3b(db, info, '2025-10-01', '2025-10-31', '102025').outward).toMatchObject({ cgst: 900, sgst: 900 })
  })

  it('a composition sale prints Bill of supply with the rule 5 declaration; a regular one stays a Tax invoice', () => {
    const { db, pen } = pricingFixture()
    const regular = counterCheckout(db, TEST_INFO, { date: DATE, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 10000 }], payments: [{ mode: 'cash', amountPaise: 11800 }] })
    expect(documentHtml(db, TEST_INFO, regular.invoiceId, getTemplate(db, 'classic')).html).toContain('TAX INVOICE')
    const info = as(db, 'composition')
    const r = counterCheckout(db, info, { date: DATE, lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 10000 }], payments: [{ mode: 'cash', amountPaise: 10000 }] })
    expect(r.totalPaise).toBe(10000)
    const html = documentHtml(db, info, r.invoiceId, getTemplate(db, 'classic')).html
    expect(html).toContain('BILL OF SUPPLY')
    expect(html).not.toMatch(/>CGST<|>SGST<|Place of supply|this invoice/i)
    expect(html).toContain('Composition taxable person, not eligible to collect tax on supplies')
  })
})

describe('WP 8.0 the registration is effective-dated (the voucher date decides)', () => {
  /** Regular until 30 Sep 2025, composition from 1 Oct 2025. */
  const switchToComposition = (db: DB): CompanyInfo => {
    const info: CompanyInfo = { ...TEST_INFO, ...nextRegistrationFacts(TEST_INFO, 'composition', '2025-10-01', '2025-10-13') }
    writeCompanyInfo(db, info)
    return info
  }

  it('records the previous type and the date; an unchanged type keeps the history', () => {
    const f = nextRegistrationFacts(TEST_INFO, 'composition', '2025-10-01', '2025-10-13')
    expect(f).toEqual({ gstRegistrationType: 'composition', gstRegistrationSince: '2025-10-01', gstPreviousRegistrationType: 'regular' })
    expect(nextRegistrationFacts({ ...TEST_INFO, ...f }, 'composition', '2026-01-01', '2026-01-02')).toEqual(f)
    expect(nextRegistrationFacts(TEST_INFO, 'unregistered', null, '2025-10-13').gstRegistrationSince).toBe('2025-10-13')
  })

  it('a late bill of the regular months keeps its GST; one dated after the switch is refused', () => {
    const { db, umbrella } = pricingFixture()
    switchToComposition(db)
    expect(saveVoucher(db, { ...taxedSale(db, umbrella), date: '2025-09-20' }).id).toBeGreaterThan(0)
    expect(() => saveVoucher(db, { ...taxedSale(db, umbrella), date: '2025-10-07' })).toThrow(/composition scheme/)
  })

  it('a credit note after the switch, against a taxed invoice of the regular months, keeps its GST (s.34)', () => {
    const { db, umbrella } = pricingFixture()
    saveVoucher(db, { ...taxedSale(db, umbrella), date: '2025-09-10', billRefs: [{ kind: 'new', name: 'INV-9', amount: 11800, dueDate: null }] })
    switchToComposition(db)
    const note = { ...taxedSale(db, umbrella, 'credit_note'), date: '2025-10-07' }
    expect(() => saveVoucher(db, note)).toThrow(/composition scheme/) // not set against anything
    const id = saveVoucher(db, { ...note, billRefs: [{ kind: 'against', name: 'INV-9', amount: 11800, dueDate: null }] }).id
    expect(getVoucher(db, id)!.lines.some((l) => l.ledgerId === ledgerId(db, 'CGST Output'))).toBe(true)
  })

  it('the editor computes a regular-period bill (and a note against one) with GST after the switch', () => {
    const { db, pen } = pricingFixture()
    const info = switchToComposition(db)
    const ctx = { kind: 'sales' as const, companyStateCode: '27', ...gstRegistrationOf(info), items: new Map([[pen, { gstRate: 18, cessRate: null }]]), ledgers: new Map() }
    const rows = [{ itemId: pen, qtyText: '1', rate: 10_000, discount: null, godownId: null, batchId: null }]
    expect(computeInvoice({ ...emptyInvoiceState('2025-09-30'), rows }, ctx).gst.cgst).toBe(900)
    expect(computeInvoice({ ...emptyInvoiceState('2025-10-01'), rows }, ctx).gst.cgst).toBe(0)
    expect(computeInvoice({ ...emptyInvoiceState('2025-10-01'), rows, taxedOriginal: true }, { ...ctx, kind: 'credit_note' }).gst.cgst).toBe(900)
  })

  it('GSTR-3B of the regular months is unchanged by the switch — an export under LUT keeps its rate', () => {
    const { db, pen } = pricingFixture()
    const exporter = createLedger(db, {
      name: 'Overseas Buyer', groupId: (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id, openingBalance: 0,
      gstin: null, stateCode: '96', address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: 'exp_wop'
    }).id
    saveVoucher(db, {
      ...taxedSale(db, exporter), date: '2025-09-12',
      lines: [{ ledgerId: exporter, drCr: 'dr', amount: 10000, costAllocations: [] }, { ledgerId: ledgerId(db, 'Sales A/c'), drCr: 'cr', amount: 10000, costAllocations: [] }],
      inventory: [{ stockItemId: pen, godownId: null, batchId: null, qtyMilli: 1000, ratePaise: 10000, discountPaise: 0, amount: 10000, direction: 'out' }]
    })
    const sep = (info: CompanyInfo) => gstr3b(db, info, '2025-09-01', '2025-09-30', '092025')
    const before = sep(TEST_INFO)
    expect(before.zeroRated.taxable).toBe(10000)
    const docsBefore = extractOutwardDocs(db, TEST_INFO, '2025-09-01', '2025-09-30')
    expect(docsBefore[0]!.items.map((i) => i.rate)).toEqual([18])
    const info = switchToComposition(db)
    const after = sep(info)
    expect(after.zeroRated).toEqual(before.zeroRated)
    expect(after.nilExempt).toEqual(before.nilExempt)
    // Still rated at 18% (zero-rated under LUT), not turned into a nil-rated supply.
    expect(extractOutwardDocs(db, info, '2025-09-01', '2025-09-30')).toEqual(docsBefore)
  })
})

describe('WP 8.0 undo restores the earlier version exactly', () => {
  it('an import that replaced a taxed sale is undone in an unregistered company', () => {
    const { db, umbrella } = pricingFixture()
    const v = saveVoucher(db, { ...taxedSale(db, umbrella), number: 'S-1' }) // regular: taxed
    as(db, 'unregistered')
    const csv = 'Voucher Type,Date,Number,Party,Ledger,Debit,Credit,Narration\nSales,2025-10-07,S-1,Umbrella Retail,Umbrella Retail,100,,changed\n,,,,Sales A/c,,100,'
    const f = parseImportFile('x.csv', new TextEncoder().encode(csv))
    const { steps, profile } = autoPlan(db, f, '27', {})
    const r = runImport(db, steps, { duplicate: 'update' }, { source: profile.source, profileId: profile.id, fileName: 'x.csv' }, false)
    expect(r.steps[0]).toMatchObject({ updated: 1 })
    expect(getVoucher(db, v.id)!.lines).toHaveLength(2)
    expect(undoImport(db, r.batchId!)).toMatchObject({ restored: 1, kept: [] })
    expect(getVoucher(db, v.id)!.lines.filter((l) => l.ledgerId === ledgerId(db, 'CGST Output'))).toHaveLength(1)
  })
})
