import { describe, expect, it } from 'vitest'
import {
  computeAnnualTax,
  fyStartYearOf,
  monthlyTds,
  monthsLeftInFy,
  ratesForFy,
  surcharge,
  taxOnSlabs,
  TAX_HISTORY
} from './incomeTax'

/**
 * The arithmetic an employee will check against a calculator on a government website. Every
 * number below is worked by hand in the comment above it, so a failure says which step moved.
 */
describe('slab arithmetic', () => {
  const newFy25 = ratesForFy(2025, 'new')

  it('taxes each slab at its own rate, not the whole income at the top one', () => {
    // ₹10,00,000 under FY 2025-26 new regime:
    //   0-4L nil · 4-8L @5% = 20,000 · 8-10L @10% = 20,000  →  40,000
    expect(taxOnSlabs(10_00_000_00, newFy25.slabs)).toBe(40_000_00)
  })

  it('is nil at and below the first slab', () => {
    expect(taxOnSlabs(4_00_000_00, newFy25.slabs)).toBe(0)
    expect(taxOnSlabs(0, newFy25.slabs)).toBe(0)
    expect(taxOnSlabs(-1, newFy25.slabs)).toBe(0)
  })

  it('runs off the open-ended top slab', () => {
    // ₹30,00,000: 20,000 + 40,000 + 60,000 + 80,000 + 1,00,000 (to 24L) + 6L @30% = 4,80,000
    expect(taxOnSlabs(30_00_000_00, newFy25.slabs)).toBe(4_80_000_00)
  })
})

describe('regime selection by year', () => {
  it('picks the year asked for and says when it had to assume', () => {
    expect(ratesForFy(2024, 'new').rebateLimit).toBe(7_00_000_00)
    expect(ratesForFy(2025, 'new').rebateLimit).toBe(12_00_000_00)
    expect(ratesForFy(2025, 'new').assumedFromEarlierYear).toBe(false)
    // A year we have no entry for is served, but flagged rather than presented as fact.
    expect(ratesForFy(2030, 'new').assumedFromEarlierYear).toBe(true)
    expect(ratesForFy(2030, 'new').fyStartYear).toBe(2025)
  })

  it('keeps the two regimes genuinely different', () => {
    expect(ratesForFy(2025, 'old').standardDeduction).toBe(50_000_00)
    expect(ratesForFy(2025, 'new').standardDeduction).toBe(75_000_00)
  })

  it('every entry says where it came from', () => {
    for (const r of TAX_HISTORY) expect(r.note.length).toBeGreaterThan(0)
  })
})

describe('annual tax', () => {
  it('is nil for a salary the rebate covers', () => {
    // ₹12,75,000 gross − ₹75,000 standard = ₹12,00,000 taxable, exactly at the rebate limit.
    const t = computeAnnualTax({ grossSalary: 12_75_000_00, regime: 'new', fyStartYear: 2025 })
    expect(t.taxableIncome).toBe(12_00_000_00)
    expect(t.totalTax).toBe(0)
    expect(t.rebate).toBeGreaterThan(0)
  })

  it('applies marginal relief just past the rebate limit rather than a cliff', () => {
    // ₹1 over the limit must not cost ₹60,000 of tax.
    const at = computeAnnualTax({ grossSalary: 12_75_000_00, regime: 'new', fyStartYear: 2025 })
    const justOver = computeAnnualTax({ grossSalary: 12_75_100_00, regime: 'new', fyStartYear: 2025 })
    expect(justOver.totalTax).toBeGreaterThan(at.totalTax)
    // Relief caps the TAX at the excess income; cess is then charged on the capped figure, which
    // is why the ceiling here is the excess plus 4% rather than the excess flat. Without relief
    // the same ₹100 of income would have cost ₹60,000.
    expect(justOver.totalTax - at.totalTax).toBeLessThanOrEqual(Math.ceil(100_00 * 1.04))
    expect(justOver.totalTax).toBeLessThan(60_000_00)
  })

  it('adds 4% cess on top', () => {
    // ₹20,75,000 gross − 75,000 = ₹20,00,000 taxable.
    //   20,000 + 40,000 + 60,000 + 80,000 = 2,00,000 tax · cess 4% = 8,000
    const t = computeAnnualTax({ grossSalary: 20_75_000_00, regime: 'new', fyStartYear: 2025 })
    expect(t.taxBeforeRebate).toBe(2_00_000_00)
    expect(t.rebate).toBe(0)
    expect(t.cess).toBe(8_000_00)
    expect(t.totalTax).toBe(2_08_000_00)
  })

  it('drops Chapter VI-A and professional tax under the new regime, and says so', () => {
    const newRegime = computeAnnualTax({
      grossSalary: 15_00_000_00,
      declaredDeductions: 1_50_000_00,
      professionalTax: 2_400_00,
      regime: 'new',
      fyStartYear: 2025
    })
    expect(newRegime.chapterVIA).toBe(0)
    expect(newRegime.professionalTaxAllowed).toBe(0)

    const oldRegime = computeAnnualTax({
      grossSalary: 15_00_000_00,
      declaredDeductions: 1_50_000_00,
      professionalTax: 2_400_00,
      regime: 'old',
      fyStartYear: 2025
    })
    expect(oldRegime.chapterVIA).toBe(1_50_000_00)
    expect(oldRegime.professionalTaxAllowed).toBe(2_400_00)
    expect(oldRegime.taxableIncome).toBe(15_00_000_00 - 50_000_00 - 2_400_00 - 1_50_000_00)
  })

  it('never produces negative tax or negative taxable income', () => {
    const t = computeAnnualTax({ grossSalary: 20_000_00, regime: 'new', fyStartYear: 2025 })
    expect(t.taxableIncome).toBe(0)
    expect(t.totalTax).toBe(0)
  })
})

describe('surcharge', () => {
  const slabs = ratesForFy(2025, 'new').slabs

  it('is nothing below the first threshold', () => {
    expect(surcharge(49_00_000_00, 10_00_000_00, 25, slabs)).toBe(0)
  })

  it('applies marginal relief so a rupee over ₹50 lakh cannot cost lakhs', () => {
    const under = computeAnnualTax({ grossSalary: 50_75_000_00, regime: 'new', fyStartYear: 2025 })
    const over = computeAnnualTax({ grossSalary: 50_76_000_00, regime: 'new', fyStartYear: 2025 })
    expect(over.taxableIncome).toBeGreaterThan(50_00_000_00)
    // ₹10,000 more income must not add more than ₹10,000 of tax.
    expect(over.totalTax - under.totalTax).toBeLessThanOrEqual(10_000_00)
  })

  it('caps the new regime at 25% where the old regime would charge 37%', () => {
    const big = 6_00_00_000_00
    const baseTax = taxOnSlabs(big, slabs)
    expect(surcharge(big, baseTax, 25, slabs)).toBe(Math.floor((baseTax * 25) / 100))
    expect(surcharge(big, baseTax, 37, slabs)).toBe(Math.floor((baseTax * 37) / 100))
  })
})

describe('spreading TDS across the year', () => {
  it('counts months from April', () => {
    expect(monthsLeftInFy('2026-04')).toBe(12)
    expect(monthsLeftInFy('2026-12')).toBe(4)
    expect(monthsLeftInFy('2027-03')).toBe(1)
    expect(fyStartYearOf('2026-04')).toBe(2026)
    expect(fyStartYearOf('2027-03')).toBe(2026)
  })

  it('divides what is left over the months that are left', () => {
    expect(monthlyTds(1_20_000_00, 0, 12)).toBe(10_000_00)
    expect(monthlyTds(1_20_000_00, 60_000_00, 6)).toBe(10_000_00)
  })

  it('catches up rather than leaving a shortfall in March', () => {
    // Nothing deducted for six months: the remaining six carry the whole year.
    expect(monthlyTds(1_20_000_00, 0, 6)).toBe(20_000_00)
  })

  it('never deducts a negative amount when too much has already been taken', () => {
    expect(monthlyTds(1_00_000_00, 1_50_000_00, 3)).toBe(0)
  })

  it('takes the whole balance in the last month rather than dividing by zero', () => {
    expect(monthlyTds(1_00_000_00, 90_000_00, 0)).toBe(10_000_00)
  })
})

describe('section 87A marginal relief belongs to the new regime only', () => {
  it('cushions the new regime just past the rebate limit', () => {
    const at = computeAnnualTax({ grossSalary: 12_75_000_00, regime: 'new', fyStartYear: 2025 })
    const over = computeAnnualTax({ grossSalary: 12_75_100_00, regime: 'new', fyStartYear: 2025 })
    expect(at.totalTax).toBe(0)
    expect(over.totalTax).toBeLessThan(1_000_00)
  })

  it('does not cushion the old regime, where the rebate is genuinely all-or-nothing', () => {
    // ₹5,50,000 gross − ₹50,000 standard = ₹5,00,000 taxable: rebate wipes it out.
    const at = computeAnnualTax({ grossSalary: 5_50_000_00, regime: 'old', fyStartYear: 2025 })
    expect(at.totalTax).toBe(0)
    expect(at.rebate).toBeGreaterThan(0)

    // ₹100 more income costs the whole rebate. That is the law, not a bug.
    const over = computeAnnualTax({ grossSalary: 5_50_100_00, regime: 'old', fyStartYear: 2025 })
    expect(over.rebate).toBe(0)
    // Taxable ₹5,00,100: 5% of the ₹2,50,000 slab = 12,500, plus 20% of the ₹100 above
    // ₹5,00,000 = 20. Then 4% cess. A hundred rupees of income costs about ₹13,000 of tax,
    // which is exactly the cliff the new regime's proviso removed and the old one still has.
    expect(over.taxBeforeRebate).toBe(12_520_00)
    expect(over.totalTax).toBe(12_520_00 + Math.floor((12_520_00 * 4) / 100))
  })

  it('says which regimes cushion and which do not', () => {
    expect(ratesForFy(2025, 'new').rebateMarginalRelief).toBe(true)
    expect(ratesForFy(2025, 'old').rebateMarginalRelief).toBe(false)
  })
})
