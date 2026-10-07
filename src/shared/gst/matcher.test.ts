// WP 3.4 — the GSTR-2B fuzzy matcher: invoice-number normalisation (case, leading zeros,
// separators, FY tokens, series prefixes), date tolerance, amount tolerance in paise and %,
// GSTIN exact.
import { describe, expect, it } from 'vitest'
import {
  invoiceNumberCore, invoiceSerial, normalizeGstin, normalizeInvoiceNumber, reconcile2b, recon2bOptionsFrom, toleranceFor,
  DEFAULT_RECON2B_TOLERANCES, type PortalInvoice, type PurchaseDoc
} from './recon2b'

const GSTIN = '27ABCDE1234F1Z5'
const portal = (o: Partial<PortalInvoice> = {}): PortalInvoice => ({
  gstin: GSTIN, number: 'INV-001', date: '2026-06-05', value: 118000, taxable: 100000, igst: 0, cgst: 9000, sgst: 9000, cess: 0, kind: 'b2b', ...o
})
const book = (o: Partial<PurchaseDoc> = {}): PurchaseDoc => ({
  voucherId: 1, kind: 'purchase', date: '2026-06-05', number: 'PUR/1', supplierRef: 'INV-001', partyName: 'Acme', partyGstin: GSTIN,
  invoiceValue: 118000, taxable: 100000, igst: 0, cgst: 9000, sgst: 9000, cess: 0, ...o
})
const OPTS = recon2bOptionsFrom(DEFAULT_RECON2B_TOLERANCES)

describe('invoiceNumberCore — the fuzzy key', () => {
  it.each([
    ['INV/2024-25/0045', '45'],
    ['inv-45', '45'],
    ['TI 045', '45'],
    ['45', '45'],
    ['0045', '45'],
    ['GST/24-25/45', '45'],
    ['FY2024-25/45', '45'],
    ['2024-2025/045', '45'],
    ['BILL-00045', '45'],
    ['INV-45A', '45A'],
    ['inv.45.a', '45A'],
    ['A/45/B', '45B'],
    ['INV 12-34', '1234'] // 12-34 is not a FY (not consecutive years) — kept
  ])('%s → %s', (raw, core) => {
    expect(invoiceNumberCore(raw)).toBe(core)
  })

  it('keeps distinct serials apart', () => {
    expect(invoiceNumberCore('INV-45')).not.toBe(invoiceNumberCore('INV-46'))
    expect(invoiceNumberCore('INV-1045')).not.toBe(invoiceNumberCore('INV-45'))
  })

  it('never returns an empty key (letters-only numbers fall back to the strict form)', () => {
    expect(invoiceNumberCore('ABC')).toBe('ABC')
    expect(invoiceNumberCore('--')).toBe(normalizeInvoiceNumber('--'))
  })
})

describe('invoiceSerial — the trailing digit run', () => {
  it.each([
    ['INV/2024-25/0045', '45'],
    ['MH/A/0045', '45'],
    ['45/X', '45'],
    ['2025-26', null], // only a FY token: no serial
    ['NODIGITS', null],
    ['000', '0']
  ])('%s → %s', (raw, serial) => {
    expect(invoiceSerial(raw)).toBe(serial)
  })
})

describe('normalizeGstin', () => {
  it('trims and upper-cases, never fuzzes', () => {
    expect(normalizeGstin(' 27abcde1234f1z5 ')).toBe(GSTIN)
    expect(normalizeGstin(null)).toBe('')
  })
})

describe('toleranceFor — the larger of paise and percent', () => {
  it('uses paise when the percent is smaller', () => {
    expect(toleranceFor(118000, 100, 0)).toBe(100)
    expect(toleranceFor(118000, 100, 0.05)).toBe(100) // 0.05% of ₹1,180 = 59p
  })
  it('uses the percent when larger, on the absolute amount', () => {
    expect(toleranceFor(1_000_000, 100, 0.5)).toBe(5000)
    expect(toleranceFor(-1_000_000, 100, 0.5)).toBe(5000)
  })
})

describe('reconcile2b — the fuzzy passes', () => {
  it('pairs on the number core across FY tokens / prefixes / zeros (matchedBy numberCore)', () => {
    const r = reconcile2b([portal({ number: 'INV/2026-27/0045' })], [book({ supplierRef: '45', date: '2026-06-28' })], OPTS)
    expect(r.pairs).toHaveLength(1)
    expect(r.pairs[0]).toMatchObject({ bucket: 'matched', matchedBy: 'numberCore' })
  })

  it('the strict number wins before the core', () => {
    const r = reconcile2b([portal({ number: 'INV-045' })], [book({ voucherId: 2, supplierRef: '45' }), book({ voucherId: 1, supplierRef: 'inv045' })], OPTS)
    const pair = r.pairs.find((p) => p.portal && p.book)!
    expect(pair).toMatchObject({ matchedBy: 'number' })
    expect(pair.book!.voucherId).toBe(1)
  })

  it('pairs on the trailing serial only inside the date window', () => {
    const p = portal({ number: 'MH/A/0045' })
    const inside = reconcile2b([p], [book({ supplierRef: '12/45', date: '2026-06-09' })], OPTS)
    expect(inside.pairs[0]).toMatchObject({ matchedBy: 'serial' })
    // 20 days apart, different value → no pair at all.
    const outside = reconcile2b([p], [book({ supplierRef: '12/45', date: '2026-06-25', invoiceValue: 99999 })], OPTS)
    expect(outside.pairs.map((x) => x.bucket).sort()).toEqual(['missingInBooks', 'missingInPortal'])
  })

  it('date tolerance is configurable', () => {
    const p = portal({ number: 'X-1' })
    const b = book({ supplierRef: 'Y-9', date: '2026-06-15' }) // 10 days, value equal
    expect(reconcile2b([p], [b], { ...OPTS, dateWindowDays: 7 }).pairs.filter((x) => x.portal && x.book)).toHaveLength(0)
    expect(reconcile2b([p], [b], { ...OPTS, dateWindowDays: 10 }).pairs[0]).toMatchObject({ matchedBy: 'valueDate', bucket: 'matched' })
  })

  it('amount tolerance in percent widens "matched" (and the value/date pass)', () => {
    const p = portal({ number: 'INV-7', value: 1_010_000, cgst: 90_000, sgst: 90_000 })
    const b = book({ supplierRef: 'INV-7', invoiceValue: 1_000_000, cgst: 90_000, sgst: 90_000 }) // ₹100 apart
    expect(reconcile2b([p], [b], OPTS).pairs[0]!.bucket).toBe('amountMismatch')
    expect(reconcile2b([p], [b], { ...OPTS, amountTolerancePct: 1 }).pairs[0]!.bucket).toBe('matched')
  })

  it('GSTIN is exact: a different GSTIN never pairs even with the same number and value', () => {
    const r = reconcile2b([portal()], [book({ partyGstin: '27ABCDE1234F1Z6' })], OPTS)
    expect(r.pairs.filter((x) => x.portal && x.book)).toHaveLength(0)
  })

  it('GSTIN compares case-insensitively after trim (books typed in lower case)', () => {
    const r = reconcile2b([portal()], [book({ partyGstin: ` ${GSTIN.toLowerCase()} ` })], OPTS)
    expect(r.pairs[0]).toMatchObject({ bucket: 'matched', matchedBy: 'number' })
  })

  it('fuzzyNumbers: false keeps only the strict and value/date passes', () => {
    const r = reconcile2b([portal({ number: 'INV/2026-27/0045', value: 5 })], [book({ supplierRef: '45' })], { ...OPTS, fuzzyNumbers: false })
    expect(r.pairs.filter((x) => x.portal && x.book)).toHaveLength(0)
  })

  it('takes the nearest date when several books share the core', () => {
    const r = reconcile2b(
      [portal({ number: '0045', date: '2026-06-10' })],
      [book({ voucherId: 1, supplierRef: 'A-45', date: '2026-05-01' }), book({ voucherId: 2, supplierRef: 'B-45', date: '2026-06-11' })],
      OPTS
    )
    expect(r.pairs.find((x) => x.portal && x.book)!.book!.voucherId).toBe(2)
  })

  it('a credit note never pairs with a purchase on any fuzzy pass', () => {
    const r = reconcile2b([portal({ kind: 'cdnr', noteType: 'C', number: 'CN-45' })], [book({ supplierRef: '45' })], OPTS)
    expect(r.pairs.filter((x) => x.portal && x.book)).toHaveLength(0)
  })
})
