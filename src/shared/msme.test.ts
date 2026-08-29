import { describe, expect, it } from 'vitest'
import {
  allowedDays,
  coveredBy43B,
  describeLimit,
  msmeDueDate,
  msmeInterest,
  msmeReport,
  MSME_LIMIT_NO_AGREEMENT,
  MSME_LIMIT_WITH_AGREEMENT,
  type MsmePartyInput
} from './msme'

describe('who section 43B(h) reaches', () => {
  it('covers micro and small, and nobody else', () => {
    expect(coveredBy43B('micro')).toBe(true)
    expect(coveredBy43B('small')).toBe(true)
    // Medium enterprises are outside 43B(h) — the mistake a spreadsheet makes in the taxpayer's
    // favour, which is the expensive direction.
    expect(coveredBy43B('medium')).toBe(false)
    expect(coveredBy43B('not_registered')).toBe(false)
    expect(coveredBy43B(null)).toBe(false)
  })
})

describe('the section 15 limit', () => {
  it('is 15 days when there is no agreement on record', () => {
    expect(allowedDays(null)).toBe(MSME_LIMIT_NO_AGREEMENT)
    expect(allowedDays(0)).toBe(MSME_LIMIT_NO_AGREEMENT)
    expect(describeLimit(null)).toContain('no agreement')
  })

  it('is the agreed period when one is shorter than 45 days', () => {
    expect(allowedDays(30)).toBe(30)
    expect(describeLimit(30)).toBe('30 days (agreed)')
  })

  it('caps an agreed period at 45 days, however long it was agreed for', () => {
    expect(allowedDays(90)).toBe(MSME_LIMIT_WITH_AGREEMENT)
    expect(describeLimit(90)).toContain('capped by section 15')
  })

  it('dates the deadline from the bill', () => {
    expect(msmeDueDate('2026-01-01', 45)).toBe('2026-02-15')
    expect(msmeDueDate('2026-01-01', null)).toBe('2026-01-16')
    expect(msmeDueDate('2026-01-31', 45)).toBe('2026-03-17')
  })
})

describe('section 16 interest', () => {
  it('is three times the bank rate, compounded monthly', () => {
    // ₹1,00,000 at a 6.5% bank rate → 19.5% a year, one month.
    const oneMonth = msmeInterest(1_00_000_00, 6.5, 30)
    expect(oneMonth).toBe(Math.floor(1_00_000_00 * (1 + 0.195 / 12) - 1_00_000_00))
    // A year of compounding beats twelve times one month's simple interest.
    expect(msmeInterest(1_00_000_00, 6.5, 360)).toBeGreaterThan(oneMonth * 12)
  })

  it('charges nothing on a bill inside the limit, or at a zero rate', () => {
    expect(msmeInterest(1_00_000_00, 6.5, 0)).toBe(0)
    expect(msmeInterest(1_00_000_00, 0, 90)).toBe(0)
    expect(msmeInterest(0, 6.5, 90)).toBe(0)
  })

  it('is integer paise', () => {
    expect(Number.isInteger(msmeInterest(33_333, 6.5, 47))).toBe(true)
  })
})

describe('the disallowance report', () => {
  const party = (over: Partial<MsmePartyInput>): MsmePartyInput => ({
    ledgerId: 1,
    name: 'Supplier',
    status: 'small',
    udyamNumber: 'UDYAM-MH-01-0000001',
    creditDays: 30,
    bills: [{ number: 'P-1', date: '2026-01-01', pending: 1_00_000_00, creditDays: 30 }],
    ...over
  })

  it('disallows a bill past its limit and leaves one inside it alone', () => {
    const late = msmeReport([party({})], '2026-03-31', 6.5)
    expect(late.totalDisallowed).toBe(1_00_000_00)
    expect(late.parties[0]!.bills[0]!.disallowed).toBe(true)

    const early = msmeReport([party({})], '2026-01-20', 6.5)
    expect(early.totalDisallowed).toBe(0)
    expect(early.parties[0]!.bills[0]!.disallowed).toBe(false)
    // Still reported, because it is about to become a problem.
    expect(early.totalPending).toBe(1_00_000_00)
  })

  it('leaves medium and unregistered suppliers out entirely', () => {
    for (const status of ['medium', 'not_registered'] as const) {
      const r = msmeReport([party({ status })], '2026-03-31', 6.5)
      expect(r.parties).toEqual([])
      expect(r.totalDisallowed).toBe(0)
    }
  })

  it('counts an unclassified supplier loudly rather than treating silence as an exemption', () => {
    const r = msmeReport([party({ status: null })], '2026-03-31', 6.5)
    expect(r.parties).toEqual([])
    expect(r.unclassifiedParties).toBe(1)
    expect(r.unclassifiedPending).toBe(1_00_000_00)
    expect(r.totalDisallowed).toBe(0)
  })

  it('ignores a party with nothing outstanding, whatever their status', () => {
    const r = msmeReport([party({ bills: [] }), party({ ledgerId: 2, status: null, bills: [] })], '2026-03-31', 6.5)
    expect(r.parties).toEqual([])
    expect(r.unclassifiedParties).toBe(0)
  })

  it('uses the 15-day limit where no credit period is agreed', () => {
    const r = msmeReport(
      [party({ creditDays: null, bills: [{ number: 'P-1', date: '2026-01-01', pending: 5_000_00, creditDays: null }] })],
      '2026-01-20',
      6.5
    )
    // Due 16 January, so by the 20th it is already disallowed — where 30 agreed days would not be.
    expect(r.parties[0]!.bills[0]!.dueDate).toBe('2026-01-16')
    expect(r.totalDisallowed).toBe(5_000_00)
  })

  it('ranks the largest exposure first and the worst bill first within it', () => {
    const r = msmeReport(
      [
        party({ ledgerId: 1, name: 'Small', bills: [{ number: 'A', date: '2026-01-01', pending: 10_000_00, creditDays: 30 }] }),
        party({
          ledgerId: 2,
          name: 'Big',
          bills: [
            { number: 'B', date: '2026-02-01', pending: 50_000_00, creditDays: 30 },
            { number: 'C', date: '2025-06-01', pending: 20_000_00, creditDays: 30 }
          ]
        })
      ],
      '2026-03-31',
      6.5
    )
    expect(r.parties.map((p) => p.name)).toEqual(['Big', 'Small'])
    expect(r.parties[0]!.bills.map((b) => b.number)).toEqual(['C', 'B'])
  })

  it('foots: party totals sum to the report totals', () => {
    const r = msmeReport(
      [
        party({ ledgerId: 1, name: 'A' }),
        party({ ledgerId: 2, name: 'B', status: 'micro', bills: [{ number: 'X', date: '2025-12-01', pending: 7_000_00, creditDays: null }] })
      ],
      '2026-03-31',
      6.5
    )
    expect(r.totalDisallowed).toBe(r.parties.reduce((s, p) => s + p.disallowed, 0))
    expect(r.totalPending).toBe(r.parties.reduce((s, p) => s + p.pending, 0))
    expect(r.totalInterest).toBe(r.parties.reduce((s, p) => s + p.interest, 0))
  })

  it('explains each bill: the limit it was measured against, and how far past it is', () => {
    const line = msmeReport([party({})], '2026-03-31', 6.5).parties[0]!.bills[0]!
    expect(line.limitLabel).toBe('30 days (agreed)')
    expect(line.dueDate).toBe('2026-01-31')
    expect(line.overdueDays).toBe(59)
    expect(line.interest).toBeGreaterThan(0)
  })
})
