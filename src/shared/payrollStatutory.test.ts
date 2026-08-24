import { describe, expect, it } from 'vitest'
import { ratesChangedBetween, ratesForMonth, ratesOn, STATUTORY_HISTORY } from './statutory'
import { computeMonthlyPay, ecrUploadable, professionalTax, ptSlabsOn, validateEcr, type EcrInput } from './payroll'
import { gratuity, serviceLength, statutoryBonus, GRATUITY_CEILING } from './gratuity'
import { fullAndFinal } from './fnf'

describe('statutory rate history', () => {
  it('is ascending, so ratesOn can walk it once', () => {
    for (let i = 1; i < STATUTORY_HISTORY.length; i++) {
      expect(STATUTORY_HISTORY[i]!.effectiveFrom > STATUTORY_HISTORY[i - 1]!.effectiveFrom).toBe(true)
    }
  })

  it('picks the set in force, not the newest', () => {
    expect(ratesOn('2014-08-31').pfWageCeiling).toBe(6_500_00)
    expect(ratesOn('2014-09-01').pfWageCeiling).toBe(15_000_00)
    expect(ratesOn('2016-12-31').esiGrossLimit).toBe(15_000_00)
    expect(ratesOn('2017-01-01').esiGrossLimit).toBe(21_000_00)
    expect(ratesOn('2019-06-30').esiEmpRate).toBe(1.75)
    expect(ratesOn('2019-07-01').esiEmpRate).toBe(0.75)
  })

  it('serves a date before the history with the earliest set rather than refusing', () => {
    expect(ratesOn('2005-01-01').effectiveFrom).toBe(STATUTORY_HISTORY[0]!.effectiveFrom)
  })

  it('reads a month on its last day, which is when pay accrues', () => {
    // The ESI change took effect on 1 July 2019, so June is on the old rate and July the new.
    expect(ratesForMonth('2019-06').esiEmpRate).toBe(1.75)
    expect(ratesForMonth('2019-07').esiEmpRate).toBe(0.75)
    expect(ratesChangedBetween('2019-06', '2019-07')).toBe(true)
    expect(ratesChangedBetween('2019-07', '2019-08')).toBe(false)
  })
})

describe('pay computed on the rates of its own month', () => {
  const employee = { basic: 20_000_00, hra: 0, special: 0, pfEnabled: true, esiEnabled: false, ptEnabled: false }

  it('caps PF at the ceiling that applied then', () => {
    // 12% of ₹6,500 before September 2014; 12% of ₹15,000 after.
    expect(computeMonthlyPay(employee, 30, 30, { date: '2014-08-31' }).pfEmp).toBe(780_00)
    expect(computeMonthlyPay(employee, 30, 30, { date: '2014-09-01' }).pfEmp).toBe(1_800_00)
  })

  it('uses the ESI rate of the month, and the eligibility limit of the month', () => {
    const low = { ...employee, basic: 18_000_00, pfEnabled: false, esiEnabled: true }
    // ₹18,000 was above the ₹15,000 limit in 2016 and below the ₹21,000 limit in 2017.
    expect(computeMonthlyPay(low, 30, 30, { date: '2016-12-31' }).esiEmp).toBe(0)
    expect(computeMonthlyPay(low, 30, 30, { date: '2017-06-01' }).esiEmp).toBe(315_00) // 1.75%
    expect(computeMonthlyPay(low, 30, 30, { date: '2019-08-01' }).esiEmp).toBe(135_00) // 0.75%
  })

  it('defaults to today, which is what every caller wanted before the history existed', () => {
    expect(computeMonthlyPay(employee, 30, 30)).toEqual(computeMonthlyPay(employee, 30, 30, { date: '2026-06-30' }))
  })
})

describe('professional tax with effective dates', () => {
  it('uses the superseded Karnataka slabs before April 2023', () => {
    expect(professionalTax(20_000_00, 'KA', '2023-03-31')).toBe(200_00)
    expect(professionalTax(20_000_00, 'KA', '2023-04-01')).toBe(0)
    expect(professionalTax(20_000_00, 'KA')).toBe(0)
  })

  it('serves states with no history from the current slabs, whatever the date', () => {
    expect(ptSlabsOn('MH', '2015-01-01')).toEqual(ptSlabsOn('MH', '2026-01-01'))
    expect(professionalTax(30_000_00, 'MH', '2015-01-01')).toBe(200_00)
  })

  it('falls back to Maharashtra for a state it does not know', () => {
    expect(professionalTax(30_000_00, 'ZZ', '2026-01-01')).toBe(professionalTax(30_000_00, 'MH', '2026-01-01'))
  })
})

describe('statutory bonus', () => {
  it('pays 8.33% on the capped wage, not on the wage', () => {
    const r = statutoryBonus({ monthlySalary: 18_000_00, daysWorked: 300, monthsPayable: 12 })
    expect(r.eligible).toBe(true)
    expect(r.calculationBase).toBe(7_000_00)
    expect(r.amount).toBe(Math.floor((7_000_00 * 12 * 8.33) / 100))
  })

  it('calculates on a higher state minimum wage where one applies', () => {
    const r = statutoryBonus({ monthlySalary: 18_000_00, daysWorked: 300, monthsPayable: 12, minimumWage: 12_000_00 })
    expect(r.calculationBase).toBe(12_000_00)
  })

  it('refuses above the eligibility limit, and says why', () => {
    const r = statutoryBonus({ monthlySalary: 25_000_00, daysWorked: 300, monthsPayable: 12 })
    expect(r.eligible).toBe(false)
    expect(r.amount).toBe(0)
    expect(r.reason).toContain('21,000')
  })

  it('refuses below thirty days worked', () => {
    const r = statutoryBonus({ monthlySalary: 10_000_00, daysWorked: 20, monthsPayable: 1 })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('30')
  })

  it('clamps the percentage to the statutory band', () => {
    expect(statutoryBonus({ monthlySalary: 10_000_00, daysWorked: 300, monthsPayable: 12, percent: 50 }).percent).toBe(20)
    expect(statutoryBonus({ monthlySalary: 10_000_00, daysWorked: 300, monthsPayable: 12, percent: 1 }).percent).toBe(8.33)
  })
})

describe('gratuity', () => {
  it('measures service as a calendar difference', () => {
    expect(serviceLength('2018-04-01', '2025-06-15')).toEqual({ years: 7, months: 2, days: 14 })
    expect(serviceLength('2020-01-31', '2020-03-01')).toEqual({ years: 0, months: 1, days: 1 })
  })

  it('rounds a part-year up only past six months', () => {
    // 6 years 6 months exactly: not more than six months, so it stays 6.
    expect(gratuity({ lastDrawnMonthly: 26_000_00, joined: '2019-01-01', left: '2025-07-01' }).countedYears).toBe(6)
    expect(gratuity({ lastDrawnMonthly: 26_000_00, joined: '2019-01-01', left: '2025-07-02' }).countedYears).toBe(7)
    expect(gratuity({ lastDrawnMonthly: 26_000_00, joined: '2019-01-01', left: '2025-06-30' }).countedYears).toBe(6)
  })

  it('is 15/26 of the last drawn monthly wage per counted year', () => {
    const r = gratuity({ lastDrawnMonthly: 26_000_00, joined: '2018-01-01', left: '2025-01-01' })
    expect(r.countedYears).toBe(7)
    expect(r.amount).toBe(Math.floor((26_000_00 * 15 * 7) / 26))
  })

  it('refuses below five years, and says how long they served', () => {
    const r = gratuity({ lastDrawnMonthly: 26_000_00, joined: '2022-01-01', left: '2025-06-01' })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('3 years')
  })

  it('waives the five-year rule only when asked', () => {
    const r = gratuity({ lastDrawnMonthly: 26_000_00, joined: '2022-01-01', left: '2025-06-01', waiveMinimum: true })
    expect(r.eligible).toBe(true)
    expect(r.amount).toBeGreaterThan(0)
  })

  it('caps at the lifetime ceiling and says so', () => {
    const r = gratuity({ lastDrawnMonthly: 10_00_000_00, joined: '2000-01-01', left: '2025-01-01' })
    expect(r.amount).toBe(GRATUITY_CEILING)
    expect(r.cappedByCeiling).toBe(true)
  })
})

describe('full and final settlement', () => {
  const base = {
    employeeName: 'Anita Sharma',
    joined: '2018-04-01',
    lastDay: '2026-06-20',
    monthlyBasic: 26_000_00,
    monthlyGross: 50_000_00,
    finalMonthDays: 20,
    finalMonthTotalDays: 30,
    leaveBalanceDays: 12
  }

  it('itemises everything and nets in one direction', () => {
    const r = fullAndFinal(base)
    const labels = r.lines.map((l) => l.label)
    expect(labels).toContain('Salary for the final month')
    expect(labels).toContain('Leave encashment')
    expect(labels).toContain('Gratuity')
    expect(r.net).toBe(r.totalPayable - r.totalRecovery)
    expect(r.totalRecovery).toBe(0)
    // ₹50,000 × 20/30
    expect(r.lines[0]!.amount).toBe(33_333_33)
    // 12 days × (₹26,000 / 30)
    expect(r.lines[1]!.amount).toBe(Math.floor(26_000_00 / 30) * 12)
  })

  it('shows the working for every line, because the leaver will check it', () => {
    for (const l of fullAndFinal(base).lines) expect(l.working.length).toBeGreaterThan(0)
  })

  it('recovers notice shortfall and outstanding loans', () => {
    const r = fullAndFinal({ ...base, noticeShortfallDays: 15, loanOutstanding: 20_000_00, statutoryDeductions: 3_000_00 })
    const recoveries = r.lines.filter((l) => l.kind === 'recovery').map((l) => l.label)
    expect(recoveries).toEqual([
      'Statutory deductions for the final month',
      'Notice period shortfall',
      'Loans and advances outstanding'
    ])
    expect(r.totalRecovery).toBe(3_000_00 + Math.floor(50_000_00 / 30) * 15 + 20_000_00)
  })

  it('says plainly when the employee owes the company', () => {
    const r = fullAndFinal({ ...base, joined: '2025-01-01', leaveBalanceDays: 0, loanOutstanding: 5_00_000_00 })
    expect(r.net).toBeLessThan(0)
    expect(r.notes.some((n) => n.includes('owes the company'))).toBe(true)
  })

  it('explains a missing gratuity rather than leaving a silent zero', () => {
    const r = fullAndFinal({ ...base, joined: '2024-01-01' })
    expect(r.lines.some((l) => l.label === 'Gratuity')).toBe(false)
    expect(r.notes.some((n) => n.startsWith('No gratuity'))).toBe(true)
  })
})

describe('ECR validation', () => {
  const row = (over: Partial<EcrInput> = {}): EcrInput => ({
    uan: '100200300400',
    name: 'ANITA SHARMA',
    gross: 30_000_00,
    basic: 15_000_00,
    pfEmp: 1_800_00,
    pfEr: 1_800_00,
    epsEr: 1_249_00,
    payableDays: 30,
    monthDays: 30,
    ...over
  })

  it('passes a clean file', () => {
    const problems = validateEcr([row()])
    expect(problems).toEqual([])
    expect(ecrUploadable(problems)).toBe(true)
  })

  it('blocks on a missing or malformed UAN', () => {
    expect(validateEcr([row({ uan: '' })])[0]).toMatchObject({ field: 'uan', severity: 'error' })
    expect(validateEcr([row({ uan: '12345' })])[0]!.message).toContain('12 digits')
    expect(ecrUploadable(validateEcr([row({ uan: '' })]))).toBe(false)
  })

  it('catches two employees sharing one UAN', () => {
    const problems = validateEcr([row({ name: 'ANITA' }), row({ name: 'BABU' })])
    expect(problems.some((p) => p.message.includes('Shares UAN'))).toBe(true)
  })

  it('warns rather than blocks on a name the portal will mangle', () => {
    const problems = validateEcr([row({ name: 'अनिता शर्मा' })])
    expect(problems[0]).toMatchObject({ field: 'name', severity: 'warning' })
    expect(ecrUploadable(problems)).toBe(true)
  })

  it('catches the arithmetic the portal would reject', () => {
    expect(validateEcr([row({ epsEr: 2_000_00 })]).some((p) => p.message.includes('Pension share'))).toBe(true)
    expect(validateEcr([row({ payableDays: 45 })]).some((p) => p.field === 'days')).toBe(true)
    expect(validateEcr([row({ basic: 0, pfEmp: 0 })]).some((p) => p.message.includes('EPF wages are zero'))).toBe(true)
  })

  it('lists blocking problems before advisory ones', () => {
    const problems = validateEcr([row({ name: 'अनिता', uan: 'nope' })])
    expect(problems[0]!.severity).toBe('error')
    expect(problems[problems.length - 1]!.severity).toBe('warning')
  })
})
