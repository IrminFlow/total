import { describe, expect, it } from 'vitest'
import {
  addMonthsClamped, bankRateOn, disallowance43Bh, formMsme1Period, isMsmeCovered, isValidUdyam, msmeAgeBucket, normalizeUdyam,
  previousFormMsme1Period, s15Deadline, s16Interest, type BankRateRow
} from './msme'
import { disallowanceSection, MSME_SOURCES } from './msmeSources'

const RATES: BankRateRow[] = [
  { fromDate: '2025-12-05', rateBp: 550, source: 'RBI MPC 5 Dec 2025' },
  { fromDate: '2026-10-07', rateBp: 575, source: 'RBI press release 2026-2027/1264' }
]

describe('MSMED Act s.15 — the payment deadline', () => {
  it('no written agreement: pay within 15 days of acceptance; interest from the appointed day (day 16)', () => {
    expect(s15Deadline('2026-04-01', null)).toEqual({ payBy: '2026-04-16', interestFrom: '2026-04-17', days: 15, basis: 'no_agreement' })
  })
  it('a written agreement within 45 days is the deadline', () => {
    expect(s15Deadline('2026-04-01', 30)).toEqual({ payBy: '2026-05-01', interestFrom: '2026-05-02', days: 30, basis: 'agreed' })
    expect(s15Deadline('2026-04-01', 45).payBy).toBe('2026-05-16')
  })
  it('an agreement longer than 45 days is capped at 45 (s.15 proviso)', () => {
    expect(s15Deadline('2026-04-01', 90)).toEqual({ payBy: '2026-05-16', interestFrom: '2026-05-17', days: 45, basis: 'agreed_capped' })
  })
  it('an agreed 0 days (cash terms) is the acceptance day itself — not the 15-day default', () => {
    expect(s15Deadline('2026-04-01', 0)).toMatchObject({ payBy: '2026-04-01', basis: 'agreed' })
  })
  it('crosses month and year ends', () => {
    expect(s15Deadline('2026-12-25', null).payBy).toBe('2027-01-09')
    expect(s15Deadline('2028-02-20', 10).payBy).toBe('2028-03-01') // leap year
  })
})

describe('MSMED Act s.2(n) — who is covered', () => {
  it('only registered micro and small enterprises', () => {
    expect(isMsmeCovered({ registered: true, category: 'micro' })).toBe(true)
    expect(isMsmeCovered({ registered: true, category: 'small' })).toBe(true)
    expect(isMsmeCovered({ registered: true, category: 'medium' })).toBe(false)
    expect(isMsmeCovered({ registered: false, category: 'micro' })).toBe(false)
    expect(isMsmeCovered({ registered: true, category: null })).toBe(false)
  })
})

describe('Udyam registration number', () => {
  it('accepts UDYAM-XX-00-0000000, case- and space-insensitively', () => {
    expect(isValidUdyam('UDYAM-MH-33-0012345')).toBe(true)
    expect(isValidUdyam(' udyam-mh-33-0012345 ')).toBe(true)
    expect(normalizeUdyam(' udyam-mh-33-0012345 ')).toBe('UDYAM-MH-33-0012345')
  })
  it('rejects other shapes', () => {
    for (const bad of ['UDYAM-MH-3-0012345', 'UDYAM-M1-33-0012345', 'UDYAM-MH-33-001234', 'UAM-MH-33-0012345', 'MH33A0012345']) {
      expect(isValidUdyam(bad), bad).toBe(false)
    }
  })
})

describe('MSMED Act s.16 — compound interest, monthly rests, 3 × bank rate (indicative)', () => {
  it('picks the bank rate in force on a date', () => {
    expect(bankRateOn(RATES, '2026-10-06')?.rateBp).toBe(550)
    expect(bankRateOn(RATES, '2026-10-07')?.rateBp).toBe(575)
    expect(bankRateOn(RATES, '2025-01-01')).toBeNull()
  })
  it('one full month at 3 × 5.75 % = 17.25 % a year → balance × 17.25 % / 12', () => {
    // ₹1,00,000 from 16 Oct 2026 (after the 7 Oct rise) for one month.
    const r = s16Interest(10_000_000, '2026-10-16', '2026-11-15', RATES)
    expect(r).toEqual({ interestPaise: 143_750, days: 31, months: 1, rateBp: 1725 })
  })
  it('a part month is simple interest on the balance at /365', () => {
    const r = s16Interest(10_000_000, '2026-10-16', '2026-10-25', RATES)
    expect(r).toMatchObject({ days: 10, months: 0 })
    expect(r.interestPaise).toBe(47_260) // 1,00,000 × 17.25 % × 10 / 365 = 472.60
  })
  it('compounds: the second month is on principal + the first month’s interest', () => {
    const r = s16Interest(10_000_000, '2026-10-16', '2026-12-15', RATES)
    expect(r.months).toBe(2)
    expect(r.interestPaise).toBe(143_750 + 145_816) // 10,143,750 × 1725 / 120000 = 145,816.4
  })
  it('each month uses the bank rate in force on its first day', () => {
    // Month 1 starts 20 Sep 2026 (5.50 % → 16.5 %), month 2 starts 20 Oct (5.75 % → 17.25 %).
    const r = s16Interest(10_000_000, '2026-09-20', '2026-11-19', RATES)
    expect(r.rateBp).toBe(1650)
    expect(r.interestPaise).toBe(137_500 + 145_727)
  })
  it('nothing before the interest start, and nothing without a rate', () => {
    expect(s16Interest(10_000_000, '2026-10-16', '2026-10-15', RATES).interestPaise).toBe(0)
    expect(s16Interest(10_000_000, '2020-01-01', '2020-02-01', RATES)).toMatchObject({ interestPaise: 0, rateBp: null })
  })
  it('month steps clamp to the month end', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonthsClamped('2026-11-30', 3)).toBe('2027-02-28')
  })
})

describe('Income-tax s.43B(h) / 2025 Act s.37(2)(g) — the year-end figure', () => {
  const FY_END = '2026-03-31'
  const TODAY = '2026-10-07'
  it('period ended on or before the year end: all of the year-end balance is disallowed', () => {
    expect(disallowance43Bh({ pendingAtFyEnd: 50_000, payBy: '2026-03-10', pendingAtPayBy: null }, FY_END, TODAY)).toEqual({ status: 'disallowed', disallowed: 50_000, atRisk: 0 })
  })
  it('period ran out after the year end: only what was still unpaid then is disallowed', () => {
    expect(disallowance43Bh({ pendingAtFyEnd: 50_000, payBy: '2026-04-20', pendingAtPayBy: 20_000 }, FY_END, TODAY)).toEqual({ status: 'disallowed', disallowed: 20_000, atRisk: 0 })
    expect(disallowance43Bh({ pendingAtFyEnd: 50_000, payBy: '2026-04-20', pendingAtPayBy: 0 }, FY_END, TODAY)).toEqual({ status: 'allowed', disallowed: 0, atRisk: 0 })
  })
  it('a later bill on the same balance never inflates the figure past the year-end amount', () => {
    expect(disallowance43Bh({ pendingAtFyEnd: 50_000, payBy: '2026-04-20', pendingAtPayBy: 80_000 }, FY_END, TODAY).disallowed).toBe(50_000)
  })
  it('period still running: at risk, not yet disallowed', () => {
    expect(disallowance43Bh({ pendingAtFyEnd: 50_000, payBy: '2026-10-20', pendingAtPayBy: null }, FY_END, TODAY)).toEqual({ status: 'at_risk', disallowed: 0, atRisk: 50_000 })
  })
  it('paid by the year end: nothing', () => {
    expect(disallowance43Bh({ pendingAtFyEnd: 0, payBy: '2026-03-10', pendingAtPayBy: null }, FY_END, TODAY).status).toBe('allowed')
  })
  it('names the provision by year: 1961 Act to FY 2025-26, 2025 Act from 2026-27', () => {
    expect(disallowanceSection(2025)).toBe('Income-tax Act 1961 s.43B(h)')
    expect(disallowanceSection(2026)).toBe('Income-tax Act 2025 s.37(2)(g)')
  })
})

describe('MSME Form 1 half-years', () => {
  it('April–September is due 31 October; October–March 30 April', () => {
    expect(formMsme1Period('2026-05-10')).toEqual({ label: 'Apr–Sep 2026', from: '2026-04-01', to: '2026-09-30', dueDate: '2026-10-31', half: 'H1' })
    expect(formMsme1Period('2026-11-03')).toEqual({ label: 'Oct 2026–Mar 2027', from: '2026-10-01', to: '2027-03-31', dueDate: '2027-04-30', half: 'H2' })
    expect(formMsme1Period('2027-02-01').from).toBe('2026-10-01')
  })
  it('the previous half-year is the one whose return falls due next', () => {
    expect(previousFormMsme1Period('2026-10-07').label).toBe('Apr–Sep 2026')
    expect(previousFormMsme1Period('2026-05-01').label).toBe('Oct 2025–Mar 2026')
  })
})

describe('ageing against the s.15 deadline', () => {
  it('buckets days late', () => {
    expect(msmeAgeBucket('2026-10-07', '2026-10-07')).toEqual({ bucket: 'within', daysLate: 0 })
    expect(msmeAgeBucket('2026-10-06', '2026-10-07')).toEqual({ bucket: 'late_1_30', daysLate: 1 })
    expect(msmeAgeBucket('2026-08-01', '2026-10-07').bucket).toBe('late_61_plus')
  })
})

describe('sources', () => {
  it('every rule carries a citation, a URL and a date; unverified ones say so', () => {
    for (const s of MSME_SOURCES) {
      expect(s.citation.length).toBeGreaterThan(10)
      expect(s.url).toMatch(/^https:\/\//)
      expect(s.dated).toMatch(/^\d{4}-\d{2}-\d{2}/)
    }
    expect(MSME_SOURCES.some((s) => /UNVERIFIED/.test(s.note ?? ''))).toBe(true)
  })
})
