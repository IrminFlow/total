import { describe, expect, it } from 'vitest'
import {
  branchTransferNumber,
  branchTransferWarnings,
  buildBranchTransferInvoice,
  rule28BasisCitation,
  rule28On,
  rule28Value,
  sumBranchTransferLines,
  RULE28_HISTORY,
  type BranchTransferMovement,
  type BranchTransferParty
} from './branchTransfer'

const mh: BranchTransferParty = {
  registrationId: 1,
  gstin: '27AAAAA0000A1Z5',
  stateCode: '27',
  tradeName: 'Head office',
  address: 'Mumbai'
}
const gj: BranchTransferParty = {
  registrationId: 2,
  gstin: '24AAAAA0000A1Z2',
  stateCode: '24',
  tradeName: 'Surat depot',
  address: 'Surat'
}

const movement = (over: Partial<BranchTransferMovement> = {}): BranchTransferMovement => ({
  voucherId: 7,
  date: '2026-06-10',
  voucherNumber: 'SJ-3',
  from: mh,
  to: gj,
  lines: [
    { description: 'Cotton shirt', hsn: '6205', qtyMilli: 10_000, unit: 'PCS', bookValue: 100_000_00, rate: 12, cessRate: 0 }
  ],
  ...over
})

describe('rule 28, as dated data', () => {
  it('cites rule 28 before the 2023 renumbering and rule 28(1) after it', () => {
    expect(rule28On('2020-01-01').citation).toBe('rule 28')
    expect(rule28On('2026-06-10').citation).toBe('rule 28(1)')
    expect(rule28BasisCitation('declared-full-itc', '2020-01-01')).toContain('Second proviso to rule 28 —')
    expect(rule28BasisCitation('declared-full-itc', '2026-06-10')).toContain('Second proviso to rule 28(1) —')
  })

  it('gives a date before the first entry the first entry rather than refusing', () => {
    expect(rule28On('2015-01-01')).toBe(RULE28_HISTORY[0])
  })

  it('marks the entry it has not checked against the notification', () => {
    expect(rule28On('2026-06-10').unverified).toBe(true)
  })
})

describe('rule 28 valuation', () => {
  it('deems the declared value to be the open market value under the second proviso', () => {
    expect(rule28Value('declared-full-itc', { bookValuePaise: 100_000_00, declaredPaise: 90_000_00 })).toBe(90_000_00)
  })

  it('falls back to book value when nothing was declared — the practical answer', () => {
    expect(rule28Value('declared-full-itc', { bookValuePaise: 100_000_00 })).toBe(100_000_00)
  })

  it('takes 110% of cost under rule 30, in whole paise', () => {
    expect(rule28Value('cost-110', { bookValuePaise: 100_000_01 })).toBe(110_000_01)
    expect(Number.isInteger(rule28Value('cost-110', { bookValuePaise: 33_333_33 }))).toBe(true)
  })

  it('takes 90% of the recipient’s onward price under the first proviso', () => {
    expect(rule28Value('ninety-percent', { bookValuePaise: 0, recipientPricePaise: 200_000_00 })).toBe(180_000_00)
  })

  it('refuses to invent an open market value the books do not hold', () => {
    expect(rule28Value('open-market', { bookValuePaise: 100_000_00 })).toBeNull()
    expect(rule28Value('like-kind', { bookValuePaise: 100_000_00 })).toBeNull()
    expect(rule28Value('ninety-percent', { bookValuePaise: 100_000_00 })).toBeNull()
  })
})

describe('the invoice', () => {
  it('charges IGST when the two registrations are in different states', () => {
    const doc = buildBranchTransferInvoice({
      movement: movement(),
      number: 'BT/27/2026-27/0001',
      basis: 'declared-full-itc',
      recipientFullItc: true
    })
    expect(doc.supplyType).toBe('inter')
    expect(doc.totals.igst).toBe(12_000_00)
    expect(doc.totals.cgst).toBe(0)
    expect(doc.totals.sgst).toBe(0)
    // Section 10(1)(a) IGST Act — where the movement terminates.
    expect(doc.placeOfSupply).toBe('24')
  })

  it('charges CGST+SGST between two registrations in one state', () => {
    const doc = buildBranchTransferInvoice({
      movement: movement({ to: { ...gj, stateCode: '27' } }),
      number: 'BT/27/2026-27/0001',
      basis: 'declared-full-itc',
      recipientFullItc: true
    })
    expect(doc.supplyType).toBe('intra')
    expect(doc.totals.cgst).toBe(6_000_00)
    expect(doc.totals.sgst).toBe(6_000_00)
    expect(doc.totals.igst).toBe(0)
  })

  it('is dated on the movement, not on the day it was printed', () => {
    const doc = buildBranchTransferInvoice({
      movement: movement({ date: '2026-04-02' }),
      number: 'BT/27/2026-27/0001',
      basis: 'declared-full-itc',
      recipientFullItc: true
    })
    expect(doc.date).toBe('2026-04-02')
  })

  it('splits a hand-fixed value across lines pro rata, to the paise', () => {
    const doc = buildBranchTransferInvoice({
      movement: movement({
        lines: [
          { description: 'A', hsn: '1', qtyMilli: 1000, unit: 'PCS', bookValue: 33_33_33, rate: 18, cessRate: 0 },
          { description: 'B', hsn: '2', qtyMilli: 1000, unit: 'PCS', bookValue: 33_33_33, rate: 18, cessRate: 0 },
          { description: 'C', hsn: '3', qtyMilli: 1000, unit: 'PCS', bookValue: 33_33_34, rate: 18, cessRate: 0 }
        ]
      }),
      number: 'BT/27/2026-27/0001',
      basis: 'open-market',
      recipientFullItc: true,
      declaredPaise: 100_00_01
    })
    // The parts sum to the whole exactly — an invoice that does not add up to its own total is
    // not a rounding nicety, it is a document nobody can reconcile.
    expect(doc.lines.reduce((t, l) => t + l.taxable, 0)).toBe(100_00_01)
    expect(doc.totals.taxable).toBe(100_00_01)
    for (const l of doc.lines) expect(Number.isInteger(l.taxable)).toBe(true)
  })

  it('carries the citation for the rule text in force on its own date', () => {
    const doc = buildBranchTransferInvoice({
      movement: movement({ date: '2019-06-10' }),
      number: 'BT/27/2019-20/0001',
      basis: 'ninety-percent',
      recipientFullItc: true,
      recipientPricePaise: 200_000_00
    })
    expect(doc.basisCitation).toContain('First proviso to rule 28 —')
    expect(doc.basisCitation).not.toContain('28(1)')
  })
})

describe('what the invoice cannot say for itself', () => {
  it('says so when the receiving registration does not take full credit', () => {
    const w = branchTransferWarnings(movement(), 'declared-full-itc', { recipientFullItc: false })
    expect(w.join(' ')).toContain('the tax on it is a real cost')
    expect(w.join(' ')).toContain('NOT in your books')
    // And that the proviso relied on is not available in that case.
    expect(w.join(' ')).toContain('That proviso is only available where it does')
  })

  it('says nothing about the books when the recipient takes full credit', () => {
    const w = branchTransferWarnings(movement(), 'declared-full-itc', { recipientFullItc: true })
    expect(w).toEqual([])
  })

  it('flags a missing GSTIN on either side, and a missing HSN', () => {
    const w = branchTransferWarnings(
      movement({ to: { ...gj, gstin: null }, lines: [{ description: 'X', hsn: null, qtyMilli: 1, unit: null, bookValue: 100, rate: 5, cessRate: 0 }] }),
      'declared-full-itc',
      { recipientFullItc: true }
    )
    expect(w.join(' ')).toContain('not a supply between distinct persons')
    expect(w.join(' ')).toContain('Rule 46(g)')
  })

  it('flags a nil rate, because a branch transfer is taxed at the goods’ own rate', () => {
    const w = branchTransferWarnings(
      movement({ lines: [{ description: 'X', hsn: '1', qtyMilli: 1, unit: null, bookValue: 100, rate: 0, cessRate: 0 }] }),
      'declared-full-itc',
      { recipientFullItc: true }
    )
    expect(w.join(' ')).toContain('carry a nil rate')
  })
})

describe('the serial', () => {
  it('is per sending registration and per financial year — Rule 46(b)', () => {
    expect(branchTransferNumber('27', '2026-27', 3)).toBe('BT/27/2026-27/0003')
    expect(branchTransferNumber('24', '2026-27', 3)).toBe('BT/24/2026-27/0003')
  })
})

describe('totals', () => {
  it('sums book value and every tax head', () => {
    const t = sumBranchTransferLines([
      { description: 'A', hsn: '1', qtyMilli: 0, unit: null, bookValue: 100, taxable: 120, rate: 5, cessRate: 1, igst: 6, cgst: 0, sgst: 0, cess: 1 },
      { description: 'B', hsn: '2', qtyMilli: 0, unit: null, bookValue: 200, taxable: 200, rate: 5, cessRate: 0, igst: 10, cgst: 0, sgst: 0, cess: 0 }
    ])
    expect(t).toEqual({ bookValue: 300, taxable: 320, igst: 16, cgst: 0, sgst: 0, cess: 1, total: 337 })
  })
})
