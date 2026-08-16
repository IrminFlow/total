/**
 * Payroll computation. All amounts integer paise per month.
 * Statutory defaults (simplified, editable in a later pass):
 *  - EPF: 12% employee + 12% employer on basic, wage ceiling ₹15,000/month. The employer 12% is
 *    split EPS 8.33% (pension, on the capped wage) + EPF remainder; EPFO also charges the
 *    employer admin 0.5% and EDLI 0.5% on the capped wage (account 2/21/22 heads of the ECR).
 *  - ESI: 0.75% employee / 3.25% employer on gross, only when full monthly gross ≤ ₹21,000;
 *    contributions rounded UP to the next rupee (statutory rule).
 *  - Professional tax: state-wise monthly slabs (PT_SLABS) keyed by employees.pt_state;
 *    defaults to the simplified Maharashtra slab.
 */
import { roundPaise } from './money'

export const PF_WAGE_CEILING = 15_000_00
export const ESI_GROSS_LIMIT = 21_000_00
export const PF_RATE = 12
export const EPS_RATE = 8.33
export const PF_ADMIN_RATE = 0.5
export const EDLI_RATE = 0.5
export const ESI_EMP_RATE = 0.75
export const ESI_ER_RATE = 3.25

// ---------- professional tax (state-wise slabs) ----------

/** One monthly PT slab: monthly gross ceiling (inclusive, paise; null = no ceiling) → tax (paise). */
export interface PtSlab {
  upTo: number | null
  tax: number
}

export const PT_STATES = ['MH', 'KA', 'WB', 'TN', 'GJ', 'AP', 'TS', 'MP'] as const
export type PtState = (typeof PT_STATES)[number]

/**
 * Monthly professional-tax slabs for the common states (simplified: annual/half-yearly statutory
 * figures expressed per month; MH's February ₹300 catch-up month is deliberately flattened to a
 * steady ₹200 — same as the pre-pay-heads behavior).
 */
export const PT_SLABS: Record<PtState, PtSlab[]> = {
  MH: [
    { upTo: 7_500_00, tax: 0 },
    { upTo: 10_000_00, tax: 175_00 },
    { upTo: null, tax: 200_00 }
  ],
  KA: [
    { upTo: 24_999_00, tax: 0 },
    { upTo: null, tax: 200_00 }
  ],
  WB: [
    { upTo: 10_000_00, tax: 0 },
    { upTo: 15_000_00, tax: 110_00 },
    { upTo: 25_000_00, tax: 130_00 },
    { upTo: 40_000_00, tax: 150_00 },
    { upTo: null, tax: 200_00 }
  ],
  TN: [
    { upTo: 3_500_00, tax: 0 },
    { upTo: 5_000_00, tax: 22_50 },
    { upTo: 7_500_00, tax: 52_50 },
    { upTo: 10_000_00, tax: 115_00 },
    { upTo: 12_500_00, tax: 170_83 },
    { upTo: null, tax: 208_33 }
  ],
  GJ: [
    { upTo: 12_000_00, tax: 0 },
    { upTo: null, tax: 200_00 }
  ],
  AP: [
    { upTo: 15_000_00, tax: 0 },
    { upTo: 20_000_00, tax: 150_00 },
    { upTo: null, tax: 200_00 }
  ],
  TS: [
    { upTo: 15_000_00, tax: 0 },
    { upTo: 20_000_00, tax: 150_00 },
    { upTo: null, tax: 200_00 }
  ],
  MP: [
    { upTo: 18_750_00, tax: 0 },
    { upTo: 25_000_00, tax: 125_00 },
    { upTo: 33_333_00, tax: 167_00 },
    { upTo: null, tax: 208_00 }
  ]
}

/** Monthly PT (paise) for a monthly gross, per state slab; unknown states fall back to MH. */
export function professionalTax(grossMonthly: number, state: string = 'MH'): number {
  const slabs = PT_SLABS[state as PtState] ?? PT_SLABS.MH
  for (const s of slabs) {
    if (s.upTo === null || grossMonthly <= s.upTo) return s.tax
  }
  return 0
}

// ---------- pay heads ----------

export interface PayHeadSpec {
  name: string
  kind: 'earning' | 'deduction'
  /** 'flat': `value` is monthly paise. 'percent_of_basic': `value` is percent × 100 (4000 = 40%). */
  calc: 'flat' | 'percent_of_basic'
  value: number
}

export interface PayHeadAmount {
  name: string
  kind: 'earning' | 'deduction'
  /** Prorated paise actually paid/deducted this month. */
  amount: number
}

export interface EmployeePayInput {
  basic: number
  hra: number
  special: number
  pfEnabled: boolean
  esiEnabled: boolean
  ptEnabled: boolean
  /** PT_SLABS key; defaults to 'MH' (the pre-pay-heads behavior). */
  ptState?: string
  /**
   * Optional pay-head list. When present it fully defines earnings/deductions: the head named
   * 'Basic' is the basic (falling back to `basic` when absent), 'HRA'/'Special Allowance' map
   * onto the legacy hra/special fields, every other earning lands in otherEarnings and every
   * deduction head in otherDeductions. When absent, the legacy basic/hra/special columns drive
   * the computation unchanged (byte-identical to the pre-pay-heads engine).
   */
  heads?: PayHeadSpec[]
}

export interface PayComputation {
  basic: number
  hra: number
  special: number
  /** Custom earning heads beyond Basic/HRA/Special (prorated paise). */
  otherEarnings: number
  /** Custom deduction heads (canteen, advances, ...) — subtracted from net. */
  otherDeductions: number
  gross: number
  pfEmp: number
  pfEr: number
  /** Employer 12% split: EPS 8.33% on the capped wage + the EPF remainder (epsEr + epfEr = pfEr). */
  epsEr: number
  epfEr: number
  /** EPFO employer admin charge 0.5% of the capped PF wage. */
  pfAdmin: number
  /** EDLI contribution 0.5% of the capped PF wage. */
  edli: number
  esiEmp: number
  esiEr: number
  pt: number
  net: number
  employerCost: number
  /** Per-head prorated amounts — empty for the legacy (no-heads) shape. */
  headAmounts: PayHeadAmount[]
}

/** Round paise up to the next whole rupee (ESI convention). */
function ceilToRupee(paise: number): number {
  return Math.ceil(paise / 100) * 100
}

const nameIs = (head: PayHeadSpec, n: string): boolean => head.name.trim().toLowerCase() === n

export function computeMonthlyPay(e: EmployeePayInput, payableDays: number, monthDays: number): PayComputation {
  if (monthDays <= 0 || payableDays < 0) throw new Error('Invalid attendance days')
  const ratio = Math.min(1, payableDays / monthDays)

  let basicFull: number
  let hraFull = 0
  let specialFull = 0
  let otherEarnFull = 0
  let basic: number
  let hra = 0
  let special = 0
  let otherEarnings = 0
  let otherDeductions = 0
  const headAmounts: PayHeadAmount[] = []

  if (e.heads && e.heads.length > 0) {
    const basicHead = e.heads.find((h) => h.kind === 'earning' && nameIs(h, 'basic'))
    basicFull = basicHead ? basicHead.value : e.basic
    basic = roundPaise(basicFull * ratio)
    for (const h of e.heads) {
      if (h === basicHead) {
        headAmounts.push({ name: h.name, kind: h.kind, amount: basic })
        continue
      }
      const full = h.calc === 'flat' ? h.value : roundPaise((basicFull * h.value) / 10000)
      const amount = h.calc === 'flat' ? roundPaise(h.value * ratio) : roundPaise((basic * h.value) / 10000)
      headAmounts.push({ name: h.name, kind: h.kind, amount })
      if (h.kind === 'earning') {
        if (nameIs(h, 'hra')) {
          hraFull += full
          hra += amount
        } else if (nameIs(h, 'special allowance') || nameIs(h, 'special')) {
          specialFull += full
          special += amount
        } else {
          otherEarnFull += full
          otherEarnings += amount
        }
      } else {
        otherDeductions += amount
      }
    }
  } else {
    basicFull = e.basic
    hraFull = e.hra
    specialFull = e.special
    basic = roundPaise(e.basic * ratio)
    hra = roundPaise(e.hra * ratio)
    special = roundPaise(e.special * ratio)
  }

  const gross = basic + hra + special + otherEarnings

  const pfWage = Math.min(basic, PF_WAGE_CEILING)
  const pfEmp = e.pfEnabled ? roundPaise((pfWage * PF_RATE) / 100) : 0
  const pfEr = e.pfEnabled ? roundPaise((pfWage * PF_RATE) / 100) : 0
  const epsEr = e.pfEnabled ? roundPaise((pfWage * EPS_RATE) / 100) : 0
  const epfEr = pfEr - epsEr
  const pfAdmin = e.pfEnabled ? roundPaise((pfWage * PF_ADMIN_RATE) / 100) : 0
  const edli = e.pfEnabled ? roundPaise((pfWage * EDLI_RATE) / 100) : 0

  // ESI eligibility is decided on the full contracted gross, not the prorated one.
  const fullGross = basicFull + hraFull + specialFull + otherEarnFull
  const esiEligible = e.esiEnabled && fullGross <= ESI_GROSS_LIMIT
  const esiEmp = esiEligible ? ceilToRupee((gross * ESI_EMP_RATE) / 100) : 0
  const esiEr = esiEligible ? ceilToRupee((gross * ESI_ER_RATE) / 100) : 0

  const pt = e.ptEnabled ? professionalTax(gross, e.ptState ?? 'MH') : 0
  const net = gross - pfEmp - esiEmp - pt - otherDeductions

  return {
    basic, hra, special, otherEarnings, otherDeductions, gross,
    pfEmp, pfEr, epsEr, epfEr, pfAdmin, edli, esiEmp, esiEr, pt, net,
    employerCost: gross + pfEr + esiEr + pfAdmin + edli,
    headAmounts
  }
}

/** Calendar days in 'YYYY-MM'. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

// ---------- statutory export builders (pure text; the service wires them to a run) ----------

const rupees = (paise: number): number => Math.round(paise / 100)

export interface EcrInput {
  uan: string
  name: string
  /** Paise, from the posted payroll line (prorated). */
  gross: number
  basic: number
  pfEmp: number
  pfEr: number
  epsEr: number
  payableDays: number
  monthDays: number
}

/**
 * EPFO ECR 2.0 upload text: one '#~#'-separated line per member —
 * UAN#~#NAME#~#GROSS#~#EPF WAGES#~#EPS WAGES#~#EDLI WAGES#~#EPF CONTRI#~#EPS CONTRI#~#DIFF#~#NCP DAYS#~#REFUND
 * All amounts whole rupees; wages capped at the ₹15,000 ceiling; DIFF = employer share − EPS.
 */
export function buildEcr(rows: EcrInput[]): string {
  return rows
    .map((r) => {
      const wage = rupees(Math.min(r.basic, PF_WAGE_CEILING))
      const epfContri = rupees(r.pfEmp)
      const epsContri = rupees(r.epsEr)
      const diff = rupees(r.pfEr) - epsContri
      const ncp = Math.max(0, Math.round(r.monthDays - r.payableDays))
      const name = r.name.toUpperCase().replace(/#~#/g, ' ').trim()
      return [r.uan, name, rupees(r.gross), wage, wage, wage, epfContri, epsContri, diff, ncp, 0].join('#~#')
    })
    .join('\n')
}

export interface EsiInput {
  esicNo: string
  name: string
  payableDays: number
  /** Paise. */
  gross: number
}

const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export interface PtCsvInput {
  state: string
  employees: number
  /** Paise. */
  gross: number
  /** Paise. */
  pt: number
}

/** State-wise professional-tax return CSV: one challan row per state plus a TOTAL row. Amounts whole rupees. */
export function buildPtCsv(rows: PtCsvInput[]): string {
  const header = 'State,Employees,Gross Wages,PT Payable'
  const body = rows.map((r) => [csvCell(r.state), String(r.employees), String(rupees(r.gross)), String(rupees(r.pt))].join(','))
  const total = [
    'TOTAL',
    String(rows.reduce((s, r) => s + r.employees, 0)),
    String(rupees(rows.reduce((s, r) => s + r.gross, 0))),
    String(rupees(rows.reduce((s, r) => s + r.pt, 0)))
  ].join(',')
  return [header, ...body, total].join('\n')
}

/** ESIC monthly-contribution upload CSV (the portal's MC excel template, saved as CSV). */
export function buildEsiCsv(rows: EsiInput[]): string {
  const header = 'IP Number,IP Name,No of Days,Total Monthly Wages,Reason Code for Zero Workdays,Last Working Day'
  const body = rows.map((r) =>
    [csvCell(r.esicNo), csvCell(r.name), String(Math.round(r.payableDays)), String(rupees(r.gross)), '0', ''].join(',')
  )
  return [header, ...body].join('\n')
}
