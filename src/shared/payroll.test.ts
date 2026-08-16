import { describe, it, expect } from 'vitest'
import {
  computeMonthlyPay, professionalTax, buildEcr, buildEsiCsv,
  PT_SLABS, PT_STATES,
  type EmployeePayInput, type PayComputation, type PayHeadSpec
} from './payroll'

const legacyEmp: EmployeePayInput = {
  basic: 20_000_00, hra: 8_000_00, special: 4_000_00,
  pfEnabled: true, esiEnabled: true, ptEnabled: true
}

/** The same employee expressed as seeded pay heads (what migration 015 produces). */
const seededHeads: PayHeadSpec[] = [
  { name: 'Basic', kind: 'earning', calc: 'flat', value: 20_000_00 },
  { name: 'HRA', kind: 'earning', calc: 'flat', value: 8_000_00 },
  { name: 'Special Allowance', kind: 'earning', calc: 'flat', value: 4_000_00 }
]

const stripHeads = (p: PayComputation): Omit<PayComputation, 'headAmounts'> => {
  const { headAmounts: _heads, ...rest } = p
  return rest
}

describe('pay heads backward compatibility', () => {
  it('seeded Basic/HRA/Special heads produce byte-identical results to the legacy shape', () => {
    const withHeads: EmployeePayInput = { ...legacyEmp, heads: seededHeads }
    for (const [payable, monthDays] of [[31, 31], [15.5, 31], [29, 30], [0, 30], [26, 31]] as const) {
      const a = computeMonthlyPay(legacyEmp, payable, monthDays)
      const b = computeMonthlyPay(withHeads, payable, monthDays)
      expect(stripHeads(b)).toEqual(stripHeads(a))
    }
  })

  it('legacy shape still produces the historical numbers', () => {
    const p = computeMonthlyPay(legacyEmp, 31, 31)
    expect(p.gross).toBe(32_000_00)
    expect(p.pfEmp).toBe(1_800_00)
    expect(p.pfEr).toBe(1_800_00)
    expect(p.esiEmp).toBe(0)
    expect(p.pt).toBe(200_00)
    expect(p.net).toBe(32_000_00 - 1_800_00 - 200_00)
    expect(p.otherEarnings).toBe(0)
    expect(p.otherDeductions).toBe(0)
    expect(p.headAmounts).toEqual([])
  })

  it('computes custom flat + percent-of-basic earnings and flat deductions', () => {
    const emp: EmployeePayInput = {
      basic: 10_000_00, hra: 0, special: 0,
      pfEnabled: true, esiEnabled: true, ptEnabled: true,
      heads: [
        { name: 'Basic', kind: 'earning', calc: 'flat', value: 10_000_00 },
        { name: 'Conveyance', kind: 'earning', calc: 'flat', value: 1_600_00 },
        { name: 'Performance Bonus', kind: 'earning', calc: 'percent_of_basic', value: 1000 }, // 10%
        { name: 'Canteen', kind: 'deduction', calc: 'flat', value: 500_00 }
      ]
    }
    const p = computeMonthlyPay(emp, 30, 30)
    expect(p.basic).toBe(10_000_00)
    expect(p.otherEarnings).toBe(1_600_00 + 1_000_00)
    expect(p.otherDeductions).toBe(500_00)
    expect(p.gross).toBe(12_600_00)
    // PF on basic 10,000 (below ceiling)
    expect(p.pfEmp).toBe(1_200_00)
    expect(p.pfEr).toBe(1_200_00)
    expect(p.epsEr).toBe(833_00) // 8.33% of 10,000
    expect(p.epfEr).toBe(1_200_00 - 833_00)
    expect(p.pfAdmin).toBe(50_00)
    expect(p.edli).toBe(50_00)
    // ESI: full gross 12,600 ≤ 21,000 → 0.75% = 94.50 → round UP to 95
    expect(p.esiEmp).toBe(95_00)
    expect(p.esiEr).toBe(410_00) // 3.25% = 409.50 → 410
    expect(p.pt).toBe(200_00)
    expect(p.net).toBe(12_600_00 - 1_200_00 - 95_00 - 200_00 - 500_00)
    expect(p.headAmounts).toEqual([
      { name: 'Basic', kind: 'earning', amount: 10_000_00 },
      { name: 'Conveyance', kind: 'earning', amount: 1_600_00 },
      { name: 'Performance Bonus', kind: 'earning', amount: 1_000_00 },
      { name: 'Canteen', kind: 'deduction', amount: 500_00 }
    ])
  })

  it('prorates flat heads by attendance and percent heads off the prorated basic', () => {
    const emp: EmployeePayInput = {
      basic: 10_000_00, hra: 0, special: 0,
      pfEnabled: false, esiEnabled: false, ptEnabled: false,
      heads: [
        { name: 'Basic', kind: 'earning', calc: 'flat', value: 10_000_00 },
        { name: 'Bonus', kind: 'earning', calc: 'percent_of_basic', value: 2000 } // 20%
      ]
    }
    const p = computeMonthlyPay(emp, 15, 30)
    expect(p.basic).toBe(5_000_00)
    expect(p.otherEarnings).toBe(1_000_00) // 20% of prorated basic
    expect(p.gross).toBe(6_000_00)
  })
})

describe('EPS split + employer PF charges', () => {
  it('splits the 12% employer PF into EPS 8.33% (capped wage) and the EPF remainder, plus admin/EDLI at 0.5% each', () => {
    const p = computeMonthlyPay(legacyEmp, 31, 31)
    // PF wage capped at 15,000: EPS = 1,249.50, EPF er = 1,800 − 1,249.50
    expect(p.epsEr).toBe(1_249_50)
    expect(p.epfEr).toBe(550_50)
    expect(p.epsEr + p.epfEr).toBe(p.pfEr)
    expect(p.pfAdmin).toBe(75_00)
    expect(p.edli).toBe(75_00)
    expect(p.employerCost).toBe(32_000_00 + 1_800_00 + 75_00 + 75_00)
  })

  it('is zero across the board when PF is disabled', () => {
    const p = computeMonthlyPay({ ...legacyEmp, pfEnabled: false }, 31, 31)
    expect(p.epsEr).toBe(0)
    expect(p.epfEr).toBe(0)
    expect(p.pfAdmin).toBe(0)
    expect(p.edli).toBe(0)
  })
})

describe('state-wise professional tax', () => {
  it('has slabs for every supported state', () => {
    for (const s of PT_STATES) expect(PT_SLABS[s].length).toBeGreaterThan(0)
  })

  it('MH matches the historical simplified slab', () => {
    expect(professionalTax(7_500_00, 'MH')).toBe(0)
    expect(professionalTax(8_000_00, 'MH')).toBe(175_00)
    expect(professionalTax(10_000_00, 'MH')).toBe(175_00)
    expect(professionalTax(32_000_00, 'MH')).toBe(200_00)
    // default state is MH (pre-pay-heads behavior)
    expect(professionalTax(32_000_00)).toBe(200_00)
  })

  it('KA: nil below ₹25,000, ₹200 from ₹25,000', () => {
    expect(professionalTax(20_000_00, 'KA')).toBe(0)
    expect(professionalTax(24_999_00, 'KA')).toBe(0)
    expect(professionalTax(25_000_00, 'KA')).toBe(200_00)
  })

  it('WB slabs', () => {
    expect(professionalTax(9_000_00, 'WB')).toBe(0)
    expect(professionalTax(12_000_00, 'WB')).toBe(110_00)
    expect(professionalTax(20_000_00, 'WB')).toBe(130_00)
    expect(professionalTax(30_000_00, 'WB')).toBe(150_00)
    expect(professionalTax(45_000_00, 'WB')).toBe(200_00)
  })

  it('TN slabs (half-yearly statutory figures expressed per month)', () => {
    expect(professionalTax(3_000_00, 'TN')).toBe(0)
    expect(professionalTax(4_500_00, 'TN')).toBe(22_50)
    expect(professionalTax(6_000_00, 'TN')).toBe(52_50)
    expect(professionalTax(9_000_00, 'TN')).toBe(115_00)
    expect(professionalTax(11_000_00, 'TN')).toBe(170_83)
    expect(professionalTax(20_000_00, 'TN')).toBe(208_33)
  })

  it('GJ, AP/TS and MP slabs', () => {
    expect(professionalTax(12_000_00, 'GJ')).toBe(0)
    expect(professionalTax(12_500_00, 'GJ')).toBe(200_00)
    expect(professionalTax(18_000_00, 'AP')).toBe(150_00)
    expect(professionalTax(18_000_00, 'TS')).toBe(150_00)
    expect(professionalTax(25_000_00, 'AP')).toBe(200_00)
    expect(professionalTax(20_000_00, 'MP')).toBe(125_00)
    expect(professionalTax(40_000_00, 'MP')).toBe(208_00)
  })

  it('unknown states fall back to MH', () => {
    expect(professionalTax(32_000_00, 'XX')).toBe(200_00)
  })

  it('computeMonthlyPay honors ptState', () => {
    // Gross 20,000 in KA is below the PT threshold; in MH it pays ₹200.
    const ka = computeMonthlyPay({ ...legacyEmp, basic: 15_000_00, hra: 5_000_00, special: 0, ptState: 'KA' }, 30, 30)
    expect(ka.pt).toBe(0)
    const mh = computeMonthlyPay({ ...legacyEmp, basic: 15_000_00, hra: 5_000_00, special: 0, ptState: 'MH' }, 30, 30)
    expect(mh.pt).toBe(200_00)
  })
})

describe('PF ECR builder', () => {
  it('emits the EPFO ECR 2.0 #~# line format with rupee-rounded amounts and capped wages', () => {
    const text = buildEcr([{
      uan: '100123456789', name: 'Asha Kumar',
      gross: 32_000_00, basic: 20_000_00,
      pfEmp: 1_800_00, pfEr: 1_800_00, epsEr: 1_249_50,
      payableDays: 31, monthDays: 31
    }])
    expect(text).toBe('100123456789#~#ASHA KUMAR#~#32000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0')
  })

  it('computes NCP days from attendance and joins multiple members with newlines', () => {
    const text = buildEcr([
      {
        uan: '100000000001', name: 'A',
        gross: 10_000_00, basic: 10_000_00,
        pfEmp: 1_200_00, pfEr: 1_200_00, epsEr: 833_00,
        payableDays: 26, monthDays: 31
      },
      {
        uan: '100000000002', name: 'B',
        gross: 12_000_00, basic: 12_000_00,
        pfEmp: 1_440_00, pfEr: 1_440_00, epsEr: 999_60,
        payableDays: 31, monthDays: 31
      }
    ])
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('100000000001#~#A#~#10000#~#10000#~#10000#~#10000#~#1200#~#833#~#367#~#5#~#0')
    expect(lines[1]).toBe('100000000002#~#B#~#12000#~#12000#~#12000#~#12000#~#1440#~#1000#~#440#~#0#~#0')
  })
})

describe('ESI upload CSV builder', () => {
  it('emits the MC-template header and one row per insured person', () => {
    const csv = buildEsiCsv([
      { esicNo: '1234567890', name: 'Asha Kumar', payableDays: 26, gross: 18_000_00 },
      { esicNo: '9876543210', name: 'Ravi, Jr', payableDays: 31, gross: 15_500_00 }
    ])
    const lines = csv.split('\n')
    expect(lines[0]).toBe('IP Number,IP Name,No of Days,Total Monthly Wages,Reason Code for Zero Workdays,Last Working Day')
    expect(lines[1]).toBe('1234567890,Asha Kumar,26,18000,0,')
    expect(lines[2]).toBe('9876543210,"Ravi, Jr",31,15500,0,')
  })
})
