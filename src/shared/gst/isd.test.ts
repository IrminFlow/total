import { describe, expect, it } from 'vitest'
import {
  apportion,
  buildDistribution,
  buildGstr6,
  convertHeads,
  distributeCredit,
  distributionWarnings,
  gstr6DueDate,
  isdInvoiceNumber,
  isdRulesForMonth,
  isdRulesOn,
  lastQuarterBefore,
  precedingFinancialYear,
  relevantPeriodFor,
  type IsdCredit,
  type IsdRecipient
} from './isd'

const recipient = (id: number, state: string, turnover: number): IsdRecipient & { address: string | null } => ({
  registrationId: id,
  gstin: `${state}AAAAA0000A1Z5`,
  stateCode: state,
  tradeName: `Branch ${state}`,
  address: null,
  turnoverPaise: turnover,
  turnoverDeclared: false
})

const credit = (over: Partial<IsdCredit> = {}): IsdCredit => ({
  id: 1,
  date: '2026-06-12',
  supplierName: 'Audit LLP',
  supplierGstin: '27AAAAA0000A1Z5',
  invoiceNumber: 'A/26/9',
  description: 'Statutory audit fee',
  taxable: 100_000_00,
  heads: { igst: 0, cgst: 9_000_00, sgst: 9_000_00, cess: 0 },
  eligibility: 'eligible',
  attribution: 'all',
  recipientRegistrationIds: [],
  reverseCharge: false,
  ...over
})

describe('the rules, as dated data', () => {
  it('was optional before 1 April 2025 and is mandatory after', () => {
    expect(isdRulesOn('2024-12-31').mandatory).toBe(false)
    expect(isdRulesOn('2025-04-01').mandatory).toBe(true)
    expect(isdRulesForMonth('2025-03').mandatory).toBe(false)
    expect(isdRulesForMonth('2025-04').mandatory).toBe(true)
  })

  it('only distributes reverse-charge credit once the 2024 substitution is in force', () => {
    expect(isdRulesOn('2024-06-01').distributesRcmCredit).toBe(false)
    expect(isdRulesOn('2026-06-01').distributesRcmCredit).toBe(true)
  })

  it('cites the notification that made each entry, and no longer calls either unverified', () => {
    // The 1 Apr 2025 commencement is CBIC's own footnote on s.20 and on rule 39, which agree; the
    // rule 39 footnote also names the appointing notification for the rules (9/2025-CT, 11 Feb 2025).
    for (const date of ['2018-06-01', '2026-06-01']) {
      expect(isdRulesOn(date).unverified ?? false).toBe(false)
      expect(isdRulesOn(date).authority).toBeTruthy()
    }
    expect(isdRulesOn('2026-06-01').authority).toContain('16/2024-Central Tax')
    expect(isdRulesOn('2026-06-01').authority).toContain('12/2024-Central Tax')
  })

  it('treats cess-to-cess as checked — FORM GSTR-6 has a CESS column in its distribution table', () => {
    expect(isdRulesOn('2026-06-01').cessVerified).toBe(true)
  })
})

describe('GSTR-6 is due on the 13th — section 39(4)', () => {
  it('lands on the 13th of the following month', () => {
    expect(gstr6DueDate('2026-06')).toBe('2026-07-13')
    expect(gstr6DueDate('2026-12')).toBe('2027-01-13')
  })
})

describe('the relevant period — rule 39 Explanation', () => {
  it('is the preceding financial year when every recipient had turnover in it', () => {
    const p = relevantPeriodFor('2026-06', true)
    expect(p.kind).toBe('preceding-fy')
    expect(p).toMatchObject({ from: '2025-04-01', to: '2026-03-31' })
  })

  it('falls back to the last quarter when one recipient did not', () => {
    const p = relevantPeriodFor('2026-06', false)
    expect(p.kind).toBe('last-quarter')
    expect(p).toMatchObject({ from: '2026-01-01', to: '2026-03-31' })
  })

  it('knows which financial year precedes a January month', () => {
    expect(precedingFinancialYear('2026-01')).toMatchObject({ from: '2024-04-01', to: '2025-03-31' })
  })

  it('wraps to the previous year’s Q4 in January', () => {
    expect(lastQuarterBefore('2026-01')).toMatchObject({ from: '2025-10-01', to: '2025-12-31' })
  })
})

describe('apportionment is exact to the paise', () => {
  it('splits pro rata on turnover', () => {
    expect(apportion(1000, [1, 1])).toEqual([500, 500])
    expect(apportion(900, [2, 1])).toEqual([600, 300])
  })

  it('hands the rounding residue out by largest remainder, so the parts sum to the whole', () => {
    const parts = apportion(100, [1, 1, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100)
    for (const p of parts) expect(Number.isInteger(p)).toBe(true)
  })

  it('never loses or gains a paisa on an awkward ratio', () => {
    const weights = [123_456_78, 98_765_43, 7_654_32]
    for (const amount of [1, 7, 999, 1_00_00_01]) {
      expect(apportion(amount, weights).reduce((a, b) => a + b, 0)).toBe(amount)
    }
  })

  it('splits equally when nobody has any turnover, rather than dividing by zero', () => {
    expect(apportion(300, [0, 0, 0])).toEqual([100, 100, 100])
  })
})

describe('head conversion on distribution', () => {
  it('keeps CGST and SGST for a recipient in the distributor’s own state', () => {
    expect(convertHeads({ igst: 0, cgst: 500, sgst: 500, cess: 0 }, true)).toEqual({
      igst: 0, cgst: 500, sgst: 500, cess: 0
    })
  })

  it('turns CGST+SGST into IGST for a recipient in another state — the invisible one', () => {
    expect(convertHeads({ igst: 100, cgst: 500, sgst: 500, cess: 7 }, false)).toEqual({
      igst: 1100, cgst: 0, sgst: 0, cess: 7
    })
  })
})

describe('distributing one credit', () => {
  const recipients = [recipient(2, '27', 60_00_000), recipient(3, '24', 40_00_000)]

  it('apportions on turnover and converts heads per recipient', () => {
    const shares = distributeCredit({ credit: credit(), recipients, isdStateCode: '27' })
    // 60:40 of ₹9,000 CGST and ₹9,000 SGST.
    expect(shares[0]).toMatchObject({ registrationId: 2, heads: { igst: 0, cgst: 5_400_00, sgst: 5_400_00, cess: 0 } })
    // Gujarat is outside the Maharashtra ISD's state: CGST+SGST arrives as IGST.
    expect(shares[1]).toMatchObject({ registrationId: 3, heads: { igst: 7_200_00, cgst: 0, sgst: 0, cess: 0 } })
    // And the whole credit was distributed.
    const total = shares.reduce((t, s) => t + s.heads.igst + s.heads.cgst + s.heads.sgst, 0)
    expect(total).toBe(18_000_00)
  })

  it('gives credit attributable to one registration to that one whole, unapportioned', () => {
    const shares = distributeCredit({
      credit: credit({ attribution: 'one', recipientRegistrationIds: [3] }),
      recipients,
      isdStateCode: '27'
    })
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ registrationId: 3, heads: { igst: 18_000_00 } })
  })

  it('apportions credit attributable to some among those only', () => {
    const three = [...recipients, recipient(4, '29', 100_00_000)]
    const shares = distributeCredit({
      credit: credit({ attribution: 'some', recipientRegistrationIds: [2, 3] }),
      recipients: three,
      isdStateCode: '27'
    })
    expect(shares.map((s) => s.registrationId)).toEqual([2, 3])
  })
})

describe('the month', () => {
  const recipients = [recipient(2, '27', 60_00_000), recipient(3, '24', 40_00_000)]
  const period = relevantPeriodFor('2026-06', true)
  const build = (credits: IsdCredit[]) =>
    buildDistribution({
      month: '2026-06',
      date: '2026-06-30',
      fyLabel: '2026-27',
      isd: { registrationId: 1, gstin: '27AAAAA0000A1Z9', stateCode: '27', tradeName: 'ISD', address: null },
      recipients,
      credits,
      period,
      numberFor: (i) => isdInvoiceNumber('2026-27', i + 1)
    })

  it('issues one invoice per recipient, serially numbered', () => {
    const r = build([credit()])
    expect(r.invoices.map((i) => i.number)).toEqual(['ISD/2026-27/0001', 'ISD/2026-27/0002'])
  })

  it('distributes exactly what it received', () => {
    const r = build([credit(), credit({ id: 2, eligibility: 'ineligible', heads: { igst: 5_000_00, cgst: 0, sgst: 0, cess: 0 } })])
    expect(r.distributed.eligible.cgst + r.distributed.eligible.sgst + r.distributed.eligible.igst).toBe(18_000_00)
    expect(r.distributed.ineligible.igst).toBe(5_000_00)
    expect(r.received.eligible.cgst).toBe(9_000_00)
  })

  it('keeps eligible and ineligible separate on the document — rule 39', () => {
    const r = build([credit({ eligibility: 'ineligible' })])
    for (const inv of r.invoices) {
      expect(inv.eligible).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
      expect(inv.ineligible.igst + inv.ineligible.cgst + inv.ineligible.sgst).toBeGreaterThan(0)
    }
  })

  it('does not spend a serial on a recipient that receives nothing', () => {
    const r = buildDistribution({
      month: '2026-06',
      date: '2026-06-30',
      fyLabel: '2026-27',
      isd: { registrationId: 1, gstin: '27AAAAA0000A1Z9', stateCode: '27', tradeName: 'ISD', address: null },
      recipients: [recipient(2, '27', 100_00_000), recipient(3, '24', 0)],
      credits: [credit()],
      period,
      numberFor: (i) => isdInvoiceNumber('2026-27', i + 1)
    })
    expect(r.invoices).toHaveLength(1)
    expect(r.invoices[0]!.recipient.registrationId).toBe(2)
  })
})

describe('what a distribution cannot say for itself', () => {
  const period = relevantPeriodFor('2026-06', true)

  it('says a nil-turnover recipient gets nothing, and why that may not be right', () => {
    const w = distributionWarnings({
      month: '2026-06',
      recipients: [recipient(2, '27', 100), recipient(3, '24', 0)],
      credits: [credit()],
      period
    })
    expect(w.join(' ')).toContain('receive nothing')
  })

  it('no longer says the rules applied are unverified, because they are not', () => {
    const w = distributionWarnings({ month: '2026-06', recipients: [recipient(2, '27', 100)], credits: [credit()], period })
    expect(w.join(' ')).not.toContain('not been checked against the notification')
  })

  it('says the ISD was optional for a month before April 2025', () => {
    const w = distributionWarnings({ month: '2024-06', recipients: [recipient(2, '27', 100)], credits: [credit()], period })
    expect(w.join(' ')).toContain('was optional')
  })

  it('no longer warns about cess — cess-to-cess is checked and cess needs no head conversion', () => {
    const w = distributionWarnings({
      month: '2026-06',
      recipients: [recipient(2, '27', 100)],
      credits: [credit({ heads: { igst: 0, cgst: 100, sgst: 100, cess: 50 } })],
      period
    })
    expect(w.join(' ')).not.toContain('compensation cess')
  })

  it('flags a hand-typed turnover, because rule 39 wants a figure these books may not hold', () => {
    const w = distributionWarnings({
      month: '2026-06',
      recipients: [{ ...recipient(2, '27', 100), turnoverDeclared: true }],
      credits: [credit()],
      period
    })
    expect(w.join(' ')).toContain('entered by hand')
  })
})

describe('GSTR-6', () => {
  it('reports the due date, the inward invoices, and anything undistributed', () => {
    const period = relevantPeriodFor('2026-06', true)
    const credits = [credit()]
    const result = buildDistribution({
      month: '2026-06',
      date: '2026-06-30',
      fyLabel: '2026-27',
      isd: { registrationId: 1, gstin: '27AAAAA0000A1Z9', stateCode: '27', tradeName: 'ISD', address: null },
      recipients: [recipient(2, '27', 60_00_000), recipient(3, '24', 40_00_000)],
      credits,
      period,
      numberFor: (i) => isdInvoiceNumber('2026-27', i + 1)
    })
    const g6 = buildGstr6(result, { isdGstin: '27AAAAA0000A1Z9', credits })
    expect(g6.dueDate).toBe('2026-07-13')
    expect(g6.inward).toHaveLength(1)
    expect(g6.distribution).toHaveLength(2)
    // Everything received was distributed, so nothing is left over. Compared as a total, because
    // CGST+SGST leaves as IGST for the Gujarat recipient and a per-head comparison would report a
    // shortfall on a distribution that is complete.
    expect(g6.undistributedPaise).toBe(0)
    // The table numbering is now read in FORM GSTR-6 itself, so it no longer claims to be a guess.
    expect(g6.layoutUnverified).toBe(false)
    expect(g6.formCitation).toContain('rule 65')
  })
})
