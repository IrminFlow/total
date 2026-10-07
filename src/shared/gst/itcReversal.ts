/**
 * ITC reversal workings (WP 3.4) — pure maths for the GSTR-3B Table 4(B) figures:
 *  - rule 42 (common credit on inputs / input services): C1 = T − (T1 + T2 + T3), C2 = C1 − T4,
 *    D1 = (E ÷ F) × C2, D2 = 5% of C2 when inputs are partly used for non-business purposes,
 *    C3 = C2 − (D1 + D2); with the annual true-up on the year's E/F (rule 42(2));
 *  - rule 43 (common credit on capital goods): Tc = Σ A of common capital goods within their
 *    useful life, Tm = Tc ÷ 60, Te = (E ÷ F) × Tm;
 *  - rule 37 (value + tax not paid within 180 days of the invoice): ITC proportionate to the
 *    unpaid amount reversed in the return for the tax period immediately following the 180 days,
 *    with s.50 interest, re-availed when paid;
 *  - s.17(5) blocked credit (parties marked blocked).
 * Each figure is computed per tax head (IGST / CGST / SGST / cess) in integer paise.
 * Sources: GST_SOURCES.rule42 / rule43 / rule37 / s17 / s50 / circular170 (./sources.ts).
 * Rule 37A (supplier did not file GSTR-3B) needs the supplier's filing status from the portal —
 * not derivable offline; it is entered by hand in 4(B)(2).
 */
import { RULE37_RULES, RULE42_RULES } from './sources'

export interface Heads {
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export const ZERO_HEADS: Heads = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
export const HEAD_KEYS = ['igst', 'cgst', 'sgst', 'cess'] as const

export const addHeads = (...xs: Heads[]): Heads =>
  xs.reduce((a, b) => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst, cess: a.cess + b.cess }), { ...ZERO_HEADS })
export const subHeads = (a: Heads, b: Heads): Heads => ({ igst: a.igst - b.igst, cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst, cess: a.cess - b.cess })
export const mapHeads = (a: Heads, f: (n: number) => number): Heads => ({ igst: f(a.igst), cgst: f(a.cgst), sgst: f(a.sgst), cess: f(a.cess) })
export const sumHeads = (a: Heads): number => a.igst + a.cgst + a.sgst + a.cess
export const maxZeroHeads = (a: Heads): Heads => mapHeads(a, (n) => Math.max(0, n))

/** a × b ÷ c in exact integer arithmetic, rounded half away from zero (paise × paise products
 *  overflow a double's integer range). c must be non-zero. */
export function mulDiv(a: number, b: number, c: number): number {
  const num = BigInt(Math.round(a)) * BigInt(Math.round(b))
  const den = BigInt(Math.round(c))
  const neg = (num < 0n) !== (den < 0n)
  const an = num < 0n ? -num : num
  const ad = den < 0n ? -den : den
  const q = (an * 2n + ad) / (ad * 2n)
  return Number(neg ? -q : q)
}

// ---------- rule 42 ----------

export interface Rule42Input {
  /** T — total input tax on inputs and input services in the period. */
  T: Heads
  /** T1 — used exclusively for non-business purposes. */
  T1: Heads
  /** T2 — used exclusively for exempt supplies. */
  T2: Heads
  /** T3 — not available under s.17(5) (blocked). */
  T3: Heads
  /** T4 — used exclusively for taxable (incl. zero-rated) supplies. */
  T4: Heads
  /** E — value of exempt supplies in the period (paise). */
  E: number
  /** F — total turnover in the State in the period (paise). */
  F: number
  /** Inputs are partly used for non-business purposes → D2 = 5% of C2. */
  nonBusiness: boolean
}

export interface Rule42Result {
  C1: Heads
  C2: Heads
  D1: Heads
  D2: Heads
  C3: Heads
  /** D1 + D2 — the rule 42 amount for 4(B)(1). */
  reversal: Heads
  E: number
  F: number
}

export function rule42(i: Rule42Input): Rule42Result {
  const C1 = subHeads(i.T, addHeads(i.T1, i.T2, i.T3))
  const C2 = subHeads(C1, i.T4)
  const D1 = i.F > 0 ? mapHeads(C2, (c) => mulDiv(c, i.E, i.F)) : { ...ZERO_HEADS }
  const D2 = i.nonBusiness ? mapHeads(C2, (c) => mulDiv(c, RULE42_RULES.nonBusinessPct, 100)) : { ...ZERO_HEADS }
  const C3 = subHeads(C2, addHeads(D1, D2))
  return { C1, C2, D1, D2, C3, reversal: maxZeroHeads(addHeads(D1, D2)), E: i.E, F: i.F }
}

/**
 * Rule 42 explanation: when a tax period has no turnover, E/F is taken from the last tax period
 * (before it) for which turnover details are available. `history` = earlier periods, oldest first.
 */
export function effectiveTurnover(current: { E: number; F: number }, history: { E: number; F: number }[]): { E: number; F: number; borrowed: boolean } {
  if (current.F > 0) return { ...current, borrowed: false }
  for (let k = history.length - 1; k >= 0; k--) if (history[k]!.F > 0) return { ...history[k]!, borrowed: true }
  return { E: 0, F: 0, borrowed: false }
}

export interface Rule42TrueUp {
  /** Σ C2 of the year's months. */
  C2: Heads
  /** D1 + D2 on the YEAR's E/F. */
  annual: Heads
  /** Σ of the monthly D1 + D2. */
  monthly: Heads
  /** annual − monthly: positive = reverse more (with interest from 1 April of the next FY);
   *  negative = claim back. Both by the due date of the September return after the FY. */
  difference: Heads
  E: number
  F: number
}

/** Rule 42(2) — final computation for the financial year. */
export function rule42TrueUp(months: { C2: Heads; reversal: Heads }[], yearE: number, yearF: number, nonBusiness: boolean): Rule42TrueUp {
  const C2 = addHeads(...months.map((m) => m.C2))
  const monthly = addHeads(...months.map((m) => m.reversal))
  const D1 = yearF > 0 ? mapHeads(C2, (c) => mulDiv(c, yearE, yearF)) : { ...ZERO_HEADS }
  const D2 = nonBusiness ? mapHeads(C2, (c) => mulDiv(c, RULE42_RULES.nonBusinessPct, 100)) : { ...ZERO_HEADS }
  const annual = maxZeroHeads(addHeads(D1, D2))
  return { C2, annual, monthly, difference: subHeads(annual, monthly), E: yearE, F: yearF }
}

// ---------- rule 43 ----------

export interface CapitalGood {
  voucherId: number
  number: string
  date: string
  partyName: string | null
  /** A — the input tax on the capital good (credited to the ledger). */
  itc: Heads
  /** Common to taxable and exempt supplies (only these enter Tc). */
  common: boolean
}

export interface Rule43Result {
  /** Capital goods still within their useful life at the period, with the months used. */
  goods: (CapitalGood & { monthsUsed: number; inLife: boolean })[]
  Tc: Heads
  Tm: Heads
  Te: Heads
  E: number
  F: number
}

/** Whole months from the invoice month to the period month, inclusive of the invoice month. */
export function monthsOfUse(invoiceDate: string, periodKey: string): number {
  const [iy, im] = invoiceDate.split('-').map(Number) as [number, number]
  const [py, pm] = periodKey.split('-').map(Number) as [number, number]
  return (py - iy) * 12 + (pm - im) + 1
}

/** Rule 43 for the tax period `periodKey` ('YYYY-MM'): useful life 60 months from the invoice. */
export function rule43(goods: CapitalGood[], periodKey: string, E: number, F: number): Rule43Result {
  const life = RULE42_RULES.capitalGoodsLifeMonths
  const rows = goods.map((g) => {
    const monthsUsed = monthsOfUse(g.date, periodKey)
    return { ...g, monthsUsed, inLife: monthsUsed >= 1 && monthsUsed <= life }
  })
  const Tc = addHeads(...rows.filter((g) => g.common && g.inLife).map((g) => g.itc))
  const Tm = mapHeads(Tc, (c) => mulDiv(c, 1, life))
  const Te = F > 0 ? mapHeads(Tm, (t) => mulDiv(t, E, F)) : { ...ZERO_HEADS }
  return { goods: rows, Tc, Tm, Te: maxZeroHeads(Te), E, F }
}

// ---------- rule 37 ----------

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const nextMonthKey = (key: string): string => {
  const [y, m] = key.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
/** The 3B due date (20th of the next month, rule 61) for the period 'YYYY-MM'. */
export const gstr3bDueDate = (periodKey: string): string => `${nextMonthKey(periodKey)}-20`
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

/** A purchase bill and its payments, for rule 37. */
export interface Rule37Bill {
  voucherId: number
  number: string
  supplierRef: string | null
  date: string
  partyLedgerId: number
  partyName: string
  /** Value of supply + tax payable to the supplier (the bill amount), paise. */
  billAmount: number
  /** ITC availed on the bill. */
  itc: Heads
  /** Still unpaid on the 180th day after the invoice. */
  unpaidAt180: number
  /** Unpaid at the end of the month before `periodKey` and at its end (for re-availment). */
  unpaidAtPrevEnd: number
  unpaidAtEnd: number
}

export interface Rule37Event {
  bill: Rule37Bill
  /** The 180th day after the invoice. */
  day180: string
  /** The tax period the reversal belongs to ('YYYY-MM'): immediately after the 180 days end. */
  reversalPeriod: string
  /** ITC reversed for the unpaid part (when this period is the reversal period). */
  reversed: Heads
  /** ITC re-availed for what was paid during this period (a bill reversed in an earlier
   *  period). */
  reclaimed: Heads
  /** s.50 interest on the reversal (estimate — see `interestNote`). */
  interest: Heads
  interestDays: number
}

export const RULE37_INTEREST_NOTE =
  'Interest at the s.50 rate from the 3B due date of the purchase month (when the credit was availed) to the 3B due date of the reversal period, assuming the credit was utilised.'

/** The 180-day facts of a bill: the 180th day and the reversal tax period. */
export function rule37Timeline(invoiceDate: string): { day180: string; reversalPeriod: string } {
  const day180 = addDays(invoiceDate, RULE37_RULES.days)
  return { day180, reversalPeriod: nextMonthKey(day180.slice(0, 7)) }
}

const proportion = (itc: Heads, part: number, whole: number): Heads => (whole > 0 ? mapHeads(itc, (x) => mulDiv(x, part, whole)) : { ...ZERO_HEADS })

/** Rule 37 events falling in `periodKey`: reversals due now and re-availments of earlier ones. */
export function rule37Events(bills: Rule37Bill[], periodKey: string): Rule37Event[] {
  const out: Rule37Event[] = []
  for (const bill of bills) {
    const { day180, reversalPeriod } = rule37Timeline(bill.date)
    if (bill.unpaidAt180 <= 0 || reversalPeriod > periodKey) continue
    const unpaid = Math.min(bill.unpaidAt180, bill.billAmount)
    let reversed = { ...ZERO_HEADS }
    let interest = { ...ZERO_HEADS }
    let interestDays = 0
    if (reversalPeriod === periodKey) {
      reversed = proportion(bill.itc, unpaid, bill.billAmount)
      interestDays = Math.max(0, daysBetween(gstr3bDueDate(bill.date.slice(0, 7)), gstr3bDueDate(periodKey)))
      interest = mapHeads(reversed, (x) => mulDiv(x * RULE37_RULES.interestPctPa, interestDays, 100 * 365))
    }
    // Paid during this period (after the 180 days): re-avail what was reversed for that part.
    // In the reversal period itself, payments after the 180th day net against the reversal.
    const prevUnpaid = reversalPeriod === periodKey ? unpaid : Math.min(bill.unpaidAtPrevEnd, unpaid)
    const paidNow = Math.max(0, prevUnpaid - Math.max(0, bill.unpaidAtEnd))
    const reclaimed = proportion(bill.itc, Math.min(paidNow, unpaid), bill.billAmount)
    if (sumHeads(reversed) === 0 && sumHeads(reclaimed) === 0) continue
    out.push({ bill, day180, reversalPeriod, reversed, reclaimed, interest, interestDays })
  }
  return out
}

// ---------- the period's workings + journal proposal ----------

export interface ItcReversalSummary {
  /** 4(B)(1) — rules 42 + 43 (+ the automatic s.17(5), shown separately). */
  rule42: Heads
  rule43: Heads
  blocked175: Heads
  /** 4(B)(2) — rule 37 (reclaimable). */
  rule37: Heads
  /** 4(D)(1) — re-availed this period (also added back in 4(A)(5)). */
  reclaimed: Heads
  /** 5.1 interest on the rule 37 reversals. */
  interest: Heads
  /** Optional rule 42 annual true-up included in this proposal (positive = reverse more). */
  trueUp: Heads
  /** The 3B Table 4(B) figures: (1) excluding the automatic s.17(5) part, and (2). */
  table4B1: Heads
  table4B2: Heads
}

export function summarise(p: { rule42: Heads; rule43: Heads; blocked175: Heads; rule37: Heads; reclaimed: Heads; interest: Heads; trueUp?: Heads }): ItcReversalSummary {
  const trueUp = p.trueUp ?? { ...ZERO_HEADS }
  return {
    ...p,
    trueUp,
    table4B1: maxZeroHeads(addHeads(p.rule42, p.rule43, trueUp)),
    table4B2: p.rule37
  }
}

/** One proposed journal line (ledger chosen by the main process). */
export interface ProposalLine {
  role: 'reversal_expense' | 'input_tax' | 'interest_expense' | 'interest_payable'
  head?: (typeof HEAD_KEYS)[number]
  drCr: 'dr' | 'cr'
  amount: number
}

/**
 * The journal that brings the input-tax ledgers in line with 4(B): Dr ITC reversal (expense) /
 * Cr the input tax ledger per head for what is reversed (rules 42/43/37, the s.17(5) credit
 * booked in input ledgers, the true-up), the opposite for what is re-availed; and Dr interest
 * (expense) / Cr GST interest payable. Lines net per head; zero lines are dropped.
 */
export function proposalLines(s: ItcReversalSummary, includeBlocked: boolean): ProposalLine[] {
  const out: ProposalLine[] = []
  const reverse = addHeads(s.rule42, s.rule43, s.rule37, s.trueUp, includeBlocked ? s.blocked175 : ZERO_HEADS)
  const net = subHeads(reverse, s.reclaimed)
  let expense = 0
  for (const h of HEAD_KEYS) {
    const n = net[h]
    if (n === 0) continue
    out.push({ role: 'input_tax', head: h, drCr: n > 0 ? 'cr' : 'dr', amount: Math.abs(n) })
    expense += n
  }
  if (expense !== 0) out.unshift({ role: 'reversal_expense', drCr: expense > 0 ? 'dr' : 'cr', amount: Math.abs(expense) })
  const interest = sumHeads(s.interest)
  if (interest > 0) {
    out.push({ role: 'interest_expense', drCr: 'dr', amount: interest })
    out.push({ role: 'interest_payable', drCr: 'cr', amount: interest })
  }
  return out
}
