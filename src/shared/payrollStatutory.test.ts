// Worked examples for the payroll statutory engine (WP 3.7). Each block names the provision the
// figures come from (keys as in SOURCES_WP37 / migration 029; all accessed 2026-10-07).
import { describe, expect, it } from 'vitest'
import {
  ageBand, bonus, bpRupeeHalfUp, bpRupeeUp, codeWages, computeEsi, computePf, computePt, DEFAULT_ESI_RATES, DEFAULT_PF_RATES,
  esiContributionPeriod, esiDueDate, gratuity, hraExemption, hraMetroCities, incomeTaxYear, monthlyTds, monthsRemainingInFy,
  pfAdminTopUp, pfDueDate, roundTenRupees, salaryWorkings, slabTax, taxOnTotalIncome, tdsDueDate, weightedCeiling,
  type PtSlab
} from './payrollStatutory'

const R = (rupees: number): number => Math.round(rupees * 100)
const L = (lakh: number): number => R(lakh * 100_000)
const PROFILE = { enabled: true, vpfRateBp: 0, onFullWage: false, epsEligible: true }

describe('rounding', () => {
  it('EPF: nearest rupee, 50 paise up (EPF Scheme 2026 para 18(5); EPS 2026 para 4(3))', () => {
    expect(bpRupeeHalfUp(R(15_000), 833)).toBe(R(1_250)) // 1,249.50 → 1,250
    expect(bpRupeeHalfUp(R(12_345.67), 1200)).toBe(R(1_481)) // 1,481.48 → 1,481
    expect(bpRupeeHalfUp(0, 1200)).toBe(0)
  })
  it('ESI: next higher rupee (SS (Central) Rules 2026 r.19(1))', () => {
    expect(bpRupeeUp(R(17_400), 75)).toBe(R(131)) // 130.50 → 131
    expect(bpRupeeUp(R(18_000), 75)).toBe(R(135)) // exact
  })
  it('income-tax amounts: nearest ₹10 (2025 Act s.516)', () => {
    expect(roundTenRupees(R(10_404))).toBe(R(10_400))
    expect(roundTenRupees(R(10_405))).toBe(R(10_410))
  })
})

describe('EPF / EPS / EDLI / admin (EPF Scheme 2026 para 18, EPS 2026 para 4, EPFO rate sheet)', () => {
  it('caps at the ₹15,000 ceiling: 12% + 12% (EPS 8.33% = ₹1,250, EPF ₹550), EDLI and admin 0.5%', () => {
    const p = computePf(R(20_000), PROFILE)
    expect(p).toMatchObject({ epfWage: R(15_000), epsWage: R(15_000), edliWage: R(15_000), ee: R(1_800), er: R(1_800), eps: R(1_250), epfEr: R(550), edli: R(75), admin: R(75), vpf: 0 })
  })
  it('below the ceiling: ₹10,000 → EPS ₹833 / EPF ₹367', () => {
    expect(computePf(R(10_000), PROFILE)).toMatchObject({ ee: R(1_200), eps: R(833), epfEr: R(367), edli: R(50), admin: R(50) })
  })
  it('joint option above the ceiling (para 9(4)): EPF on actual wages, EPS / EDLI still capped, admin on EPF wages', () => {
    expect(computePf(R(30_000), { ...PROFILE, onFullWage: true })).toMatchObject({ epfWage: R(30_000), ee: R(3_600), er: R(3_600), eps: R(1_250), epfEr: R(2_350), edli: R(75), admin: R(150) })
  })
  it('not an EPS member (EPS 2026 para 7): the whole employer 12% goes to EPF', () => {
    expect(computePf(R(20_000), { ...PROFILE, epsEligible: false })).toMatchObject({ epsWage: 0, eps: 0, epfEr: R(1_800) })
  })
  it('VPF (para 19): employee only, on EPF wages', () => {
    expect(computePf(R(20_000), { ...PROFILE, vpfRateBp: 1000 })).toMatchObject({ vpf: R(1_500), er: R(1_800) })
  })
  it('the ₹25,000 ceiling from 17-9-2026 (S.O. 5109(E)): EPS max ₹2,083', () => {
    const p = computePf(R(30_000), PROFILE, { ...DEFAULT_PF_RATES, ceilingPaise: R(25_000) })
    expect(p).toMatchObject({ ee: R(3_000), eps: R(2_083), epfEr: R(917), edli: R(125) })
  })
  it('September 2026 split month: day-weighted ceiling (16 days × ₹15,000 + 14 × ₹25,000) ÷ 30', () => {
    expect(weightedCeiling([{ days: 16, ceilingPaise: R(15_000) }, { days: 14, ceilingPaise: R(25_000) }])).toBe(R(19_667))
  })
  it('admin minimum ₹500 per establishment per month (EPFO rate sheet)', () => {
    expect(pfAdminTopUp(R(150), 2)).toBe(R(350))
    expect(pfAdminTopUp(R(600), 8)).toBe(0)
    expect(pfAdminTopUp(0, 0)).toBe(0)
  })
  it('disabled → nothing', () => {
    expect(computePf(R(20_000), { ...PROFILE, enabled: false }).ee).toBe(0)
  })
  it('due within 15 days of the close of the month (EPF Scheme 2026 para 20(1))', () => {
    expect(pfDueDate('2025-12')).toBe('2026-01-15')
  })
})

describe('Code on Social Security s.2(88) wages — the 50% rule', () => {
  it('excluded items within half of remuneration: wages = the included components', () => {
    expect(codeWages([{ amountPaise: R(10_000), inWages: true }, { amountPaise: R(8_000), inWages: false }, { amountPaise: R(2_000), inWages: true }])).toBe(R(12_000))
  })
  it('excluded items above half are added back: basic 8,000 + HRA 12,000 → wages 10,000', () => {
    expect(codeWages([{ amountPaise: R(8_000), inWages: true }, { amountPaise: R(12_000), inWages: false }])).toBe(R(10_000))
  })
})

describe('ESI (SS (Central) Rules 2026 r.19; ESIC contribution page)', () => {
  const base = { enabled: true, contractedWagesPaise: R(18_000), wagesPaise: R(18_000), payableDays: 30, disabled: false, coveredEarlierInPeriod: false }
  it('0.75% / 3.25% under the ₹21,000 ceiling', () => {
    expect(computeEsi(base)).toEqual({ covered: true, ee: R(135), er: R(585), wages: R(18_000) })
  })
  it('rounds up on prorated wages: ₹17,400 → ₹131 / ₹566', () => {
    expect(computeEsi({ ...base, wagesPaise: R(17_400), payableDays: 29 })).toMatchObject({ ee: R(131), er: R(566) })
  })
  it('above the ceiling: not covered — unless covered earlier in the contribution period', () => {
    expect(computeEsi({ ...base, contractedWagesPaise: R(22_000), wagesPaise: R(22_000) }).covered).toBe(false)
    expect(computeEsi({ ...base, contractedWagesPaise: R(22_000), wagesPaise: R(22_000), coveredEarlierInPeriod: true }))
      .toMatchObject({ covered: true, ee: R(165), er: R(715) })
  })
  it('₹25,000 ceiling for a person with disability', () => {
    expect(computeEsi({ ...base, contractedWagesPaise: R(24_000), wagesPaise: R(24_000), disabled: true })).toMatchObject({ covered: true, ee: R(180), er: R(780) })
  })
  it('average daily wage ≤ ₹176: no employee share, employer still pays', () => {
    expect(computeEsi({ ...base, contractedWagesPaise: R(5_000), wagesPaise: R(5_000), payableDays: 30 })).toMatchObject({ ee: 0, er: R(163) })
  })
  it('contribution periods Apr–Sep / Oct–Mar; due by the 15th', () => {
    expect(esiContributionPeriod('2026-05')).toMatchObject({ from: '2026-04', to: '2026-09' })
    expect(esiContributionPeriod('2026-11')).toMatchObject({ from: '2026-10', to: '2027-03' })
    expect(esiContributionPeriod('2027-02')).toMatchObject({ from: '2026-10', to: '2027-03' })
    expect(esiDueDate('2026-03')).toBe('2026-04-15')
    expect(DEFAULT_ESI_RATES.thresholdPaise).toBe(R(21_000))
  })
})

const slab = (toRupees: number | null, amount: number, over: Partial<PtSlab> = {}): PtSlab => ({
  fromPaise: 0, toPaise: toRupees == null ? null : R(toRupees), amountPaise: R(amount), basis: 'month', gender: 'any',
  specialMonth: null, specialAmountPaise: null, ...over
})

describe('professional tax', () => {
  // Maharashtra Schedule I entry 1 from 1-4-2023 [PT-MH] (the seeded rows of migration 029).
  const MH: PtSlab[] = [
    slab(7_500, 0), slab(10_000, 175), slab(null, 200, { specialMonth: 2, specialAmountPaise: R(300) }),
    slab(25_000, 0, { gender: 'female' }), slab(null, 200, { gender: 'female', specialMonth: 2, specialAmountPaise: R(300) })
  ]
  it('Maharashtra: ₹175 / ₹200, ₹300 in February; women nil up to ₹25,000', () => {
    expect(computePt(MH, R(7_500), '2026-07', 'male')).toBe(0)
    expect(computePt(MH, R(8_000), '2026-07', 'male')).toBe(R(175))
    expect(computePt(MH, R(12_000), '2026-07', null)).toBe(R(200))
    expect(computePt(MH, R(12_000), '2027-02', 'male')).toBe(R(300))
    expect(computePt(MH, R(20_000), '2026-07', 'female')).toBe(0)
    expect(computePt(MH, R(30_000), '2027-02', 'female')).toBe(R(300))
    // A man's year: 11 × 200 + 300 = 2,500 (Article 276(2) cap).
    const months = ['04', '05', '06', '07', '08', '09', '10', '11', '12', '01', '02', '03'].map((m) => (Number(m) >= 4 ? `2026-${m}` : `2027-${m}`))
    expect(months.reduce((s, m) => s + computePt(MH, R(40_000), m, 'male'), 0)).toBe(R(2_500))
  })
  it('Karnataka from 1-4-2025: nil below ₹25,000; ₹200, February ₹300 [PT-KA]', () => {
    const KA = [slab(24_999.99, 0), slab(null, 200, { specialMonth: 2, specialAmountPaise: R(300) })]
    expect(computePt(KA, R(24_999), '2026-07', null)).toBe(0)
    expect(computePt(KA, R(25_000), '2026-07', null)).toBe(R(200))
    expect(computePt(KA, R(25_000), '2027-02', null)).toBe(R(300))
  })
  it('Gujarat: exactly ₹12,000 is nil, more than ₹12,000 is ₹200 [PT-GJ]', () => {
    const GJ = [slab(12_000, 0), slab(null, 200)]
    expect(computePt(GJ, R(12_000), '2026-07', null)).toBe(0)
    expect(computePt(GJ, R(12_000.01), '2026-07', null)).toBe(R(200))
  })
  it('Madhya Pradesh annual slab spread monthly: ₹166 × 11 + ₹174; ₹208 × 11 + ₹212 [PT-MP]', () => {
    const MP = [slab(2_25_000, 0, { basis: 'year' }), slab(3_00_000, 1_500, { basis: 'year' }), slab(4_00_000, 2_000, { basis: 'year' }), slab(null, 2_500, { basis: 'year' })]
    expect(computePt(MP, R(20_000), '2026-04', null)).toBe(R(125))
    expect(computePt(MP, R(30_000), '2026-04', null)).toBe(R(166))
    expect(computePt(MP, R(30_000), '2027-03', null)).toBe(R(174))
    expect(computePt(MP, R(40_000), '2026-04', null)).toBe(R(208))
    expect(computePt(MP, R(40_000), '2027-03', null)).toBe(R(212))
  })
  it('Tamil Nadu half-yearly: ₹425 a half-year → ₹70 × 5 + ₹75 in September [PT-TN]', () => {
    const TN = [slab(21_000, 0, { basis: 'half_year' }), slab(30_000, 180, { basis: 'half_year' }), slab(45_000, 425, { basis: 'half_year' })]
    expect(computePt(TN, R(6_000), '2026-04', null)).toBe(R(70))
    expect(computePt(TN, R(6_000), '2026-09', null)).toBe(R(75))
  })
  it('no slabs (a state without PT) → nil', () => {
    expect(computePt([], R(50_000), '2026-07', null)).toBe(0)
  })
})

describe('income tax — slabs, rebate, surcharge, cess', () => {
  const fy25 = incomeTaxYear(2025)
  const fy26 = incomeTaxYear(2026)
  it('picks the year: FY 2025-26 = 1961 Act s.192; FY 2026-27 = 2025 Act s.392; later years carry forward', () => {
    expect(fy25).toMatchObject({ act: '1961', tdsSection: '192', cessBp: 400 })
    expect(fy26).toMatchObject({ act: '2025', tdsSection: '392' })
    expect(incomeTaxYear(2030).act).toBe('2025')
  })
  it('new regime (s.115BAC(1A) / 2025 s.202(1)): ₹12 lakh fully rebated (s.87A / s.156(2)(a))', () => {
    expect(taxOnTotalIncome(L(12), 'new', 'below60', fy25)).toMatchObject({ taxBeforeRebate: R(60_000), rebate: R(60_000), total: 0 })
  })
  it('marginal relief just above ₹12 lakh: tax limited to the excess (s.156(2)(b))', () => {
    // ₹12,10,000: slab tax 61,500; excess 10,000 → rebate 51,500; + 4% cess = 10,400.
    expect(taxOnTotalIncome(R(12_10_000), 'new', 'below60', fy26)).toMatchObject({ taxBeforeRebate: R(61_500), rebate: R(51_500), cess: R(400), total: R(10_400) })
    expect(taxOnTotalIncome(L(13), 'new', 'below60', fy25)).toMatchObject({ rebate: 0, total: R(78_000) })
  })
  it('new regime ₹24 lakh = ₹3,00,000 + cess; ₹30 lakh = ₹4,80,000 + cess', () => {
    expect(taxOnTotalIncome(L(24), 'new', 'below60', fy25).total).toBe(R(3_12_000))
    expect(taxOnTotalIncome(L(30), 'new', 'below60', fy25).total).toBe(R(4_99_200))
  })
  it('surcharge 10% above ₹50 lakh with marginal relief at the threshold', () => {
    // ₹55 lakh: tax 12,30,000; surcharge 1,23,000 (below the relief cap); cess 4%.
    expect(taxOnTotalIncome(L(55), 'new', 'below60', fy25)).toMatchObject({ surcharge: R(1_23_000), total: R(14_07_120) })
    // ₹50,10,000: tax 10,83,000; capped at tax on ₹50 lakh (10,80,000) + 10,000 → surcharge 7,000.
    expect(taxOnTotalIncome(R(50_10_000), 'new', 'below60', fy25)).toMatchObject({ taxAfterRebate: R(10_83_000), surcharge: R(7_000), total: R(11_33_600) })
  })
  it('old regime: ₹5 lakh rebated (₹12,500); ₹10 lakh = ₹1,12,500 + cess; senior / super-senior slabs (First Schedule Part III Para A)', () => {
    expect(taxOnTotalIncome(L(5), 'old', 'below60', fy25)).toMatchObject({ taxBeforeRebate: R(12_500), rebate: R(12_500), total: 0 })
    expect(taxOnTotalIncome(L(10), 'old', 'below60', fy25).total).toBe(R(1_17_000))
    expect(taxOnTotalIncome(L(10), 'old', 'senior', fy25).total).toBe(R(1_14_400))
    expect(taxOnTotalIncome(L(10), 'old', 'superSenior', fy25).total).toBe(R(1_04_000))
    expect(slabTax(L(15), fy26.regimes.old.slabs.below60)).toBe(R(2_62_500))
  })
})

describe('salary workings and the monthly spread', () => {
  it('new regime ₹15 lakh: standard deduction ₹75,000 → ₹14.25 lakh → ₹97,500; ₹8,125 a month from April', () => {
    const w = salaryWorkings({
      fyStartYear: 2025, regime: 'new', age: 'below60', metro: true, grossPaise: L(15), basicPaise: L(7.5), hraPaise: L(3),
      ptPaise: R(2_500), employeePfPaise: R(21_600), declarations: { '80C': L(1.5), RENT: L(3) }
    })
    expect(w).toMatchObject({ hraExemption: 0, standardDeduction: R(75_000), professionalTax: 0, deductionsTotal: 0, totalIncome: R(14_25_000) })
    expect(w.taxOnIncome.total).toBe(R(97_500))
    expect(monthlyTds(w.taxPayableByEmployer, 0, '2025-04')).toBe(R(8_125))
  })
  it('old regime: HRA exemption, standard deduction ₹50,000, PT, 80C (incl. employee PF) capped, 80D', () => {
    const w = salaryWorkings({
      fyStartYear: 2025, regime: 'old', age: 'below60', metro: true, grossPaise: L(12), basicPaise: L(6), hraPaise: L(2.4),
      ptPaise: R(2_500), employeePfPaise: R(72_000), declarations: { '80C': L(1), '80D': R(25_000), RENT: L(2.4) }
    })
    // HRA: least of 2,40,000; 2,40,000 − 60,000; 50% × 6,00,000 → 1,80,000.
    expect(w.hraExemption).toBe(R(1_80_000))
    expect(w.incomeFromSalary).toBe(R(9_67_500))
    expect(w.deductions.map((d) => d.amount)).toEqual([L(1.5), R(25_000)])
    expect(w.totalIncome).toBe(R(7_92_500))
    expect(w.taxOnIncome.total).toBe(R(73_840))
  })
  it('previous employer (Form 12B / Form 122): salary added, its TDS deducted from what this employer owes', () => {
    const w = salaryWorkings({
      fyStartYear: 2026, regime: 'new', age: 'below60', metro: false, grossPaise: L(10), basicPaise: L(5), hraPaise: 0,
      ptPaise: 0, employeePfPaise: 0, declarations: { PREV_SALARY: L(5), PREV_TDS: R(20_000) }
    })
    expect(w.gross).toBe(L(15))
    expect(w.taxPayableByEmployer).toBe(R(97_500 - 20_000))
  })
  it('catch-up: what is still due is spread over the months left (s.392(5)(c))', () => {
    expect(monthsRemainingInFy('2025-04')).toBe(12)
    expect(monthsRemainingInFy('2026-01')).toBe(3)
    expect(monthsRemainingInFy('2026-03')).toBe(1)
    expect(monthlyTds(R(97_500), R(48_750), '2025-10')).toBe(R(8_125))
    expect(monthlyTds(R(97_500), 0, '2025-10')).toBe(R(16_250))
    expect(monthlyTds(R(97_500), R(1_00_000), '2026-02')).toBe(0)
  })
  it('HRA cities: four to FY 2025-26, eight from FY 2026-27 (Rules 2026 r.279)', () => {
    expect(hraMetroCities(2025)).toHaveLength(4)
    expect(hraMetroCities(2026)).toContain('Bengaluru')
    expect(hraExemption(L(2.4), 0, L(6), true)).toBe(0)
  })
  it('age band on 31 March; deposit by the 7th, March by 30 April (Rules 2026 r.218)', () => {
    expect(ageBand('1965-03-31', 2025)).toBe('senior')
    expect(ageBand('1966-04-01', 2025)).toBe('below60')
    expect(ageBand('1945-01-01', 2025)).toBe('superSenior')
    expect(ageBand(null, 2025)).toBe('below60')
    expect(tdsDueDate('2025-12')).toBe('2026-01-07')
    expect(tdsDueDate('2026-03')).toBe('2026-04-30')
  })
})

describe('gratuity (CoSS s.53) and bonus (Code on Wages s.26) — compute only', () => {
  it('15/26 × wages × years, part year over six months counts; five-year minimum', () => {
    expect(gratuity({ monthlyWagesPaise: R(26_000), years: 10, months: 7 })).toEqual({ eligible: true, serviceYears: 11, amountPaise: R(1_65_000) })
    expect(gratuity({ monthlyWagesPaise: R(26_000), years: 4, months: 11 }).eligible).toBe(false)
    expect(gratuity({ monthlyWagesPaise: R(26_000), years: 2, months: 0, fixedTerm: true }).amountPaise).toBe(R(30_000))
    expect(gratuity({ monthlyWagesPaise: R(5_00_000), years: 30, months: 0 }).amountPaise).toBe(L(20))
  })
  it('8.33% on salary capped at ₹7,000 (or the minimum wage); ineligible above ₹21,000 or under 30 days', () => {
    const year = Array(12).fill(R(10_000))
    expect(bonus({ monthlySalariesPaise: year, workingDays: 250 })).toEqual({ eligible: true, basePaise: R(84_000), amountPaise: R(6_997) })
    expect(bonus({ monthlySalariesPaise: year, workingDays: 250, minimumWagePaise: R(9_000) }).amountPaise).toBe(R(8_996))
    expect(bonus({ monthlySalariesPaise: year, workingDays: 250, rateBp: 2000 }).amountPaise).toBe(R(16_800))
    expect(bonus({ monthlySalariesPaise: year, workingDays: 20 }).eligible).toBe(false)
    expect(bonus({ monthlySalariesPaise: Array(12).fill(R(25_000)), workingDays: 250 }).eligible).toBe(false)
    expect(bonus({ monthlySalariesPaise: [R(1_000)], workingDays: 30 }).amountPaise).toBe(R(100)) // ₹100 minimum
  })
})
