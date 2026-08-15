/**
 * Payroll computation. All amounts integer paise per month.
 * Statutory defaults (simplified, editable in a later pass):
 *  - EPF: 12% employee + 12% employer on basic, wage ceiling ₹15,000/month.
 *  - ESI: 0.75% employee / 3.25% employer on gross, only when full monthly gross ≤ ₹21,000;
 *    contributions rounded UP to the next rupee (statutory rule).
 *  - Professional tax: simplified Maharashtra slab — ₹200/mo above ₹10,000 gross,
 *    ₹175 for ₹7,501–10,000, else nil.
 */
import { roundPaise } from './money'

export const PF_WAGE_CEILING = 15_000_00
export const ESI_GROSS_LIMIT = 21_000_00
export const PF_RATE = 12
export const ESI_EMP_RATE = 0.75
export const ESI_ER_RATE = 3.25

export interface EmployeePayInput {
  basic: number
  hra: number
  special: number
  pfEnabled: boolean
  esiEnabled: boolean
  ptEnabled: boolean
}

export interface PayComputation {
  basic: number
  hra: number
  special: number
  gross: number
  pfEmp: number
  pfEr: number
  esiEmp: number
  esiEr: number
  pt: number
  net: number
  employerCost: number
}

/** Round paise up to the next whole rupee (ESI convention). */
function ceilToRupee(paise: number): number {
  return Math.ceil(paise / 100) * 100
}

function professionalTax(grossProrated: number): number {
  if (grossProrated > 10_000_00) return 200_00
  if (grossProrated > 7_500_00) return 175_00
  return 0
}

export function computeMonthlyPay(e: EmployeePayInput, payableDays: number, monthDays: number): PayComputation {
  if (monthDays <= 0 || payableDays < 0) throw new Error('Invalid attendance days')
  const ratio = Math.min(1, payableDays / monthDays)
  const basic = roundPaise(e.basic * ratio)
  const hra = roundPaise(e.hra * ratio)
  const special = roundPaise(e.special * ratio)
  const gross = basic + hra + special

  const pfWage = Math.min(basic, PF_WAGE_CEILING)
  const pfEmp = e.pfEnabled ? roundPaise((pfWage * PF_RATE) / 100) : 0
  const pfEr = e.pfEnabled ? roundPaise((pfWage * PF_RATE) / 100) : 0

  // ESI eligibility is decided on the full contracted gross, not the prorated one.
  const fullGross = e.basic + e.hra + e.special
  const esiEligible = e.esiEnabled && fullGross <= ESI_GROSS_LIMIT
  const esiEmp = esiEligible ? ceilToRupee((gross * ESI_EMP_RATE) / 100) : 0
  const esiEr = esiEligible ? ceilToRupee((gross * ESI_ER_RATE) / 100) : 0

  const pt = e.ptEnabled ? professionalTax(gross) : 0
  const net = gross - pfEmp - esiEmp - pt

  return {
    basic, hra, special, gross, pfEmp, pfEr, esiEmp, esiEr, pt, net,
    employerCost: gross + pfEr + esiEr
  }
}

/** Calendar days in 'YYYY-MM'. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}
