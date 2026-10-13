// WP 8.0 — only a regular GST registration charges GST on a bill (shared/gst/registration.ts):
// new sales / purchase / note saves with tax lines in a composition or unregistered company are
// refused with a plain message; an alteration of a voucher that already carried tax keeps it;
// counter billing posts no tax and prints a "Bill of supply"; imports restore history as it was.
import { describe, it, expect } from 'vitest'
import { pricingFixture, imbalance } from './pricingFixture.testutil'
import { TEST_INFO } from '../db/testdb'
import { writeCompanyInfo } from '../db/seed'
import { getVoucher, saveVoucher } from './vouchers'
import { counterCheckout, counterQuote } from './counter'
import { documentHtml, getTemplate } from './printTemplates'
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
    expect(a4).toContain('BILL OF SUPPLY')
    expect(a4).not.toContain('TAX INVOICE')
    expect(a4).not.toContain('print-composition-note')
    const roll = documentHtml(db, info, inv.id, getTemplate(db, 'receipt-80mm')).html
    expect(roll).toContain('BILL OF SUPPLY')
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
    expect(html).toContain('Composition taxable person, not eligible to collect tax on supplies')
  })
})
