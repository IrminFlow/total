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
import { neutralizeCsvFormula } from './csv'
import { ratesOn, STATUTORY_HISTORY, type StatutoryRates } from './statutory'

export type { StatutoryRates }

/**
 * The rates in force today.
 *
 * Kept as named constants because most of the app only ever wants "now", and because every one of
 * these was a bare number in a formula before there was a history at all. The single source is
 * statutory.ts — change a rate there, on a date, and these follow.
 */
export const CURRENT_RATES: StatutoryRates = STATUTORY_HISTORY[STATUTORY_HISTORY.length - 1] as StatutoryRates

export const PF_WAGE_CEILING = CURRENT_RATES.pfWageCeiling
export const ESI_GROSS_LIMIT = CURRENT_RATES.esiGrossLimit
export const PF_RATE = CURRENT_RATES.pfRate
export const EPS_RATE = CURRENT_RATES.epsRate
export const PF_ADMIN_RATE = CURRENT_RATES.pfAdminRate
export const EDLI_RATE = CURRENT_RATES.edliRate
export const ESI_EMP_RATE = CURRENT_RATES.esiEmpRate
export const ESI_ER_RATE = CURRENT_RATES.esiErRate

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

/**
 * Slab sets that a state has replaced, with the date the replacement took effect.
 *
 * Only states that have actually changed appear here; everyone else is served by PT_SLABS, which
 * is the current set. Keeping the *superseded* sets here rather than duplicating the current ones
 * means PT_SLABS stays the single answer to "what do we charge now", and cannot drift from it.
 */
export const PT_SLAB_HISTORY: Partial<Record<PtState, { until: string; slabs: PtSlab[]; note: string }[]>> = {
  KA: [
    {
      // Karnataka raised its exemption from ₹15,000 to ₹25,000 with effect from 1 April 2023.
      until: '2023-03-31',
      slabs: [
        { upTo: 14_999_00, tax: 0 },
        { upTo: null, tax: 200_00 }
      ],
      note: 'Exemption limit was ₹15,000 before 1 April 2023.'
    }
  ]
}

/** The slabs a state charged on `date` — the superseded set when one covers the date, else current. */
export function ptSlabsOn(state: string, date: string): PtSlab[] {
  const key = (PT_SLABS[state as PtState] ? state : 'MH') as PtState
  for (const past of PT_SLAB_HISTORY[key] ?? []) {
    if (date <= past.until) return past.slabs
  }
  return PT_SLABS[key]
}

/**
 * Monthly PT (paise) for a monthly gross, per state slab; unknown states fall back to MH.
 *
 * `date` picks the slab set that was in force; omitting it means today's, which is what every
 * caller wanted before the history existed.
 */
export function professionalTax(grossMonthly: number, state: string = 'MH', date?: string): number {
  const slabs = date ? ptSlabsOn(state, date) : (PT_SLABS[state as PtState] ?? PT_SLABS.MH)
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
  /**
   * A salary advance instalment recovered this month, paise.
   *
   * Deliberately not a pay head: a flat head is prorated by attendance, and an instalment is not.
   * Somebody who worked ten days still owes the same instalment — reducing it because they were
   * absent would quietly extend the advance and is nobody's intention.
   */
  advanceRecovery?: number
}

export interface PayComputation {
  basic: number
  hra: number
  special: number
  /** Custom earning heads beyond Basic/HRA/Special (prorated paise). */
  otherEarnings: number
  /** Custom deduction heads (canteen, ...) — subtracted from net. */
  otherDeductions: number
  /** Salary advance recovered this month; never prorated. */
  advanceRecovery: number
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

/**
 * One employee's pay for one month.
 *
 * `opts.rates` is the statutory set to compute against; omitted, it is today's. A run recomputed
 * later must be given the set that was in force for ITS month (see ratesForMonth), or the second
 * answer will not match the first — which is the whole reason the history exists.
 */
export function computeMonthlyPay(
  e: EmployeePayInput,
  payableDays: number,
  monthDays: number,
  opts: { rates?: StatutoryRates; date?: string } = {}
): PayComputation {
  if (monthDays <= 0 || payableDays < 0) throw new Error('Invalid attendance days')
  const rates = opts.rates ?? (opts.date ? ratesOn(opts.date) : CURRENT_RATES)
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

  const pfWage = Math.min(basic, rates.pfWageCeiling)
  const pfEmp = e.pfEnabled ? roundPaise((pfWage * rates.pfRate) / 100) : 0
  const pfEr = e.pfEnabled ? roundPaise((pfWage * rates.pfRate) / 100) : 0
  const epsEr = e.pfEnabled ? roundPaise((pfWage * rates.epsRate) / 100) : 0
  const epfEr = pfEr - epsEr
  const pfAdmin = e.pfEnabled ? roundPaise((pfWage * rates.pfAdminRate) / 100) : 0
  const edli = e.pfEnabled ? roundPaise((pfWage * rates.edliRate) / 100) : 0

  // ESI eligibility is decided on the full contracted gross, not the prorated one.
  const fullGross = basicFull + hraFull + specialFull + otherEarnFull
  const esiEligible = e.esiEnabled && fullGross <= rates.esiGrossLimit
  const esiEmp = esiEligible ? ceilToRupee((gross * rates.esiEmpRate) / 100) : 0
  const esiEr = esiEligible ? ceilToRupee((gross * rates.esiErRate) / 100) : 0

  const pt = e.ptEnabled ? professionalTax(gross, e.ptState ?? 'MH', opts.date) : 0
  // Never recover more than is left to pay: an advance instalment that pushes the net negative
  // turns a deduction into a debt, which is not what the payslip says and not what the bank file
  // can carry. The remainder simply waits for next month.
  const advanceRecovery = Math.max(0, Math.min(e.advanceRecovery ?? 0, gross - pfEmp - esiEmp - pt - otherDeductions))
  const net = gross - pfEmp - esiEmp - pt - otherDeductions - advanceRecovery

  return {
    basic, hra, special, otherEarnings, otherDeductions, advanceRecovery, gross,
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

/** ESIC monthly-contribution upload CSV (the portal's MC excel template, saved as CSV). */
export function buildEsiCsv(rows: EsiInput[]): string {
  const header = 'IP Number,IP Name,No of Days,Total Monthly Wages,Reason Code for Zero Workdays,Last Working Day'
  const body = rows.map((r) =>
    [csvCell(r.esicNo), csvCell(r.name), String(Math.round(r.payableDays)), String(rupees(r.gross)), '0', ''].join(',')
  )
  return [header, ...body].join('\n')
}


// ---------- ECR validation (roadmap #172) ----------

/**
 * Check an ECR before the portal does.
 *
 * The EPFO upload fails as a whole file with a line number and a code, which means a single
 * missing UAN costs a round trip to a slow portal and a hunt through a text file. Every rule here
 * is one the portal enforces; each problem names the employee rather than the row, because the
 * fix happens in the employee master, not in the file.
 *
 * Severity matters: a missing UAN is fatal (the file will be rejected), while a name the portal
 * will silently transliterate is a warning worth seeing but not worth blocking on.
 */
export interface EcrProblem {
  employee: string
  field: 'uan' | 'name' | 'wages' | 'contribution' | 'days'
  severity: 'error' | 'warning'
  message: string
}

/** UANs are exactly 12 digits and, in practice, always begin with 1. */
const UAN_RE = /^\d{12}$/

export function validateEcr(rows: EcrInput[]): EcrProblem[] {
  const problems: EcrProblem[] = []
  const seenUan = new Map<string, string>()

  for (const r of rows) {
    const who = r.name.trim() || '(unnamed employee)'
    const uan = r.uan.trim()

    if (!uan) {
      problems.push({ employee: who, field: 'uan', severity: 'error', message: 'No UAN — EPFO will reject the whole file' })
    } else if (!UAN_RE.test(uan)) {
      problems.push({
        employee: who,
        field: 'uan',
        severity: 'error',
        message: `UAN "${uan}" is not 12 digits`
      })
    } else {
      const other = seenUan.get(uan)
      if (other && other !== who) {
        problems.push({
          employee: who,
          field: 'uan',
          severity: 'error',
          message: `Shares UAN ${uan} with ${other} — one of the two masters is wrong`
        })
      }
      seenUan.set(uan, who)
    }

    if (!r.name.trim()) {
      problems.push({ employee: '(unnamed employee)', field: 'name', severity: 'error', message: 'No name' })
    } else if (/[^A-Za-z .'-]/.test(r.name.trim())) {
      // The portal accepts only Latin letters and a few separators, and silently mangles the rest.
      problems.push({
        employee: who,
        field: 'name',
        severity: 'warning',
        message: 'Name has characters the portal will strip — check it matches the UAN record'
      })
    }

    if (r.basic <= 0) {
      problems.push({ employee: who, field: 'wages', severity: 'error', message: 'EPF wages are zero' })
    }
    if (r.pfEmp <= 0 && r.basic > 0) {
      problems.push({
        employee: who,
        field: 'contribution',
        severity: 'warning',
        message: 'EPF wages but no employee contribution — check PF is enabled on the master'
      })
    }
    if (r.epsEr > r.pfEr) {
      problems.push({
        employee: who,
        field: 'contribution',
        severity: 'error',
        message: 'Pension share exceeds the employer share — the difference column would be negative'
      })
    }
    if (r.payableDays > r.monthDays) {
      problems.push({
        employee: who,
        field: 'days',
        severity: 'error',
        message: `${r.payableDays} payable days in a ${r.monthDays}-day month — NCP days would be negative`
      })
    }
  }

  // Errors first: the list is read top-down and the blocking ones are what stop the upload.
  return problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
}

/** True when the file can be uploaded at all — warnings do not block. */
export function ecrUploadable(problems: EcrProblem[]): boolean {
  return !problems.some((p) => p.severity === 'error')
}
