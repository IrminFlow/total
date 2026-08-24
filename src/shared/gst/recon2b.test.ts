import { describe, it, expect } from 'vitest'
import {
  NAME_MATCH_THRESHOLD,
  nameSimilarity,
  nameTokens,
  normalizeInvoiceNumber,
  parseGstr2b,
  reconcile2b,
  type PortalInvoice,
  type PurchaseDoc
} from './recon2b'

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

  it('uppercases the supplier GSTIN (ctin) at parse time', () => {
    const json = JSON.stringify({
      data: {
        docdata: {
          b2b: [
            { ctin: '27abcde1234f1z5', inv: [{ inum: 'INV-1', idt: '01-06-2026', val: 100, items: [] }] }
          ]
        }
      }
    })
    const { invoices } = parseGstr2b(json)
    expect(invoices[0]!.gstin).toBe('27ABCDE1234F1Z5')
  })

  it('records an error (but still defaults noteType) when cdnr typ is not C or D', () => {
    const json = JSON.stringify({
      data: {
        docdata: {
          cdnr: [
            {
              ctin: '27ABCDE1234F1Z5',
              nt: [{ nt_num: 'CN-99', typ: 'X', nt_dt: '01-06-2026', val: 100, items: [] }]
            }
          ]
        }
      }
    })
    const { invoices, errors } = parseGstr2b(json)
    expect(invoices).toHaveLength(1)
    expect(invoices[0]!.noteType).toBe('C')
    expect(errors.some((e) => e.includes('CN-99') && e.includes('typ'))).toBe(true)
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

  it('does not match a b2b invoice to a debit_note with the same normalized number', () => {
    const p = portalInv({ kind: 'b2b', number: 'INV-100', value: 118000, date: '2026-06-05' })
    const b = bookDoc({ kind: 'debit_note', number: 'DN/1', supplierRef: 'INV-100', invoiceValue: 118000, date: '2026-06-05' })
    const result = reconcile2b([p], [b], OPTS)
    expect(result.pairs).toHaveLength(2)
    expect(result.buckets.missingInBooks.count).toBe(1)
    expect(result.buckets.missingInPortal.count).toBe(1)
    expect(result.pairs.find((x) => x.portal === p)?.bucket).toBe('missingInBooks')
    expect(result.pairs.find((x) => x.book === b)?.bucket).toBe('missingInPortal')
  })

  it('does not fuzzy-match a b2b invoice to a debit_note either (kind guard applies to both passes)', () => {
    const p = portalInv({ kind: 'b2b', number: 'INV-ZZZ', value: 118000, date: '2026-06-05' })
    const b = bookDoc({ kind: 'debit_note', number: 'DN/2', supplierRef: 'UNRELATED', invoiceValue: 118000, date: '2026-06-05' })
    const result = reconcile2b([p], [b], OPTS)
    expect(result.pairs.find((x) => x.portal === p)?.bucket).toBe('missingInBooks')
    expect(result.pairs.find((x) => x.book === b)?.bucket).toBe('missingInPortal')
  })

  it('matches cdnr entries only against debit_note books, never purchase', () => {
    const cdnr = portalInv({ kind: 'cdnr', noteType: 'C', number: 'CN-1', value: 11800, date: '2026-06-10' })
    const wrongKindBook = bookDoc({ kind: 'purchase', number: 'PUR/CN', supplierRef: 'CN-1', invoiceValue: 11800, date: '2026-06-10' })
    const rightKindBook = bookDoc({ voucherId: 2, kind: 'debit_note', number: 'DN/CN', supplierRef: 'CN-1', invoiceValue: 11800, date: '2026-06-10' })

    const withOnlyWrongKind = reconcile2b([cdnr], [wrongKindBook], OPTS)
    expect(withOnlyWrongKind.buckets.missingInBooks.count).toBe(1)
    expect(withOnlyWrongKind.buckets.missingInPortal.count).toBe(1)

    const withRightKind = reconcile2b([cdnr], [wrongKindBook, rightKindBook], OPTS)
    const matchedPair = withRightKind.pairs.find((x) => x.portal === cdnr)
    expect(matchedPair?.book?.voucherId).toBe(2)
    expect(withRightKind.buckets.missingInPortal.count).toBe(1) // the purchase-kind book is left over
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

describe('supplier-name matching', () => {
  const OPTS = { amountTolerancePaise: 100, dateWindowDays: 7 }

  describe('nameTokens', () => {
    it('drops legal-form noise, which carries no identifying information', () => {
      // Counting "PVT LTD" as content scores two same-named suppliers lower than two genuinely
      // different businesses that happen to share the suffix.
      expect(nameTokens('Sharma Traders Pvt Ltd')).toEqual(['SHARMA', 'TRADERS'])
      expect(nameTokens('SHARMA TRADERS PRIVATE LIMITED')).toEqual(['SHARMA', 'TRADERS'])
      expect(nameTokens('M/s. Sharma & Co.')).toEqual(['SHARMA'])
    })

    it('drops single characters and punctuation', () => {
      expect(nameTokens('A B Corp — Industries')).toEqual(['INDUSTRIES'])
    })

    it('answers empty for nothing at all', () => {
      expect(nameTokens(null)).toEqual([])
      expect(nameTokens('   ')).toEqual([])
      expect(nameTokens('Pvt Ltd')).toEqual([])
    })
  })

  describe('nameSimilarity', () => {
    it('is 1 for the same name written differently', () => {
      expect(nameSimilarity('Sharma Traders Pvt Ltd', 'SHARMA TRADERS PRIVATE LIMITED')).toBe(1)
      expect(nameSimilarity('  sharma   traders  ', 'Sharma Traders')).toBe(1)
    })

    it('is 1 when one name contains the other, which is the common shape', () => {
      // The portal trade name is often longer than what someone typed into the books; Jaccard
      // would punish that even though one name plainly contains the other.
      expect(nameSimilarity('SHARMA TRADERS AND SONS', 'Sharma Traders')).toBe(1)
    })

    it('is 0 for two names with nothing identifying left', () => {
      // Matching "Pvt Ltd" to "Private Limited" would pair unrelated suppliers.
      expect(nameSimilarity('Pvt Ltd', 'Private Limited')).toBe(0)
      expect(nameSimilarity(null, 'Sharma Traders')).toBe(0)
    })

    it('is low for genuinely different suppliers', () => {
      expect(nameSimilarity('Sharma Traders', 'Verma Enterprises')).toBeLessThan(NAME_MATCH_THRESHOLD)
      expect(nameSimilarity('Acme Steel', 'Acme Textiles')).toBeLessThan(1)
    })
  })

  describe('reconcile2b pass 3', () => {
    it('pairs an invoice whose GSTIN was mistyped in the books', () => {
      // Before this, the GSTIN was the only key, so the invoice landed in BOTH "missing"
      // buckets and the credit looked lost.
      const portal = [portalInv({ gstin: '27ABCDE1234F1Z5', supplierName: 'Sharma Traders Pvt Ltd', number: 'S-77' })]
      const books = [
        bookDoc({
          partyGstin: '27ABCDE1234F1Z9', // one wrong check character
          partyName: 'Sharma Traders',
          supplierRef: 'DIFFERENT-REF'
        })
      ]
      const { pairs, buckets } = reconcile2b(portal, books, OPTS)
      expect(buckets.gstinMismatch.count).toBe(1)
      expect(buckets.missingInBooks.count).toBe(0)
      expect(buckets.missingInPortal.count).toBe(0)
      const pair = pairs.find((x) => x.bucket === 'gstinMismatch')!
      expect(pair.portal?.number).toBe('S-77')
      expect(pair.book?.voucherId).toBe(1)
    })

    it('pairs when the books have no GSTIN for the supplier at all', () => {
      const portal = [portalInv({ supplierName: 'Sharma Traders Pvt Ltd', number: 'S-77' })]
      const books = [bookDoc({ partyGstin: null, partyName: 'SHARMA TRADERS', supplierRef: 'X' })]
      expect(reconcile2b(portal, books, OPTS).buckets.gstinMismatch.count).toBe(1)
    })

    it('will not pair two different suppliers that happen to agree on value and date', () => {
      // A false pair tells a user their credit is safe when it is claimed against the wrong
      // registration. A missed pair only leaves them where they already were.
      const portal = [portalInv({ gstin: '27AAAAA0000A1Z5', supplierName: 'Verma Enterprises', number: 'V-1' })]
      const books = [bookDoc({ partyGstin: '27BBBBB0000B1Z5', partyName: 'Sharma Traders', supplierRef: 'X' })]
      const { buckets } = reconcile2b(portal, books, OPTS)
      expect(buckets.gstinMismatch.count).toBe(0)
      expect(buckets.missingInBooks.count).toBe(1)
      expect(buckets.missingInPortal.count).toBe(1)
    })

    it('will not pair on name alone when the value is outside tolerance', () => {
      const portal = [portalInv({ gstin: '27AAAAA0000A1Z5', supplierName: 'Sharma Traders', number: 'S-1' })]
      const books = [
        bookDoc({ partyGstin: '27BBBBB0000B1Z5', partyName: 'Sharma Traders', supplierRef: 'X', invoiceValue: 500000 })
      ]
      expect(reconcile2b(portal, books, OPTS).buckets.gstinMismatch.count).toBe(0)
    })

    it('will not pair on name alone when the dates are far apart', () => {
      const portal = [portalInv({ gstin: '27AAAAA0000A1Z5', supplierName: 'Sharma Traders', number: 'S-1' })]
      const books = [
        bookDoc({ partyGstin: '27BBBBB0000B1Z5', partyName: 'Sharma Traders', supplierRef: 'X', date: '2026-09-05' })
      ]
      expect(reconcile2b(portal, books, OPTS).buckets.gstinMismatch.count).toBe(0)
    })

    it('leaves the GSTIN-keyed passes in charge when the GSTIN does agree', () => {
      // Pass 1 must still win: a name pass that could outrank an exact number match on the
      // right GSTIN would be a regression.
      const portal = [portalInv({ supplierName: 'Sharma Traders' })]
      const books = [bookDoc({ partyName: 'Sharma Traders' })]
      const { buckets } = reconcile2b(portal, books, OPTS)
      expect(buckets.matched.count).toBe(1)
      expect(buckets.gstinMismatch.count).toBe(0)
    })

    it('is greedy and one-to-one: one portal invoice cannot pair with two vouchers', () => {
      const portal = [portalInv({ gstin: '27AAAAA0000A1Z5', supplierName: 'Sharma Traders', number: 'S-1' })]
      const books = [
        bookDoc({ voucherId: 1, partyGstin: '27BBBBB0000B1Z5', partyName: 'Sharma Traders', supplierRef: 'X' }),
        bookDoc({ voucherId: 2, partyGstin: '27BBBBB0000B1Z5', partyName: 'Sharma Traders', supplierRef: 'Y' })
      ]
      const { buckets } = reconcile2b(portal, books, OPTS)
      expect(buckets.gstinMismatch.count).toBe(1)
      expect(buckets.missingInPortal.count).toBe(1)
    })

    it('does nothing when the portal file carries no trade names', () => {
      // trdnm is optional in the JSON; without it there is nothing to compare and the old
      // behaviour must be exactly preserved.
      const portal = [portalInv({ gstin: '27AAAAA0000A1Z5', number: 'S-1' })]
      const books = [bookDoc({ partyGstin: '27BBBBB0000B1Z5', partyName: 'Sharma Traders', supplierRef: 'X' })]
      const { buckets } = reconcile2b(portal, books, OPTS)
      expect(buckets.gstinMismatch.count).toBe(0)
      expect(buckets.missingInBooks.count).toBe(1)
    })
  })

  describe('parseGstr2b', () => {
    it('reads the supplier trade name off the group', () => {
      const json = JSON.stringify({
        data: {
          docdata: {
            b2b: [
              {
                ctin: '27ABCDE1234F1Z5',
                trdnm: '  Sharma Traders Pvt Ltd  ',
                inv: [{ inum: 'S-1', idt: '05-06-2026', val: 1180, itms: [{ itm_det: { txval: 1000, camt: 90, samt: 90 } }] }]
              }
            ]
          }
        }
      })
      const parsed = parseGstr2b(json)
      expect(parsed.invoices[0]!.supplierName).toBe('Sharma Traders Pvt Ltd')
    })

    it('leaves it null when the group has none', () => {
      const json = JSON.stringify({
        data: {
          docdata: {
            b2b: [
              { ctin: '27ABCDE1234F1Z5', inv: [{ inum: 'S-1', idt: '05-06-2026', val: 1180, itms: [] }] }
            ]
          }
        }
      })
      expect(parseGstr2b(json).invoices[0]!.supplierName).toBeNull()
    })
  })
})
