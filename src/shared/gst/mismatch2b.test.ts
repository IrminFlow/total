import { describe, expect, it } from 'vitest'
import { reconcile2b, type PortalInvoice, type PurchaseDoc } from './recon2b'
import { categoriseMismatches, planLines, summariseMismatches, supplierFor } from './mismatch2b'

const OPTS = { amountTolerancePaise: 100, dateWindowDays: 7 }
const G1 = '27AAAAA0000A1Z5'
const G2 = '29BBBBB1111B1Z3'

const portal = (p: Partial<PortalInvoice> & { number: string }): PortalInvoice => ({
  gstin: G1, date: '2026-05-10', value: 11800_00, taxable: 10000_00, igst: 0, cgst: 900_00, sgst: 900_00, cess: 0, kind: 'b2b', ...p
})
let vid = 100
const book = (b: Partial<PurchaseDoc> & { supplierRef: string }): PurchaseDoc => ({
  voucherId: ++vid, kind: 'purchase', date: '2026-05-10', number: `P-${vid}`, partyLedgerId: 7, partyName: 'Acme Supplies', partyGstin: G1,
  invoiceValue: 11800_00, taxable: 10000_00, igst: 0, cgst: 900_00, sgst: 900_00, cess: 0, ...b
})
const LEDGERS = [
  { ledgerId: 7, name: 'Acme Supplies', gstin: G1 },
  { ledgerId: 8, name: 'Beta Traders', gstin: null }
]

describe('categoriseMismatches', () => {
  it('missing in books → a purchase draft plan from the 2B figures, party matched by GSTIN', () => {
    const p = portal({ number: 'A-55' })
    const r = reconcile2b([p], [], OPTS)
    const [m] = categoriseMismatches(r, [], LEDGERS, OPTS)
    expect(m).toMatchObject({ category: 'missing_in_books', ledgerId: 7, supplier: 'Acme Supplies' })
    const draft = m!.actions.find((a) => a.kind === 'draft')
    expect(draft).toMatchObject({ kind: 'draft', plan: { kind: 'purchase', date: '2026-05-10', partyLedgerId: 7, reference: 'A-55', split: { taxable: 10000_00, cgst: 900_00, sgst: 900_00, igst: 0, cess: 0 } } })
  })

  it('missing in books from an unknown GSTIN → create the ledger first (no draft)', () => {
    const r = reconcile2b([portal({ number: 'Z-1', gstin: '07CCCCC2222C1Z9' })], [], OPTS)
    const [m] = categoriseMismatches(r, [], LEDGERS, OPTS)
    expect(m!.actions.map((a) => a.kind)).toEqual(['create_ledger'])
  })

  it('missing in 2B → follow up the supplier, no ITC yet', () => {
    const b = book({ supplierRef: 'B-9' })
    const r = reconcile2b([], [b], OPTS)
    const [m] = categoriseMismatches(r, [], LEDGERS, OPTS)
    expect(m).toMatchObject({ category: 'missing_in_2b', key: `missing_in_2b:${b.voucherId}` })
    expect(m!.suggestion).toMatch(/not available until it appears in a GSTR-2B/)
    expect(m!.sources).toContain('rule36_4')
  })

  it('amount differs: books above 2B → debit note plan for the excess (books − 2B)', () => {
    const p = portal({ number: 'C-3', value: 11800_00 })
    const b = book({ supplierRef: 'C-3', invoiceValue: 12980_00, taxable: 11000_00, cgst: 990_00, sgst: 990_00 })
    const r = reconcile2b([p], [b], OPTS)
    const [m] = categoriseMismatches(r, [], LEDGERS, OPTS)
    expect(m!.category).toBe('amount_differs')
    expect(m!.valueDiff).toBe(-1180_00)
    const d = m!.actions.find((a) => a.kind === 'draft')
    expect(d).toMatchObject({ plan: { kind: 'debit_note', partyLedgerId: 7, split: { taxable: 1000_00, cgst: 90_00, sgst: 90_00, igst: 0, cess: 0 } } })
    expect(m!.suggestion).toMatch(/₹180.00 more tax than the supplier reported/)
  })

  it('amount differs: 2B above books → open the voucher, no draft', () => {
    const p = portal({ number: 'C-4', value: 12980_00, taxable: 11000_00, cgst: 990_00, sgst: 990_00 })
    const b = book({ supplierRef: 'C-4' })
    const [m] = categoriseMismatches(reconcile2b([p], [b], OPTS), [], LEDGERS, OPTS)
    expect(m!.actions.map((a) => a.kind)).toEqual(['open_voucher'])
  })

  it('period differs: the same invoice in the books in another month', () => {
    const p = portal({ number: 'INV/2026-27/0012', date: '2026-04-28' })
    const other = book({ supplierRef: 'INV-12', date: '2026-04-28' })
    const [m] = categoriseMismatches(reconcile2b([p], [], OPTS), [other], LEDGERS, OPTS)
    expect(m).toMatchObject({ category: 'period_differs', bookMonth: '2026-04', book: { voucherId: other.voucherId } })
    expect(m!.sources).toContain('rule60_7')
  })

  it('GSTIN differs: same number and value under another GSTIN in the books (pairs both sides)', () => {
    const p = portal({ number: 'D-77' })
    const b = book({ supplierRef: 'D-77', partyGstin: null, partyLedgerId: 8, partyName: 'Beta Traders' })
    const list = categoriseMismatches(reconcile2b([p], [b], OPTS), [], LEDGERS, OPTS)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ category: 'gstin_differs', ledgerId: 8 })
    expect(list[0]!.actions[0]).toMatchObject({ kind: 'open_ledger', ledgerId: 8, label: 'Add the supplier’s GSTIN' })
  })

  it('matched documents are not mismatches; the summary counts and taxes by category', () => {
    const r = reconcile2b([portal({ number: 'E-1' }), portal({ number: 'E-2' })], [book({ supplierRef: 'E-1' })], OPTS)
    const list = categoriseMismatches(r, [], LEDGERS, OPTS)
    expect(list.map((m) => m.category)).toEqual(['missing_in_books'])
    const s = summariseMismatches(list)
    expect(s.find((x) => x.category === 'missing_in_books')).toMatchObject({ count: 1, tax: 1800_00 })
    expect(s.find((x) => x.category === 'missing_in_2b')).toMatchObject({ count: 0, tax: 0 })
  })

  it('supplierFor needs exactly one ledger with the GSTIN', () => {
    expect(supplierFor(G1.toLowerCase(), LEDGERS)?.ledgerId).toBe(7)
    expect(supplierFor(G2, LEDGERS)).toBeNull()
    expect(supplierFor(G1, [...LEDGERS, { ledgerId: 9, name: 'Dup', gstin: G1 }])).toBeNull()
  })
})

describe('planLines', () => {
  const ids = { purchase: 20, igst: 21, cgst: 22, sgst: 23, cess: null }
  it('purchase: Dr purchase + taxes, Cr party (balanced, zero heads dropped)', () => {
    const lines = planLines({ kind: 'purchase', date: '2026-05-10', partyLedgerId: 7, reference: 'A', narration: 'n', split: { taxable: 1000_00, igst: 0, cgst: 90_00, sgst: 90_00, cess: 0 } }, ids)
    expect(lines).toEqual([
      { ledgerId: 20, drCr: 'dr', amount: 1000_00 },
      { ledgerId: 22, drCr: 'dr', amount: 90_00 },
      { ledgerId: 23, drCr: 'dr', amount: 90_00 },
      { ledgerId: 7, drCr: 'cr', amount: 1180_00 }
    ])
  })
  it('debit note: Dr party, Cr purchase + taxes; a missing tax ledger is reported', () => {
    const dn = planLines({ kind: 'debit_note', date: '2026-05-10', partyLedgerId: 7, reference: 'A', narration: 'n', split: { taxable: 100_00, igst: 18_00, cgst: 0, sgst: 0, cess: 0 } }, ids)
    expect(dn).toEqual([
      { ledgerId: 20, drCr: 'cr', amount: 100_00 },
      { ledgerId: 21, drCr: 'cr', amount: 18_00 },
      { ledgerId: 7, drCr: 'dr', amount: 118_00 }
    ])
    expect(planLines({ kind: 'purchase', date: '2026-05-10', partyLedgerId: 7, reference: 'A', narration: 'n', split: { taxable: 100_00, igst: 0, cgst: 0, sgst: 0, cess: 5_00 } }, ids)).toEqual({ missing: ['CESS'] })
  })
})
