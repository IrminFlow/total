/**
 * Payroll computation. All amounts integer paise per month. The statutory maths (EPF/EPS/EDLI/
 * admin, ESI, PT slabs, salary TDS) lives in payrollStatutory.ts (WP 3.7) with its citations; the
 * rates themselves are effective-dated data (statutory_rates, migration 029). The legacy notes:
 *  - EPF: 12% employee + 12% employer on basic, wage ceiling ₹15,000/month. The employer 12% is
 *    split EPS 8.33% (pension, on the capped wage) + EPF remainder; EPFO also charges the
 *    employer admin 0.5% and EDLI 0.5% on the capped wage (account 2/21/22 heads of the ECR).
 *  - ESI: 0.75% employee / 3.25% employer on gross, only when full monthly gross ≤ ₹21,000;
 *    contributions rounded UP to the next rupee (statutory rule).
 *  - Professional tax: state-wise monthly slabs (PT_SLABS) keyed by employees.pt_state;
 *    defaults to the simplified Maharashtra slab. PT_SLABS is now only the fallback for callers
 *    without rate rows; pay runs use the cited, effective-dated slabs of migration 029.
 *  - Since WP 3.7 every EPF figure is rounded to the rupee (EPF Scheme para 29), not the paisa.
 */
import { roundPaise } from './money'
import {
  codeWages, computeEsi, computePf, computePt, DEFAULT_ESI_RATES, type WageComponent, DEFAULT_PF_RATES, type EsiRates, type Gender, type PfRates, type PtSlab as StatutoryPtSlab
} from './payrollStatutory'
import { neutralizeCsvFormula } from './csv'

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
  /** WP 3.7: the head is "wages" under CoSS s.2(88) (default: every earning except HRA). */
  inWages?: boolean
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
  /** WP 3.7 statutory profile (all optional — defaults reproduce the pre-3.7 behaviour). */
  vpfRateBp?: number
  pfOnFullWage?: boolean
  epsEligible?: boolean
  disabled?: boolean
  gender?: Gender | null
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
  /** Voluntary PF (employee only), deducted with pfEmp. */
  vpf: number
  pfEr: number
  /** EPF / EPS / EDLI wages as remitted (ECR columns). */
  epfWage: number
  epsWage: number
  edliWage: number
  /** Employer 12% split: EPS 8.33% on the capped wage + the EPF remainder (epsEr + epfEr = pfEr). */
  epsEr: number
  epfEr: number
  /** EPFO employer admin charge 0.5% of the capped PF wage. */
  pfAdmin: number
  /** EDLI contribution 0.5% of the capped PF wage. */
  edli: number
  esiEmp: number
  esiEr: number
  /** ESI-covered this month (drives the contribution-period stickiness). */
  esiCovered: boolean
  /** Wages ESI was computed on (gross before the Code; s.2(88) wages from 21-11-2025). */
  esiWage: number
  pt: number
  /** Salary TDS (s.192 / 2025 s.392), set by withTds. */
  tds: number
  net: number
  employerCost: number
  /** Per-head prorated amounts — empty for the legacy (no-heads) shape. */
  headAmounts: PayHeadAmount[]
}

const nameIs = (head: PayHeadSpec, n: string): boolean => head.name.trim().toLowerCase() === n

/**
 * Statutory context for one wage month (WP 3.7). Every field is optional: absent rates fall back to
 * the cited defaults in payrollStatutory.ts, absent PT slabs to the legacy PT_SLABS table — so the
 * pre-WP 3.7 call shape `computeMonthlyPay(e, days, monthDays)` keeps working.
 */
export interface PayContext {
  /** 'YYYY-MM' — needed for month-specific PT (Maharashtra's February) and annual PT spreads. */
  month?: string
  pf?: PfRates
  esi?: EsiRates
  /** The state's slabs in force (null/undefined = legacy PT_SLABS by ptState). */
  ptSlabs?: StatutoryPtSlab[] | null
  /** Covered by ESI in an earlier month of this contribution period (s.2(9) proviso). */
  esiCoveredEarlier?: boolean
  /** CoSS s.2(88) wage definition in force: EPF and ESI on "wages" (50% rule) instead of basic /
   *  gross. Value = the excluded-items cap in bp (5000). Absent = the pre-Code bases. */
  ssWagesCapBp?: number | null
}

export function computeMonthlyPay(e: EmployeePayInput, payableDays: number, monthDays: number, ctx: PayContext = {}): PayComputation {
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
  const wageParts: WageComponent[] = []
  const wagePartsFull: WageComponent[] = []
  const inWagesOf = (h: PayHeadSpec): boolean => h.inWages ?? !nameIs(h, 'hra')

  if (e.heads && e.heads.length > 0) {
    const basicHead = e.heads.find((h) => h.kind === 'earning' && nameIs(h, 'basic'))
    basicFull = basicHead ? basicHead.value : e.basic
    basic = roundPaise(basicFull * ratio)
    for (const h of e.heads) {
      if (h === basicHead) {
        headAmounts.push({ name: h.name, kind: h.kind, amount: basic })
        wageParts.push({ amountPaise: basic, inWages: true })
        wagePartsFull.push({ amountPaise: basicFull, inWages: true })
        continue
      }
      const full = h.calc === 'flat' ? h.value : roundPaise((basicFull * h.value) / 10000)
      const amount = h.calc === 'flat' ? roundPaise(h.value * ratio) : roundPaise((basic * h.value) / 10000)
      headAmounts.push({ name: h.name, kind: h.kind, amount })
      if (h.kind === 'earning') {
        wageParts.push({ amountPaise: amount, inWages: inWagesOf(h) })
        wagePartsFull.push({ amountPaise: full, inWages: inWagesOf(h) })
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
    wageParts.push({ amountPaise: basic, inWages: true }, { amountPaise: hra, inWages: false }, { amountPaise: special, inWages: true })
    wagePartsFull.push({ amountPaise: basicFull, inWages: true }, { amountPaise: hraFull, inWages: false }, { amountPaise: specialFull, inWages: true })
  }

  const gross = basic + hra + special + otherEarnings

  // Contribution bases. Before the Code: EPF on basic (+ DA — no separate DA head), ESI on gross.
  // From 21-11-2025 (ctx.ssWagesCapBp set): both on s.2(88) wages with the 50% rule [COSS].
  const ss = ctx.ssWagesCapBp != null
  const fullGrossForBase = basicFull + hraFull + specialFull + otherEarnFull
  const pfBase = ss ? codeWages(wageParts, ctx.ssWagesCapBp!) : basic
  const esiBase = ss ? codeWages(wageParts, ctx.ssWagesCapBp!) : gross
  const esiContracted = ss ? codeWages(wagePartsFull, ctx.ssWagesCapBp!) : fullGrossForBase

  // EPF rupee-rounded per EPF Scheme para 29 / 2026 para 18(5).
  const pf = computePf(
    pfBase,
    { enabled: e.pfEnabled, vpfRateBp: e.vpfRateBp ?? 0, onFullWage: e.pfOnFullWage ?? false, epsEligible: e.epsEligible ?? true },
    ctx.pf ?? DEFAULT_PF_RATES
  )

  // ESI coverage is decided on the full contracted wages, contributions on the wages paid.
  const esi = computeEsi(
    {
      enabled: e.esiEnabled, contractedWagesPaise: esiContracted, wagesPaise: esiBase, payableDays,
      disabled: e.disabled ?? false, coveredEarlierInPeriod: ctx.esiCoveredEarlier ?? false
    },
    ctx.esi ?? DEFAULT_ESI_RATES
  )

  let pt = 0
  if (e.ptEnabled) {
    pt = ctx.ptSlabs != null && ctx.month
      ? computePt(ctx.ptSlabs, gross, ctx.month, e.gender ?? null)
      : professionalTax(gross, e.ptState ?? 'MH')
  }
  const net = gross - pf.ee - pf.vpf - esi.ee - pt - otherDeductions

  return {
    basic, hra, special, otherEarnings, otherDeductions, gross,
    pfEmp: pf.ee, vpf: pf.vpf, pfEr: pf.er, epsEr: pf.eps, epfEr: pf.epfEr, pfAdmin: pf.admin, edli: pf.edli,
    epfWage: pf.epfWage, epsWage: pf.epsWage, edliWage: pf.edliWage,
    esiEmp: esi.ee, esiEr: esi.er, esiCovered: esi.covered, esiWage: esi.wages, pt, tds: 0, net,
    employerCost: gross + pf.er + esi.er + pf.admin + pf.edli,
    headAmounts
  }
}

/** Apply this month's salary TDS (computed by the service from the year's projection). */
export function withTds(pay: PayComputation, tdsPaise: number): PayComputation {
  const tds = Math.max(0, Math.min(tdsPaise, pay.net + pay.tds))
  return { ...pay, tds, net: pay.net + pay.tds - tds }
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
  /** WP 3.7: wages as remitted and VPF; absent on pre-029 lines (derived from basic, capped). */
  epfWage?: number
  epsWage?: number
  edliWage?: number
  vpf?: number
}

/**
 * EPFO ECR 2.0 upload text: one '#~#'-separated line per member —
 * UAN#~#MEMBER NAME#~#GROSS WAGES#~#EPF WAGES#~#EPS WAGES#~#EDLI WAGES#~#EPF CONTRI REMITTED#~#
 * EPS CONTRI REMITTED#~#EPF EPS DIFF REMITTED#~#NCP DAYS#~#REFUND OF ADVANCES
 * (EPFO "ECR file format" for the unified portal [ECR], cited in payrollStatutory.ts SOURCES_WP37).
 * Whole rupees; EPF contribution = employee share incl. VPF; DIFF = employer share − EPS.
 */
export function buildEcr(rows: EcrInput[]): string {
  return rows
    .map((r) => {
      const capped = Math.min(r.basic, PF_WAGE_CEILING)
      const epfWage = rupees(r.epfWage ?? capped)
      const epsWage = rupees(r.epsWage ?? capped)
      const edliWage = rupees(r.edliWage ?? capped)
      const epfContri = rupees(r.pfEmp + (r.vpf ?? 0))
      const epsContri = rupees(r.epsEr)
      const diff = rupees(r.pfEr) - epsContri
      const ncp = Math.max(0, Math.round(r.monthDays - r.payableDays))
      const name = r.name.toUpperCase().replace(/#~#/g, ' ').trim()
      return [r.uan, name, rupees(r.gross), epfWage, epsWage, edliWage, epfContri, epsContri, diff, ncp, 0].join('#~#')
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

/** Same RFC 4180 quoting as @shared/csv's writer, with the same formula-injection guard —
 *  employee names reach the ESIC/PT portals' spreadsheets via these CSVs. */
const csvCell = (s: string): string => {
  const safe = neutralizeCsvFormula(s)
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

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

/** One state's PT return working: employee-wise salary and tax for the month, then the count and
 *  tax per slab amount (the shape of the state monthly returns, e.g. Maharashtra Form III). */
export function buildPtStateCsv(state: string, month: string, rows: { employeeName: string; gross: number; pt: number }[]): string {
  const out = [`Professional tax return working,${csvCell(state)},${month}`, 'Employee,Gross salary,PT deducted']
  for (const r of rows) out.push([csvCell(r.employeeName), String(rupees(r.gross)), String(rupees(r.pt))].join(','))
  out.push(['TOTAL', String(rupees(rows.reduce((s, r) => s + r.gross, 0))), String(rupees(rows.reduce((s, r) => s + r.pt, 0)))].join(','))
  out.push('', 'Rate per month,Employees,Tax')
  const bySlab = new Map<number, number>()
  for (const r of rows) bySlab.set(r.pt, (bySlab.get(r.pt) ?? 0) + 1)
  for (const [pt, n] of [...bySlab].sort((a, b) => a[0] - b[0])) out.push([String(rupees(pt)), String(n), String(rupees(pt * n))].join(','))
  return out.join('\n')
}

/** ESIC monthly-contribution upload CSV (the portal's MC excel template, saved as CSV). */
export function buildEsiCsv(rows: EsiInput[]): string {
  const header = 'IP Number,IP Name,No of Days,Total Monthly Wages,Reason Code for Zero Workdays,Last Working Day'
  const body = rows.map((r) =>
    [csvCell(r.esicNo), csvCell(r.name), String(Math.round(r.payableDays)), String(rupees(r.gross)), '0', ''].join(',')
  )
  return [header, ...body].join('\n')
}
