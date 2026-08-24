import { describe, expect, it } from 'vitest'
import { bandIndex, bandLabels, bucketByBand, normaliseBandCuts, validBandCuts } from './ageing'
import { computeProvision, DEFAULT_PROVISION_POLICY, provisionPct, validPolicy } from './badDebt'
import { creditScore, explainScore, MIN_SAMPLE } from './creditScore'
import { describeTerms, interestOnBills, simpleInterest } from './interest'
import { fifoAllocate, suggestAllocations } from './allocationSuggest'
import { buildReminder, toneFor } from './outstanding'
import type { OutstandingBill } from './reports'

function bill(number: string, date: string, pending: number, overdueDays = 0): OutstandingBill {
  return { voucherId: null, number, date, amount: pending, pending, ageDays: overdueDays, dueDate: null, overdueDays }
}

describe('ageing bands', () => {
  it('labels the default cuts the way every ageing report does', () => {
    expect(bandLabels([30, 60, 90])).toEqual(['0-30 days', '31-60 days', '61-90 days', '90+ days'])
  })

  it('supports a trade on 45-day terms', () => {
    expect(bandLabels([45, 90, 180])).toEqual(['0-45 days', '46-90 days', '91-180 days', '180+ days'])
  })

  it('rejects unordered, negative or empty cuts instead of repairing them', () => {
    expect(validBandCuts([60, 30])).toBe(false)
    expect(validBandCuts([0, 30])).toBe(false)
    expect(validBandCuts([])).toBe(false)
    expect(validBandCuts([30, 30])).toBe(false)
    expect(normaliseBandCuts([60, 30])).toEqual([30, 60, 90])
  })

  it('puts a day exactly on a cut in the lower band', () => {
    expect(bandIndex(30, [30, 60, 90])).toBe(0)
    expect(bandIndex(31, [30, 60, 90])).toBe(1)
    expect(bandIndex(9999, [30, 60, 90])).toBe(3)
  })

  it('buckets pending amounts and always returns cuts+1 buckets', () => {
    const bills = [
      { pending: 1000, overdueDays: 0 },
      { pending: 2000, overdueDays: 45 },
      { pending: 4000, overdueDays: 400 }
    ]
    expect(bucketByBand(bills, [30, 60, 90])).toEqual([1000, 2000, 0, 4000])
    expect(bucketByBand(bills, [365])).toEqual([3000, 4000])
  })
})

describe('interest on overdue bills', () => {
  it('is simple interest on actual days, floored to the paisa', () => {
    // ₹1,00,000 at 18% for 365 days = ₹18,000.
    expect(simpleInterest(10_000_000, 1800, 365)).toBe(1_800_000)
    // 30 days of the same: 10000000*1800*30/(10000*365) = 147945.20… → floored.
    expect(simpleInterest(10_000_000, 1800, 30)).toBe(147_945)
  })

  it('never charges on a bill that is not overdue, or at a zero rate', () => {
    expect(simpleInterest(10_000_000, 1800, 0)).toBe(0)
    expect(simpleInterest(10_000_000, 1800, -5)).toBe(0)
    expect(simpleInterest(10_000_000, 0, 90)).toBe(0)
    expect(simpleInterest(-100, 1800, 90)).toBe(0)
  })

  it('applies grace days but keeps the bill on the statement', () => {
    const r = interestOnBills([bill('INV-1', '2026-01-01', 10_000_000, 5)], { rateBp: 1800, graceDays: 7 })
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]!.overdueDays).toBe(5)
    expect(r.lines[0]!.chargeableDays).toBe(0)
    expect(r.total).toBe(0)
  })

  it('totals across bills', () => {
    const r = interestOnBills(
      [bill('A', '2026-01-01', 10_000_000, 40), bill('B', '2026-01-01', 10_000_000, 40)],
      { rateBp: 1800, graceDays: 10 }
    )
    expect(r.lines.every((l) => l.chargeableDays === 30)).toBe(true)
    expect(r.total).toBe(147_945 * 2)
  })

  it('describes its own terms', () => {
    expect(describeTerms({ rateBp: 1800, graceDays: 0 })).toBe('18% p.a.')
    expect(describeTerms({ rateBp: 1250, graceDays: 1 })).toBe('12.50% p.a. after 1 day')
    expect(describeTerms({ rateBp: 2400, graceDays: 7 })).toBe('24% p.a. after 7 days')
  })
})

describe('credit scoring', () => {
  const punctual = Array.from({ length: 6 }, () => ({ amount: 100_000, daysLate: -2 }))

  it('refuses to score below a real sample', () => {
    expect(creditScore(Array.from({ length: MIN_SAMPLE - 1 }, () => ({ amount: 1, daysLate: 0 })))).toBeNull()
  })

  it('scores a party who always pays early at the top band', () => {
    const s = creditScore(punctual)!
    expect(s.band).toBe('excellent')
    expect(s.onTimeRate).toBe(1)
    expect(s.avgDaysLate).toBe(-2)
  })

  it('drops a chronic late payer to poor', () => {
    const s = creditScore(Array.from({ length: 6 }, () => ({ amount: 100_000, daysLate: 120 })))!
    expect(s.band).toBe('poor')
    expect(s.worstDaysLate).toBe(120)
  })

  it('weights by amount — one big late bill outweighs several small prompt ones', () => {
    const light = creditScore([...punctual, { amount: 100_000, daysLate: 60 }])!
    const heavy = creditScore([...punctual, { amount: 100_000_000, daysLate: 60 }])!
    expect(heavy.score).toBeLessThan(light.score)
  })

  it('lets present overdue exposure pull a good history down', () => {
    const clean = creditScore(punctual, [{ amount: 500_000, overdueDays: 0 }])!
    const dirty = creditScore(punctual, [{ amount: 500_000, overdueDays: 45 }])!
    expect(dirty.score).toBeLessThan(clean.score)
    expect(dirty.overdueNow).toBe(500_000)
  })

  it('explains itself in words the owner would use', () => {
    expect(explainScore(creditScore(punctual)!)).toBe('pays 2 days early on average, 100% of 6 bills on time')
  })
})

describe('allocation suggestions', () => {
  const bills = [bill('INV-1', '2026-01-01', 500_00), bill('INV-2', '2026-01-05', 300_00), bill('INV-3', '2026-01-09', 200_00)]

  it('offers nothing when there is nothing to offer', () => {
    expect(suggestAllocations([], 10_000)).toEqual([])
    expect(suggestAllocations(bills, 0)).toEqual([])
  })

  it('spots a single bill paid to the paisa', () => {
    const s = suggestAllocations(bills, 300_00)
    expect(s[0]!.kind).toBe('exact-single')
    expect(s[0]!.label).toBe('Clears INV-2 exactly')
  })

  it('finds a combination that adds up exactly', () => {
    const s = suggestAllocations(bills, 700_00)
    const combo = s.find((x) => x.kind === 'exact-combination')!
    expect(combo.allocations.map((a) => a.number).sort()).toEqual(['INV-1', 'INV-3'])
    expect(combo.leftover).toBe(0)
  })

  it('falls back to oldest-first and names the part-paid bill', () => {
    const s = suggestAllocations(bills, 600_00)
    const fifo = s.find((x) => x.kind === 'fifo-partial')!
    expect(fifo.allocations.map((a) => a.applied)).toEqual([500_00, 100_00])
    expect(fifo.label).toContain('part-pays INV-2')
  })

  it('reports an overpayment as money left on account rather than swallowing it', () => {
    const { allocations, leftover } = fifoAllocate(bills, 1_500_00)
    expect(allocations).toHaveLength(3)
    expect(leftover).toBe(500_00)
    const s = suggestAllocations(bills, 1_500_00)
    expect(s.some((x) => x.leftover === 500_00)).toBe(true)
  })

  it('does not offer FIFO twice when it is already the exact answer', () => {
    const one = [bill('ONLY', '2026-01-01', 100_00)]
    const s = suggestAllocations(one, 100_00)
    expect(s).toHaveLength(1)
    expect(s[0]!.kind).toBe('exact-single')
  })
})

describe('reminder letters', () => {
  const company = { name: 'Demo Traders' }
  const party = { name: 'Sharma & Co', email: 'a@b.com', phone: '9876543210' }

  it('escalates tone with the worst overdue bill', () => {
    expect(toneFor(0)).toBe('gentle')
    expect(toneFor(45)).toBe('firm')
    expect(toneFor(120)).toBe('final')
  })

  it('groups bills under ageing bands when more than one band is in play', () => {
    const r = buildReminder(company, party, [bill('A', '2026-01-01', 100_00, 5), bill('B', '2025-09-01', 200_00, 150)])
    expect(r.body).toContain('0-30 days')
    expect(r.body).toContain('90+ days')
    expect(r.body).toContain('Despite earlier reminders')
  })

  it('stays a short note when every bill is in one band', () => {
    const r = buildReminder(company, party, [bill('A', '2026-01-01', 100_00, 5)])
    expect(r.body).not.toContain('0-30 days')
    expect(r.body).toContain('A gentle reminder')
  })

  it('honours custom band cuts', () => {
    const r = buildReminder(company, party, [bill('A', '2026-01-01', 100_00, 5), bill('B', '2025-12-01', 200_00, 50)], {
      bandCuts: [45, 90]
    })
    expect(r.body).toContain('0-45 days')
    expect(r.body).toContain('46-90 days')
  })

  it('states interest only when there is some to state', () => {
    const bills = [bill('A', '2026-01-01', 100_00, 90)]
    expect(buildReminder(company, party, bills, { interest: { total: 0, terms: '18% p.a.' } }).body).not.toContain('Interest')
    expect(buildReminder(company, party, bills, { interest: { total: 4_44, terms: '18% p.a.' } }).body).toContain(
      'Interest at 18% p.a.'
    )
  })

  it('sends the same text down both channels', () => {
    const r = buildReminder(company, party, [bill('A', '2026-01-01', 100_00, 5)])
    expect(decodeURIComponent(r.whatsapp!.split('text=')[1]!)).toBe(r.body)
    expect(r.mailto).toContain(encodeURIComponent('Payment reminder from Demo Traders'))
  })
})

describe('bad-debt provisioning', () => {
  it('applies the highest rule the bill has passed', () => {
    expect(provisionPct(30, DEFAULT_PROVISION_POLICY)).toBe(0)
    expect(provisionPct(181, DEFAULT_PROVISION_POLICY)).toBe(25)
    expect(provisionPct(366, DEFAULT_PROVISION_POLICY)).toBe(50)
    expect(provisionPct(1000, DEFAULT_PROVISION_POLICY)).toBe(100)
    // Exactly on the threshold has not passed it.
    expect(provisionPct(180, DEFAULT_PROVISION_POLICY)).toBe(0)
  })

  it('rejects a policy that goes backwards', () => {
    expect(validPolicy([{ afterDays: 365, pct: 50 }, { afterDays: 180, pct: 25 }])).toBe(false)
    expect(validPolicy([{ afterDays: 180, pct: 50 }, { afterDays: 365, pct: 25 }])).toBe(false)
    expect(validPolicy([{ afterDays: 180, pct: 101 }])).toBe(false)
    expect(validPolicy(DEFAULT_PROVISION_POLICY)).toBe(true)
  })

  it('shows the shortlist only, with per-bill working', () => {
    const r = computeProvision([
      { ledgerId: 1, name: 'Recent Co', bills: [{ number: 'A', date: '2026-08-01', pending: 100_00, overdueDays: 10 }] },
      {
        ledgerId: 2,
        name: 'Old Co',
        bills: [
          { number: 'B', date: '2025-01-01', pending: 100_00, overdueDays: 400 },
          { number: 'C', date: '2026-08-01', pending: 900_00, overdueDays: 3 }
        ]
      }
    ])
    expect(r.parties.map((p) => p.name)).toEqual(['Old Co'])
    expect(r.parties[0]!.bills.map((b) => b.number)).toEqual(['B'])
    expect(r.parties[0]!.provision).toBe(50_00)
    expect(r.parties[0]!.pending).toBe(1000_00)
    expect(r.total).toBe(50_00)
  })

  it('floors the provision rather than rounding a paisa into existence', () => {
    const r = computeProvision([
      { ledgerId: 1, name: 'X', bills: [{ number: 'B', date: '2025-01-01', pending: 333, overdueDays: 400 }] }
    ])
    expect(r.parties[0]!.provision).toBe(166)
  })
})
