import { describe, it, expect } from 'vitest'
import { parseGstr2b, normalizeInvoiceNumber, reconcile2b, type PortalInvoice, type PurchaseDoc } from './recon2b'

const OPTS = { amountTolerancePaise: 100, dateWindowDays: 7 }

function portalInv(overrides: Partial<PortalInvoice> = {}): PortalInvoice {
  return {
    gstin: '27ABCDE1234F1Z5',
    number: 'INV-001',
    date: '2026-06-05',
    value: 118000,
    taxable: 100000,
    igst: 0,
    cgst: 9000,
    sgst: 9000,
    cess: 0,
    kind: 'b2b',
    ...overrides
  }
}

function bookDoc(overrides: Partial<PurchaseDoc> = {}): PurchaseDoc {
  return {
    voucherId: 1,
    kind: 'purchase',
    date: '2026-06-05',
    number: 'PUR/1',
    supplierRef: 'INV-001',
    partyName: 'Acme Traders',
    partyGstin: '27ABCDE1234F1Z5',
    invoiceValue: 118000,
    taxable: 100000,
    igst: 0,
    cgst: 9000,
    sgst: 9000,
    cess: 0,
    ...overrides
  }
}

describe('normalizeInvoiceNumber', () => {
  it('uppercases and strips separators', () => {
    expect(normalizeInvoiceNumber('inv-001')).toBe('INV1')
    expect(normalizeInvoiceNumber('INV1')).toBe('INV1')
    expect(normalizeInvoiceNumber('inv-001')).toBe(normalizeInvoiceNumber('INV1'))
  })

  it('strips leading zeros only from the final digit run', () => {
    expect(normalizeInvoiceNumber('INV-007')).toBe('INV7')
    expect(normalizeInvoiceNumber('INV007/24')).toBe('INV724')
    expect(normalizeInvoiceNumber('000')).toBe('0')
    expect(normalizeInvoiceNumber('INV24A')).toBe('INV24A') // no trailing digit run: untouched
  })

  it('is stable under whitespace and punctuation noise', () => {
    expect(normalizeInvoiceNumber('INV/2024-25/007')).toBe('INV202425007')
    expect(normalizeInvoiceNumber('INV 001')).toBe('INV1')
  })
})

describe('parseGstr2b', () => {
  it('parses a fixture: rupees -> paise, DD-MM-YYYY -> ISO, period from rtnprd', () => {
    const json = JSON.stringify({
      data: {
        rtnprd: '062026',
        docdata: {
          b2b: [
            {
              ctin: '27ABCDE1234F1Z5',
              inv: [
                {
                  inum: 'INV-001',
                  idt: '05-06-2026',
                  val: 1180.0,
                  items: [{ num: 1, itm_det: { rt: 18, txval: 1000.0, iamt: 0, camt: 90.0, samt: 90.0, csamt: 0 } }]
                }
              ]
            }
          ]
        }
      }
    })
    const { period, invoices, errors } = parseGstr2b(json)
    expect(errors).toEqual([])
    expect(period).toBe('062026')
    expect(invoices).toHaveLength(1)
    const inv = invoices[0]!
    expect(inv.date).toBe('2026-06-05')
    expect(inv.value).toBe(118000)
    expect(inv.taxable).toBe(100000)
    expect(inv.cgst).toBe(9000)
    expect(inv.sgst).toBe(9000)
    expect(inv.igst).toBe(0)
    expect(inv.kind).toBe('b2b')
  })

  it('tolerates a top-level docdata with no data wrapper', () => {
    const json = JSON.stringify({
      docdata: {
        b2b: [
          {
            ctin: '27ABCDE1234F1Z5',
            inv: [{ inum: 'A1', idt: '01-06-2026', val: 100, items: [] }]
          }
        ]
      }
    })
    const { invoices, period } = parseGstr2b(json)
    expect(period).toBeNull()
    expect(invoices).toHaveLength(1)
  })

  it('accepts itms as an alias for items', () => {
    const json = JSON.stringify({
      data: {
        docdata: {
          b2b: [
            {
              ctin: '27ABCDE1234F1Z5',
              inv: [
                {
                  inum: 'INV-002',
                  idt: '10-06-2026',
                  val: 236,
                  itms: [{ num: 1, itm_det: { rt: 18, txval: 200, camt: 18, samt: 18 } }]
                }
              ]
            }
          ]
        }
      }
    })
    const { invoices } = parseGstr2b(json)
    expect(invoices).toHaveLength(1)
    expect(invoices[0]!.taxable).toBe(20000)
    expect(invoices[0]!.cgst).toBe(1800)
    expect(invoices[0]!.sgst).toBe(1800)
    expect(invoices[0]!.cess).toBe(0) // missing csamt -> 0
  })

  it('parses cdnr notes, carrying noteType through', () => {
    const json = JSON.stringify({
      data: {
        docdata: {
          cdnr: [
            {
              ctin: '27ABCDE1234F1Z5',
              nt: [
                {
                  nt_num: 'CN-01',
                  typ: 'C',
                  nt_dt: '15-06-2026',
                  val: 118,
                  items: [{ itm_det: { txval: 100, camt: 9, samt: 9 } }]
                },
                {
                  nt_num: 'DN-01',
                  typ: 'D',
                  nt_dt: '16-06-2026',
                  val: 59,
                  items: [{ itm_det: { txval: 50, camt: 4.5, samt: 4.5 } }]
                }
              ]
            }
          ]
        }
      }
    })
    const { invoices, errors } = parseGstr2b(json)
    expect(errors).toEqual([])
    expect(invoices).toHaveLength(2)
    expect(invoices.every((i) => i.kind === 'cdnr')).toBe(true)
    expect(invoices.find((i) => i.number === 'CN-01')?.noteType).toBe('C')
    expect(invoices.find((i) => i.number === 'DN-01')?.noteType).toBe('D')
    expect(invoices.find((i) => i.number === 'CN-01')?.date).toBe('2026-06-15')
  })

  it('never throws on malformed JSON or entries, and collects errors', () => {
    expect(parseGstr2b('not json').errors.length).toBeGreaterThan(0)
    expect(parseGstr2b('not json').invoices).toEqual([])

    const json = JSON.stringify({
      data: {
        docdata: {
          b2b: [
            { ctin: '27ABCDE1234F1Z5', inv: [{ inum: '', idt: '05-06-2026', val: 100 }, { inum: 'OK-1', idt: 'not-a-date', val: 100 }] },
            { inv: [{ inum: 'X', idt: '01-01-2026', val: 1 }] } // no ctin
          ]
        }
      }
    })
    const { invoices, errors } = parseGstr2b(json)
    expect(invoices).toEqual([])
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('reconcile2b', () => {
  it('matches exact normalized numbers within GSTIN over fuzzy candidates', () => {
    const p = portalInv({ number: 'INV-001', value: 118000, date: '2026-06-05' })
    const exact = bookDoc({ voucherId: 1, supplierRef: 'inv001', invoiceValue: 118000, date: '2026-06-05' })
    // A closer-looking fuzzy candidate (same value/date) but a different supplier ref must lose to the exact match.
    const fuzzy = bookDoc({ voucherId: 2, supplierRef: 'DIFFERENT-99', invoiceValue: 118000, date: '2026-06-05' })
    const result = reconcile2b([p], [fuzzy, exact], OPTS)
    const matched = result.pairs.filter((x) => x.bucket !== 'missingInPortal')
    expect(matched).toHaveLength(1)
    expect(matched[0]!.book?.voucherId).toBe(1)
    expect(result.buckets.missingInPortal.count).toBe(1)
    expect(result.buckets.missingInPortal.taxable).toBe(fuzzy.taxable)
  })

  it('falls back to fuzzy matching within date window + value tolerance when no exact number matches', () => {
    const p = portalInv({ number: 'INV-999', value: 118050, date: '2026-06-05' })
    const b = bookDoc({ supplierRef: 'SOMETHING-ELSE', invoiceValue: 118000, date: '2026-06-08' }) // 5 days, within window
    const result = reconcile2b([p], [b], OPTS)
    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]!.portal).toBe(p)
    expect(result.pairs[0]!.book).toBe(b)
  })

  it('classifies the ±1-rupee boundary: 100p diff matched, 101p diff amountMismatch', () => {
    const p1 = portalInv({ number: 'INV-A', value: 118100 })
    const b1 = bookDoc({ number: 'PUR/A', supplierRef: 'INV-A', invoiceValue: 118000 }) // 100p diff
    const r1 = reconcile2b([p1], [b1], OPTS)
    expect(r1.pairs[0]!.bucket).toBe('matched')

    const p2 = portalInv({ number: 'INV-B', value: 118101 })
    const b2 = bookDoc({ number: 'PUR/B', supplierRef: 'INV-B', invoiceValue: 118000 }) // 101p diff
    const r2 = reconcile2b([p2], [b2], OPTS)
    expect(r2.pairs[0]!.bucket).toBe('amountMismatch')
  })

  it('flags taxMismatch when a tax component differs beyond tolerance even if value matches', () => {
    const p = portalInv({ number: 'INV-C', value: 118000, cgst: 9000, sgst: 9000 })
    const b = bookDoc({ number: 'PUR/C', supplierRef: 'INV-C', invoiceValue: 118000, cgst: 8000, sgst: 10000 }) // total tax same, split wrong
    const result = reconcile2b([p], [b], OPTS)
    expect(result.pairs[0]!.bucket).toBe('taxMismatch')
  })

  it('buckets unmatched portal invoices as missingInBooks and unmatched book docs as missingInPortal', () => {
    const p = portalInv({ number: 'ONLY-ON-PORTAL' })
    const b = bookDoc({ number: 'PUR/ONLY', supplierRef: 'ONLY-IN-BOOKS', invoiceValue: 999999, date: '2026-01-01' })
    const result = reconcile2b([p], [b], OPTS)
    expect(result.pairs).toHaveLength(2)
    expect(result.buckets.missingInBooks.count).toBe(1)
    expect(result.buckets.missingInPortal.count).toBe(1)
    expect(result.pairs.find((x) => x.bucket === 'missingInBooks')?.book).toBeNull()
    expect(result.pairs.find((x) => x.bucket === 'missingInPortal')?.portal).toBeNull()
  })

  it('never consumes the same portal invoice or book doc twice', () => {
    const p1 = portalInv({ number: 'INV-D', value: 100000, date: '2026-06-01' })
    const p2 = portalInv({ number: 'INV-D', value: 100000, date: '2026-06-01' }) // duplicate-looking invoice
    const b = bookDoc({ number: 'PUR/D', supplierRef: 'INV-D', invoiceValue: 100000, date: '2026-06-01' })
    const result = reconcile2b([p1, p2], [b], OPTS)
    const consumedBookPairs = result.pairs.filter((x) => x.book === b)
    expect(consumedBookPairs).toHaveLength(1)
    expect(result.buckets.missingInBooks.count).toBe(1) // the other portal invoice has nothing left to match
  })

  it('sums bucket totals from the portal side when present, else the book side', () => {
    const matchedP = portalInv({ number: 'INV-E', value: 118000, taxable: 100000, cgst: 9000, sgst: 9000 })
    const matchedB = bookDoc({ number: 'PUR/E', supplierRef: 'INV-E', invoiceValue: 118000, taxable: 99000, cgst: 8900, sgst: 8900 })
    const onlyPortal = portalInv({ number: 'INV-F', taxable: 50000, cgst: 4500, sgst: 4500 })
    const onlyBook = bookDoc({ number: 'PUR/G', supplierRef: 'NOPE', invoiceValue: 70000, taxable: 60000, cgst: 5000, sgst: 5000 })

    const result = reconcile2b([matchedP, onlyPortal], [matchedB, onlyBook], OPTS)

    expect(result.buckets.matched.count).toBe(1)
    expect(result.buckets.matched.taxable).toBe(matchedP.taxable) // portal side, not book side
    expect(result.buckets.matched.cgst).toBe(matchedP.cgst)

    expect(result.buckets.missingInBooks.count).toBe(1)
    expect(result.buckets.missingInBooks.taxable).toBe(onlyPortal.taxable)

    expect(result.buckets.missingInPortal.count).toBe(1)
    expect(result.buckets.missingInPortal.taxable).toBe(onlyBook.taxable) // book side, since portal is absent
  })
})
