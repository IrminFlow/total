/**
 * GSTR-1 amendment tables (D-101). Each test is named after the rule it pins down, because the
 * rules — not the shapes — are what make an amendment row findable by the portal.
 */
import { describe, it, expect } from 'vitest'
import {
  buildAmendmentTables,
  diffForAmendment,
  periodOrder,
  type AmendmentInput,
  type AmendmentPair
} from './amendments'
import type { GstDoc } from './returns'

const COMPANY_STATE = '27'
const CTIN_1 = '27AAPFU0939F1ZV' // registered buyer, Maharashtra
const CTIN_29 = '29AACCR7832C1ZD' // registered buyer, Karnataka

const FILED_PERIOD = '072026' // the period the original went out in
const AMEND_PERIOD = '082026' // the period the correction is filed in

/** A minimal sales document. Amounts are paise; tax is per-rate, as extracted. */
function doc(over: Partial<GstDoc> = {}): GstDoc {
  return {
    voucherId: 1,
    kind: 'sales',
    date: '2026-07-05',
    number: 'INV-1',
    partyName: 'Umbrella Retail',
    partyGstin: CTIN_1,
    pos: '27',
    invoiceValue: 1_180_000,
    items: [{ rate: 18, taxable: 1_000_000, cgst: 90_000, sgst: 90_000, igst: 0, cess: 0 }],
    hsnLines: [],
    nilLines: [],
    invTyp: 'R',
    rchrg: false,
    ...over
  }
}

const build = (pairs: AmendmentPair[], over: Partial<AmendmentInput> = {}) =>
  buildAmendmentTables({ pairs, companyState: COMPANY_STATE, period: AMEND_PERIOD, ...over })

const pair = (original: GstDoc, revised: GstDoc, originalPeriod = FILED_PERIOD): AmendmentPair => ({
  original,
  revised,
  originalPeriod
})

describe('period ordering', () => {
  it('MMYYYY periods compare chronologically, not lexically', () => {
    expect(periodOrder('122026')).toBeLessThan(periodOrder('012027'))
    expect(periodOrder('072026')).toBeLessThan(periodOrder('082026'))
    expect(Number.isNaN(periodOrder('2026-07'))).toBe(true)
    expect(Number.isNaN(periodOrder('132026'))).toBe(true)
  })
})

describe('diffForAmendment — which particulars changed', () => {
  it('a changed invoice value and its tax are both reported', () => {
    const d = diffForAmendment(
      doc(),
      doc({
        invoiceValue: 1_298_000,
        items: [{ rate: 18, taxable: 1_100_000, cgst: 99_000, sgst: 99_000, igst: 0, cess: 0 }]
      })
    )
    expect(d.hasChange).toBe(true)
    expect(d.changed.sort()).toEqual(['tax', 'value'])
    expect(d.changes.find((c) => c.field === 'value')).toEqual({
      field: 'value',
      from: 1_180_000,
      to: 1_298_000
    })
  })

  it('the same tax split in a different item ORDER is not a change', () => {
    const items = [
      { rate: 18, taxable: 1_000_000, cgst: 90_000, sgst: 90_000, igst: 0, cess: 0 },
      { rate: 5, taxable: 200_000, cgst: 5_000, sgst: 5_000, igst: 0, cess: 0 }
    ]
    const d = diffForAmendment(doc({ items }), doc({ items: [items[1]!, items[0]!] }))
    expect(d.hasChange).toBe(false)
  })

  it('an identical total split across different rates IS a change', () => {
    const d = diffForAmendment(
      doc({ items: [{ rate: 18, taxable: 1_000_000, cgst: 90_000, sgst: 90_000, igst: 0, cess: 0 }] }),
      doc({
        items: [
          { rate: 18, taxable: 600_000, cgst: 54_000, sgst: 54_000, igst: 0, cess: 0 },
          { rate: 18, taxable: 400_000, cgst: 36_000, sgst: 36_000, igst: 0, cess: 0 }
        ]
      })
    )
    expect(d.changed).toContain('tax')
  })

  it('reverse charge, date and party GSTIN each register on their own', () => {
    const d = diffForAmendment(
      doc(),
      doc({ rchrg: true, date: '2026-07-06', partyGstin: CTIN_29 })
    )
    expect(d.changed.sort()).toEqual(['date', 'partyGstin', 'rchrg'])
    expect(d.registrationChanged).toBe(false)
  })
})

describe('buildAmendmentTables — routing', () => {
  it('a value-only amendment of a B2B invoice becomes one B2BA row keyed on octin/oinum/oidt', () => {
    const original = doc()
    const revised = doc({
      voucherId: 2,
      invoiceValue: 1_298_000,
      items: [{ rate: 18, taxable: 1_100_000, cgst: 99_000, sgst: 99_000, igst: 0, cess: 0 }]
    })
    const out = build([pair(original, revised)])

    expect(out.rejected).toEqual([])
    expect(out.b2cla).toEqual([])
    expect(out.cdnra).toEqual([])
    expect(out.cdnura).toEqual([])
    expect(out.b2ba).toEqual([
      {
        ctin: CTIN_1,
        inv: [
          {
            octin: CTIN_1,
            oinum: 'INV-1',
            oidt: '05-07-2026',
            inum: 'INV-1',
            idt: '05-07-2026',
            val: 12980,
            pos: '27',
            rchrg: 'N',
            inv_typ: 'R',
            itms: [
              { num: 1, itm_det: { rt: 18, txval: 11000, camt: 990, samt: 990, csamt: 0 } }
            ]
          }
        ]
      }
    ])
  })

  it('a place-of-supply amendment carries the REVISED pos on the row and the ORIGINAL key', () => {
    const inter = {
      pos: '29',
      items: [{ rate: 18, taxable: 1_000_000, cgst: 0, sgst: 0, igst: 180_000, cess: 0 }]
    }
    const original = doc(inter)
    const revised = doc({ ...inter, voucherId: 2, pos: '24' })
    const out = build([pair(original, revised)])

    expect(out.rejected).toEqual([])
    const inv = (out.b2ba as any[])[0].inv[0]
    expect(inv.pos).toBe('24')
    expect(inv.oinum).toBe('INV-1')
    expect(inv.oidt).toBe('05-07-2026')
    expect(diffForAmendment(original, revised).changed).toEqual(['pos'])
  })

  it('a party-GSTIN change from registered to unregistered amends into B2CLA when it stays B2C-large', () => {
    // The amendment tables are chosen by what the document now IS. A supply that turns out to
    // have gone to an unregistered inter-state buyer above the ₹1,00,000 threshold is a B2CL
    // supply, so its amendment belongs in B2CLA — grouped by POS, with no ctin/octin.
    const original = doc({
      pos: '29',
      invoiceValue: 11_800_000,
      items: [{ rate: 18, taxable: 10_000_000, cgst: 0, sgst: 0, igst: 1_800_000, cess: 0 }]
    })
    const revised = doc({
      voucherId: 2,
      partyGstin: null,
      partyName: 'Cash buyer',
      pos: '29',
      invoiceValue: 11_800_000,
      items: [{ rate: 18, taxable: 10_000_000, cgst: 0, sgst: 0, igst: 1_800_000, cess: 0 }]
    })
    const out = build([pair(original, revised)])

    expect(out.b2ba).toEqual([])
    expect(out.rejected).toEqual([])
    expect(diffForAmendment(original, revised).registrationChanged).toBe(true)
    expect(out.b2cla).toEqual([
      {
        pos: '29',
        inv: [
          {
            oinum: 'INV-1',
            oidt: '05-07-2026',
            inum: 'INV-1',
            idt: '05-07-2026',
            val: 118000,
            itms: [{ num: 1, itm_det: { rt: 18, txval: 100000, iamt: 18000, csamt: 0 } }]
          }
        ]
      }
    ])
  })

  it('a credit note to a registered buyer amends into CDNRA, keyed on ont_num/ont_dt', () => {
    const note = {
      kind: 'credit_note' as const,
      number: 'CRN-1',
      date: '2026-07-09',
      invoiceValue: 236_000,
      items: [{ rate: 18, taxable: 200_000, cgst: 18_000, sgst: 18_000, igst: 0, cess: 0 }]
    }
    const original = doc(note)
    const revised = doc({
      ...note,
      voucherId: 2,
      invoiceValue: 118_000,
      items: [{ rate: 18, taxable: 100_000, cgst: 9_000, sgst: 9_000, igst: 0, cess: 0 }]
    })
    const out = build([pair(original, revised)])

    expect(out.b2ba).toEqual([])
    expect(out.cdnra).toEqual([
      {
        ctin: CTIN_1,
        nt: [
          {
            ont_num: 'CRN-1',
            ont_dt: '09-07-2026',
            ntty: 'C',
            nt_num: 'CRN-1',
            nt_dt: '09-07-2026',
            pos: '27',
            rchrg: 'N',
            inv_typ: 'R',
            val: 1180,
            itms: [{ num: 1, itm_det: { rt: 18, txval: 1000, camt: 90, samt: 90, csamt: 0 } }]
          }
        ]
      }
    ])
  })

  it('a credit note to an unregistered B2CL buyer amends into CDNURA with typ B2CL', () => {
    const note = {
      kind: 'credit_note' as const,
      number: 'CRN-2',
      date: '2026-07-10',
      partyGstin: null,
      partyName: 'Cash buyer',
      pos: '29',
      invoiceValue: 11_800_000,
      items: [{ rate: 18, taxable: 10_000_000, cgst: 0, sgst: 0, igst: 1_800_000, cess: 0 }]
    }
    const out = build([
      pair(doc(note), doc({ ...note, voucherId: 2, pos: '24' }))
    ])

    expect(out.cdnra).toEqual([])
    expect(out.cdnura).toEqual([
      {
        ont_num: 'CRN-2',
        ont_dt: '10-07-2026',
        ntty: 'C',
        nt_num: 'CRN-2',
        nt_dt: '10-07-2026',
        typ: 'B2CL',
        pos: '24',
        val: 118000,
        itms: [{ num: 1, itm_det: { rt: 18, txval: 100000, iamt: 18000, csamt: 0 } }]
      }
    ])
  })

  it('B2BA groups by the revised counterparty GSTIN, in first-seen order', () => {
    const a = pair(
      doc({ number: 'INV-1' }),
      doc({ number: 'INV-1', voucherId: 2, invoiceValue: 1_200_000 })
    )
    const b = pair(
      doc({ number: 'INV-2', partyGstin: CTIN_29, pos: '29', items: [{ rate: 18, taxable: 1_000_000, cgst: 0, sgst: 0, igst: 180_000, cess: 0 }] }),
      doc({ number: 'INV-2', voucherId: 3, partyGstin: CTIN_29, pos: '29', invoiceValue: 1_190_000, items: [{ rate: 18, taxable: 1_000_000, cgst: 0, sgst: 0, igst: 180_000, cess: 0 }] })
    )
    const c = pair(
      doc({ number: 'INV-3' }),
      doc({ number: 'INV-3', voucherId: 4, invoiceValue: 1_300_000 })
    )
    const out = build([a, b, c])
    expect((out.b2ba as any[]).map((g) => g.ctin)).toEqual([CTIN_1, CTIN_29])
    expect((out.b2ba as any[])[0].inv.map((i: any) => i.oinum)).toEqual(['INV-1', 'INV-3'])
  })
})

describe('buildAmendmentTables — the rules', () => {
  it('an amendment row must differ from the original in at least one particular', () => {
    const original = doc()
    const out = build([pair(original, doc({ voucherId: 2 }))])

    expect(out.b2ba).toEqual([])
    expect(out.rejected).toHaveLength(1)
    expect(out.rejected[0]!.code).toBe('no_change')
    expect(out.rejected[0]!.diff!.hasChange).toBe(false)
    expect(out.rejected[0]!.voucherIds).toEqual([1, 2])
  })

  it("the original's tax period must be earlier than the amending period", () => {
    const revised = doc({ voucherId: 2, invoiceValue: 1_200_000 })
    const same = build([pair(doc(), revised, AMEND_PERIOD)])
    const later = build([pair(doc(), revised, '092026')])

    for (const out of [same, later]) {
      expect(out.b2ba).toEqual([])
      expect(out.rejected).toHaveLength(1)
      expect(out.rejected[0]!.code).toBe('original_period_not_earlier')
    }
  })

  it('a malformed tax period is refused rather than compared as NaN', () => {
    const out = build([pair(doc(), doc({ voucherId: 2, invoiceValue: 1_200_000 }), '2026-07')])
    expect(out.rejected[0]!.code).toBe('invalid_period')
    expect(out.b2ba).toEqual([])
  })

  it('a document cannot be amended twice into the same period', () => {
    const original = doc()
    const first = pair(original, doc({ voucherId: 2, invoiceValue: 1_200_000 }))
    const second = pair(original, doc({ voucherId: 3, invoiceValue: 1_300_000 }))
    const out = build([first, second])

    expect((out.b2ba as any[])[0].inv).toHaveLength(1)
    expect((out.b2ba as any[])[0].inv[0].val).toBe(12000)
    expect(out.rejected).toHaveLength(1)
    expect(out.rejected[0]!.code).toBe('duplicate_amendment')
    expect(out.rejected[0]!.key).toEqual({ octin: CTIN_1, oinum: 'INV-1', oidt: '2026-07-05' })
  })

  it('a B2C invoice below the B2CL threshold has no amendment table and is reported, not dropped', () => {
    const small = {
      partyGstin: null,
      partyName: 'Cash buyer',
      pos: '29',
      invoiceValue: 590_000,
      items: [{ rate: 18, taxable: 500_000, cgst: 0, sgst: 0, igst: 90_000, cess: 0 }]
    }
    const out = build([
      pair(doc(small), doc({ ...small, voucherId: 2, invoiceValue: 600_000 }))
    ])

    expect(out.b2ba).toEqual([])
    expect(out.b2cla).toEqual([])
    expect(out.rejected).toHaveLength(1)
    expect(out.rejected[0]!.code).toBe('b2cs_no_amendment_table')
    expect(out.rejected[0]!.message).toContain('B2CS')
    expect(out.rejected[0]!.diff!.changed).toContain('value')
  })

  it('a small unregistered credit note also flows through B2CS totals, never CDNURA', () => {
    const small = {
      kind: 'credit_note' as const,
      number: 'CRN-9',
      partyGstin: null,
      partyName: 'Cash buyer',
      pos: '27',
      invoiceValue: 52_500,
      items: [{ rate: 5, taxable: 50_000, cgst: 1_250, sgst: 1_250, igst: 0, cess: 0 }]
    }
    const out = build([
      pair(doc(small), doc({ ...small, voucherId: 2, invoiceValue: 63_000 }))
    ])
    expect(out.cdnura).toEqual([])
    expect(out.rejected[0]!.code).toBe('b2cs_no_amendment_table')
  })

  it('a revision with no rated lines left is refused — Table 8 has no invoice amendment table', () => {
    const out = build([
      pair(
        doc(),
        doc({
          voucherId: 2,
          invoiceValue: 1_000_000,
          items: [{ rate: 0, taxable: 1_000_000, cgst: 0, sgst: 0, igst: 0, cess: 0 }]
        })
      )
    ])
    expect(out.b2ba).toEqual([])
    expect(out.rejected[0]!.code).toBe('no_rated_items')
  })

  it('an empty input produces a nil amendment set rather than crashing', () => {
    expect(build([])).toEqual({ b2ba: [], b2cla: [], cdnra: [], cdnura: [], rejected: [] })
  })

  it('money stays integer paise in and rupees only at the JSON edge (odd paise, no float drift)', () => {
    const out = build([
      pair(
        doc(),
        doc({
          voucherId: 2,
          invoiceValue: 1_180_001,
          items: [{ rate: 18, taxable: 1_000_001, cgst: 90_000, sgst: 90_000, igst: 0, cess: 0 }]
        })
      )
    ])
    const inv = (out.b2ba as any[])[0].inv[0]
    expect(inv.val).toBe(11800.01)
    expect(inv.itms[0].itm_det.txval).toBe(10000.01)
  })
})
