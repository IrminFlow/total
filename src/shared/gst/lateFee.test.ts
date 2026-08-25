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

describe('the rates that were in the table but not in the tests', () => {
  // Mutation testing found that only GSTR-3B's row was exercised: the ₹50/day and the ₹2,000 cap
  // on the other two forms could have been anything (roadmap #327). A rate table nothing reads is
  // a rate table nobody notices going wrong.
  it('charges GSTR-1 at fifty rupees a day', () => {
    const c = lateCharge({ form: 'GSTR-1', dueDate: '2026-05-11', filedDate: '2026-05-21', taxPaise: 1_00_000 })
    expect(c.daysLate).toBe(10)
    expect(c.lateFeePaise).toBe(500_00) // ₹50 × 10
    expect(c.interestPaise).toBe(0) // GSTR-1 is a statement of supplies; interest arises on 3B
  })

  it('caps GSTR-4 at two thousand rupees, not five', () => {
    // 100 days at ₹50 would be ₹5,000 — the general cap. GSTR-4's own cap is lower, and only a
    // delay long enough to reach it can tell the two numbers apart.
    const c = lateCharge({ form: 'GSTR-4', dueDate: '2026-04-30', filedDate: '2026-08-08', taxPaise: 1_00_000 })
    expect(c.daysLate).toBe(100)
    expect(c.feeCapped).toBe(true)
    expect(c.lateFeePaise).toBe(2000_00)
  })

  it('charges a nil return the nil rate', () => {
    // `taxPaise > 0` is what picks between the two columns of the table. With `>= 0` a nil return
    // would be charged the full ₹50 instead of ₹20 — on the filer least able to argue about it.
    const nil = lateCharge({ form: 'GSTR-3B', dueDate: '2026-05-20', filedDate: '2026-05-30', taxPaise: 0 })
    expect(nil.lateFeePaise).toBe(200_00) // ₹20 × 10
    expect(nil.interestPaise).toBe(0) // no tax, no interest
    const withTax = lateCharge({ form: 'GSTR-3B', dueDate: '2026-05-20', filedDate: '2026-05-30', taxPaise: 1_00_000 })
    expect(withTax.lateFeePaise).toBe(500_00)
  })
})

