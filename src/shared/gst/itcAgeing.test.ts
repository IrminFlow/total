import { describe, expect, it } from 'vitest'
import {
  fyStartYearOf,
  ITC_AGEING_BUCKETS,
  itcAgeingBucket,
  itcDeadline,
  itcRisk,
  ITC_WARNING_DAYS
} from './itcAgeing'

describe('itcDeadline', () => {
  it('is 30 November of the year after the FY closes', () => {
    // FY 2026-27 runs Apr 2026 – Mar 2027, so its credit window shuts 30 Nov 2027.
    expect(itcDeadline(2026)).toBe('2027-11-30')
  })
})

describe('fyStartYearOf', () => {
  it('starts the year in April', () => {
    expect(fyStartYearOf('2026-04-01')).toBe(2026)
    expect(fyStartYearOf('2027-03-31')).toBe(2026)
    expect(fyStartYearOf('2026-03-31')).toBe(2025)
    expect(fyStartYearOf('2026-01-15')).toBe(2025)
  })
})

describe('itcRisk', () => {
  it('is ok well inside the window', () => {
    const r = itcRisk({ invoiceDate: '2026-05-10', today: '2026-06-01' })
    expect(r.fyStartYear).toBe(2026)
    expect(r.deadline).toBe('2027-11-30')
    expect(r.level).toBe('ok')
    expect(r.limb).toBe('november')
    expect(r.daysRemaining).toBeGreaterThan(ITC_WARNING_DAYS)
  })

  it('turns urgent inside the warning window, and not a day before', () => {
    expect(itcRisk({ invoiceDate: '2026-05-10', today: '2027-10-01' }).level).toBe('closing')
    // Exactly ITC_WARNING_DAYS out is still urgent; one more day out is not.
    expect(itcRisk({ invoiceDate: '2026-05-10', today: '2027-10-01' }).daysRemaining).toBe(60)
    expect(itcRisk({ invoiceDate: '2026-05-10', today: '2027-09-30' }).level).toBe('ok')
  })

  it('is still claimable on the deadline itself', () => {
    const r = itcRisk({ invoiceDate: '2026-05-10', today: '2027-11-30' })
    expect(r.daysRemaining).toBe(0)
    expect(r.level).toBe('closing')
  })

  it('has lapsed the day after', () => {
    const r = itcRisk({ invoiceDate: '2026-05-10', today: '2027-12-01' })
    expect(r.daysRemaining).toBe(-1)
    expect(r.level).toBe('lapsed')
  })

  it('closes the window early when the annual return was filed before November', () => {
    // "Whichever is earlier" — a GSTR-9 filed in August shuts the window in August.
    const r = itcRisk({ invoiceDate: '2026-05-10', today: '2027-09-01', annualReturnFiledAt: '2027-08-15' })
    expect(r.deadline).toBe('2027-08-15')
    expect(r.limb).toBe('annual-return')
    expect(r.level).toBe('lapsed')
  })

  it('ignores an annual return filed after November, which cannot extend the window', () => {
    const r = itcRisk({ invoiceDate: '2026-05-10', today: '2027-12-05', annualReturnFiledAt: '2027-12-20' })
    expect(r.deadline).toBe('2027-11-30')
    expect(r.limb).toBe('november')
    expect(r.level).toBe('lapsed')
  })

  it('treats a missing annual-return date as the November limb, not as no deadline', () => {
    const r = itcRisk({ invoiceDate: '2026-05-10', today: '2027-12-01', annualReturnFiledAt: null })
    expect(r.deadline).toBe('2027-11-30')
    expect(r.level).toBe('lapsed')
  })

  it('gives a March invoice the same deadline as the April one before it', () => {
    // Both belong to FY 2026-27, so both shut on the same day — an easy off-by-one-year error.
    expect(itcRisk({ invoiceDate: '2027-03-31', today: '2027-04-01' }).deadline).toBe('2027-11-30')
    expect(itcRisk({ invoiceDate: '2026-04-01', today: '2027-04-01' }).deadline).toBe('2027-11-30')
    // And an invoice one day later belongs to the next FY, with a year more.
    expect(itcRisk({ invoiceDate: '2027-04-01', today: '2027-04-01' }).deadline).toBe('2028-11-30')
  })
})

describe('itcAgeingBucket', () => {
  it('tiles the whole range with no gap or overlap', () => {
    for (let i = 1; i < ITC_AGEING_BUCKETS.length; i++) {
      expect(ITC_AGEING_BUCKETS[i]!.fromDays).toBe(ITC_AGEING_BUCKETS[i - 1]!.toDays)
    }
    expect(ITC_AGEING_BUCKETS[0]!.fromDays).toBe(0)
    expect(ITC_AGEING_BUCKETS[ITC_AGEING_BUCKETS.length - 1]!.toDays).toBeNull()
  })

  it('buckets by age, inclusive at the bottom and exclusive at the top', () => {
    expect(itcAgeingBucket('2026-06-01', '2026-06-01')).toBe('0-30')
    expect(itcAgeingBucket('2026-06-01', '2026-07-01')).toBe('0-30') // 30 days
    expect(itcAgeingBucket('2026-06-01', '2026-07-02')).toBe('31-90') // 31 days
    expect(itcAgeingBucket('2026-06-01', '2026-08-30')).toBe('31-90') // 90 days
    expect(itcAgeingBucket('2026-06-01', '2026-08-31')).toBe('91-180') // 91
    expect(itcAgeingBucket('2026-06-01', '2027-06-01')).toBe('181-365') // exactly 365 days
    expect(itcAgeingBucket('2026-06-01', '2027-06-02')).toBe('365+') // 366 — over a year
    expect(itcAgeingBucket('2020-01-01', '2026-06-01')).toBe('365+')
  })

  it('ages a future-dated invoice at zero rather than dropping it', () => {
    expect(itcAgeingBucket('2027-01-01', '2026-06-01')).toBe('0-30')
  })
})
