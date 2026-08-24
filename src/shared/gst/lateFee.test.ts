import { describe, expect, it } from 'vitest'
import { lateCharge, LATE_FEE_RULES } from './lateFee'

const on = (dueDate: string, filedDate: string, taxPaise = 0, form = 'GSTR-3B') =>
  lateCharge({ form, dueDate, filedDate, taxPaise })

describe('lateCharge', () => {
  it('charges nothing when filed on the due date', () => {
    expect(on('2026-05-20', '2026-05-20', 100000)).toEqual({
      daysLate: 0,
      lateFeePaise: 0,
      interestPaise: 0,
      totalPaise: 0,
      feeCapped: false
    })
  })

  it('charges nothing when filed early', () => {
    // Negative delay must clamp to zero rather than crediting the filer a fee.
    expect(on('2026-05-20', '2026-05-01', 100000).daysLate).toBe(0)
    expect(on('2026-05-20', '2026-05-01', 100000).totalPaise).toBe(0)
  })

  it('charges ₹50 a day on a return with tax', () => {
    const c = on('2026-05-20', '2026-05-30', 10_00_000) // 10 days late, ₹10,000 tax
    expect(c.daysLate).toBe(10)
    expect(c.lateFeePaise).toBe(500 * 100) // ₹50 × 10
  })

  it('charges the lower ₹20 a day on a nil return', () => {
    const c = on('2026-05-20', '2026-05-30', 0)
    expect(c.lateFeePaise).toBe(200 * 100) // ₹20 × 10
    // No tax, so no interest however late it is.
    expect(c.interestPaise).toBe(0)
  })

  it('caps the fee, and says so', () => {
    // ₹5,000 cap on GSTR-3B: reached at 100 days on a return with tax.
    const atCap = on('2026-05-20', '2026-08-28', 10_00_000) // 100 days
    expect(atCap.daysLate).toBe(100)
    expect(atCap.lateFeePaise).toBe(5000 * 100)
    expect(atCap.feeCapped).toBe(true)

    // Another year of delay does not raise the fee one paisa.
    const wayPast = on('2026-05-20', '2027-08-28', 10_00_000)
    expect(wayPast.lateFeePaise).toBe(5000 * 100)
    expect(wayPast.feeCapped).toBe(true)
    // But interest keeps running, which is the whole point of reporting them separately.
    expect(wayPast.interestPaise).toBeGreaterThan(atCap.interestPaise)
  })

  it('charges 18% a year on tax paid late, in integer paise', () => {
    // ₹1,00,000 tax, 365 days late → exactly ₹18,000 interest.
    const year = on('2026-05-20', '2027-05-20', 1_00_00_000)
    expect(year.daysLate).toBe(365)
    expect(year.interestPaise).toBe(18_00_000)

    // One day on the same tax: 1,00,00,000 × 18 × 1 / 36,500 = 4931.5 → floored to 4931 paise.
    expect(on('2026-05-20', '2026-05-21', 1_00_00_000).interestPaise).toBe(4931)
  })

  it('never lets a float touch the interest', () => {
    // A tax figure that divides badly: the result must still be a whole number of paise.
    const c = on('2026-05-20', '2026-06-01', 3_33_333)
    expect(Number.isInteger(c.interestPaise)).toBe(true)
    expect(Number.isInteger(c.lateFeePaise)).toBe(true)
  })

  it('adds the two charges into the total', () => {
    const c = on('2026-05-20', '2026-05-30', 10_00_000)
    expect(c.totalPaise).toBe(c.lateFeePaise + c.interestPaise)
    expect(c.interestPaise).toBeGreaterThan(0)
  })

  it('charges no late fee on CMP-08, which is a payment statement, but does charge interest', () => {
    const c = on('2026-07-18', '2026-08-18', 10_00_000, 'CMP-08')
    expect(LATE_FEE_RULES['CMP-08']!.perDayPaise).toBe(0)
    expect(c.lateFeePaise).toBe(0)
    expect(c.interestPaise).toBeGreaterThan(0)
  })

  it('charges nothing at all on the optional IFF', () => {
    const c = on('2026-05-13', '2026-06-13', 10_00_000, 'IFF')
    expect(c.totalPaise).toBe(0)
  })

  it('caps GSTR-4 lower than the monthly returns', () => {
    const c = on('2027-06-30', '2028-06-30', 10_00_000, 'GSTR-4')
    expect(c.lateFeePaise).toBe(2000 * 100)
  })

  it('charges nothing for a form it has no rule for, rather than inventing one', () => {
    // A guessed fee is a number the filer might pay.
    const c = on('2026-05-20', '2026-06-20', 10_00_000, 'GSTR-9')
    expect(c.lateFeePaise).toBe(0)
    expect(c.interestPaise).toBe(0)
    expect(c.daysLate).toBe(31)
  })
})
