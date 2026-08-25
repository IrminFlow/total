import { describe, expect, it } from 'vitest'
import {
  buildSelfInvoice,
  consolidateMonthly,
  selfInvoiceNumber,
  sumSelfInvoiceLines,
  type SelfInvoiceLine,
  type SelfInvoiceSupply
} from './selfInvoice'

const line = (over: Partial<SelfInvoiceLine> = {}): SelfInvoiceLine => ({
  description: 'Freight',
  hsn: '996511',
  qtyMilli: null,
  unit: null,
  taxable: 10_000_00,
  rate: 5,
  cessRate: 0,
  igst: 0,
  cgst: 250_00,
  sgst: 250_00,
  cess: 0,
  ...over
})

const supply = (over: Partial<SelfInvoiceSupply> = {}): SelfInvoiceSupply => ({
  voucherId: 1,
  date: '2026-06-10',
  voucherNumber: 'PUR-4',
  supplierName: 'Ram Transport',
  supplierGstin: null,
  supplierStateCode: '27',
  supplierAddress: 'Pune',
  basis: 'unregistered',
  lines: [line()],
  ...over
})

describe('selfInvoiceNumber', () => {
  it('issues from its own series, restarting each financial year', () => {
    // Rule 46(b) wants a consecutive serial for a financial year, and mixing these into the sales
    // series would put a non-sale into GSTR-1's numbering.
    expect(selfInvoiceNumber('2026-27', 7)).toBe('RCM/2026-27/0007')
    expect(selfInvoiceNumber('2027-28', 1)).toBe('RCM/2027-28/0001')
  })
})

describe('buildSelfInvoice', () => {
  it('dates the invoice on the date of receipt, not the day it was printed', () => {
    // Section 31(3)(f) fixes the date. Printing it late must not move the liability into another
    // tax period, or the 3B row stops tying.
    const doc = buildSelfInvoice({ supply: supply(), number: 'RCM/2026-27/0001', recipientStateCode: '27', recipientGstin: '27AAPFU0939F1ZV' })
    expect(doc.date).toBe('2026-06-10')
  })

  it('treats a same-state supplier as intra-state', () => {
    const doc = buildSelfInvoice({ supply: supply(), number: 'x', recipientStateCode: '27', recipientGstin: 'g' })
    expect(doc.supplyType).toBe('intra')
    expect(doc.placeOfSupply).toBe('27')
  })

  it('treats an out-of-state supplier as inter-state', () => {
    const doc = buildSelfInvoice({
      supply: supply({ supplierStateCode: '29' }),
      number: 'x',
      recipientStateCode: '27',
      recipientGstin: 'g'
    })
    expect(doc.supplyType).toBe('inter')
  })

  it('treats a supplier with no state on record as local', () => {
    // The ordinary case is a local unregistered vendor. Guessing inter-state would create an IGST
    // liability that nobody can claim back.
    const doc = buildSelfInvoice({
      supply: supply({ supplierStateCode: null }),
      number: 'x',
      recipientStateCode: '27',
      recipientGstin: 'g'
    })
    expect(doc.supplyType).toBe('intra')
  })

  it('warns when a notified supply has no supplier GSTIN', () => {
    // 9(3) with no GSTIN is almost always a 9(4) supply that was flagged on the party instead.
    const doc = buildSelfInvoice({
      supply: supply({ basis: 'notified', supplierGstin: null }),
      number: 'x',
      recipientStateCode: '27',
      recipientGstin: 'g'
    })
    expect(doc.warnings.join(' ')).toContain('section 9(4)')
  })

  it('warns about a missing recipient GSTIN and missing HSN, but still produces the document', () => {
    const doc = buildSelfInvoice({
      supply: supply({ lines: [line({ hsn: null }), line()] }),
      number: 'x',
      recipientStateCode: '27',
      recipientGstin: null
    })
    expect(doc.warnings.some((w) => w.includes('Rule 46(b)'))).toBe(true)
    expect(doc.warnings.some((w) => w.includes('Rule 46(g)'))).toBe(true)
    expect(doc.lines).toHaveLength(2)
  })

  it('warns when every line is nil-rated', () => {
    const doc = buildSelfInvoice({
      supply: supply({ lines: [line({ rate: 0, cgst: 0, sgst: 0 })] }),
      number: 'x',
      recipientStateCode: '27',
      recipientGstin: 'g'
    })
    expect(doc.warnings.some((w) => w.includes('nil rate'))).toBe(true)
  })
})

describe('sumSelfInvoiceLines', () => {
  it('adds every head and the grand total in integer paise', () => {
    const t = sumSelfInvoiceLines([line(), line({ taxable: 1, cgst: 0, sgst: 0 })])
    expect(t.taxable).toBe(10_000_01)
    expect(t.cgst).toBe(250_00)
    expect(t.total).toBe(10_000_01 + 250_00 + 250_00)
  })

  it('is zero for no lines', () => {
    expect(sumSelfInvoiceLines([]).total).toBe(0)
  })
})

describe('consolidateMonthly', () => {
  const opts = { date: '2026-06-30', numberFor: (i: number) => `RCM/2026-27/${i + 1}`, recipientStateCode: '27', recipientGstin: 'g' }

  it('folds a supplier’s month into one document', () => {
    const docs = consolidateMonthly(
      [supply({ voucherId: 1 }), supply({ voucherId: 2, date: '2026-06-20' })],
      opts
    )
    expect(docs).toHaveLength(1)
    expect(docs[0]!.voucherIds).toEqual([1, 2])
    expect(docs[0]!.totals.taxable).toBe(20_000_00)
    expect(docs[0]!.date).toBe('2026-06-30')
  })

  it('keeps suppliers apart — a consolidated invoice still names one supplier', () => {
    const docs = consolidateMonthly(
      [supply({ voucherId: 1 }), supply({ voucherId: 2, supplierName: 'Shyam Transport' })],
      opts
    )
    expect(docs).toHaveLength(2)
  })

  it('leaves notified 9(3) supplies alone — the proviso is written for 9(4)', () => {
    const docs = consolidateMonthly([supply({ basis: 'notified', supplierGstin: '27AAPFU0939F1ZV' })], opts)
    expect(docs).toHaveLength(0)
  })

  it('produces nothing for a month with no reverse-charge purchases', () => {
    expect(consolidateMonthly([], opts)).toEqual([])
  })
})
