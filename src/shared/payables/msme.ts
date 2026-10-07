/**
 * MSME payment rules (WP 4.3) — pure. The s.15 payment deadline, s.16 interest (INDICATIVE), the
 * Income-tax s.43B(h) disallowance figure and the MSME Form 1 half-years. The bank rate comes in
 * as data (the editable, effective-dated `msme_bank_rates` table, migration 034) — never
 * hard-coded here. Every rule cites its text next to the code that applies it; the source list
 * with dates and the UNVERIFIED items is `MSME_SOURCES` in ./msmeSources.ts.
 */

// ---------------------------------------------------------------------------------------------
// Supplier classification
// ---------------------------------------------------------------------------------------------

export const MSME_CATEGORIES = ['micro', 'small', 'medium'] as const
export type MsmeCategory = (typeof MSME_CATEGORIES)[number]

export const MSME_CATEGORY_LABELS: Record<MsmeCategory, string> = { micro: 'Micro', small: 'Small', medium: 'Medium' }

/** A supplier's MSME facts, as stored on its ledger (migration 034). */
export interface MsmeTerms {
  registered: boolean
  category: MsmeCategory | null
  udyamNo: string | null
  /** Credit period agreed IN WRITING with the supplier, days; null = no written agreement. */
  agreedCreditDays: number | null
}

/**
 * MSMED Act 2006 s.2(n): "supplier" means a micro or small enterprise which has filed a
 * memorandum with the authority referred to in s.8(1) (now the Udyam registration). Chapter V
 * (ss.15–24, delayed payments) therefore protects MICRO and SMALL suppliers only — a medium
 * enterprise is recorded but gets no s.15 deadline, s.16 interest, s.43B(h) or Form 1 line.
 * A supplier counts only when registered (Udyam): an unregistered unit is not a s.2(n) supplier.
 */
export function isMsmeCovered(t: Pick<MsmeTerms, 'registered' | 'category'>): boolean {
  return t.registered && (t.category === 'micro' || t.category === 'small')
}

/**
 * Udyam Registration Number: "UDYAM-XX-00-0000000" — UDYAM, the two-letter state code, the
 * two-digit district code and a seven-digit serial (the Udyam certificate format under MSME
 * notification S.O. 2119(E), 26 Jun 2020 — see MSME_SOURCES). Case-insensitive on entry, stored
 * upper-case.
 */
export const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/

export function normalizeUdyam(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '')
}

export function isValidUdyam(raw: string): boolean {
  return UDYAM_RE.test(normalizeUdyam(raw))
}

// ---------------------------------------------------------------------------------------------
// Date helpers (UTC, ISO 'YYYY-MM-DD')
// ---------------------------------------------------------------------------------------------

export function addDays(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000)
}

/** Same day-of-month `n` months later, clamped to the month's last day (31 Jan + 1 = 28/29 Feb). */
export function addMonthsClamped(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const idx = y * 12 + (m - 1) + n
  const ny = Math.floor(idx / 12)
  const nm = (idx % 12) + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------------------------
// s.15 — the payment deadline
// ---------------------------------------------------------------------------------------------

/** s.15 proviso: the agreed period may "in no case ... exceed forty-five days" from acceptance. */
export const S15_MAX_AGREED_DAYS = 45
/** s.2(b): the "appointed day" follows the expiry of fifteen days from acceptance. */
export const S15_NO_AGREEMENT_DAYS = 15

export interface S15Deadline {
  /** Last day on which payment is in time (inclusive). s.16 interest runs from the next day. */
  payBy: string
  /** First day of delay — s.2(b)'s "appointed day", or the day after the agreed date. */
  interestFrom: string
  /** Days from acceptance that were allowed. */
  days: number
  basis: 'agreed' | 'agreed_capped' | 'no_agreement'
}

/**
 * MSMED Act 2006 s.15: the buyer pays "on or before the date agreed upon between him and the
 * supplier in writing or, where there is no agreement in this behalf, before the appointed day",
 * and the agreed period shall "in no case ... exceed forty-five days from the day of acceptance or
 * the day of deemed acceptance". s.2(b): "appointed day" means "the day following immediately
 * after the expiry of the period of fifteen days from the day of acceptance or the day of deemed
 * acceptance of any goods or any services by a buyer from a supplier".
 *
 * So, from the acceptance date A:
 *  - written agreement of N days: pay by A + min(N, 45); interest from the day after;
 *  - no agreement: the fifteen days expire on A + 15, the appointed day is A + 16 and payment must
 *    be made "before" it — pay by A + 15, interest from A + 16 (the appointed day).
 * Day counting excludes the day of acceptance (General Clauses Act 1897 s.9(1): where "from" is
 * used, the first day of the series is excluded).
 *
 * `acceptedOn` is the bill (voucher) date in this app — the day of deemed acceptance when no
 * objection is raised (s.2(b) Explanation). Goods accepted on an earlier GRN, or an objection
 * raised and later removed, are not modelled: adjust the bill date / agreed days if it matters.
 */
export function s15Deadline(acceptedOn: string, agreedCreditDays: number | null): S15Deadline {
  if (agreedCreditDays != null && agreedCreditDays >= 0) {
    const capped = agreedCreditDays > S15_MAX_AGREED_DAYS
    const days = Math.min(agreedCreditDays, S15_MAX_AGREED_DAYS)
    const payBy = addDays(acceptedOn, days)
    return { payBy, interestFrom: addDays(payBy, 1), days, basis: capped ? 'agreed_capped' : 'agreed' }
  }
  const payBy = addDays(acceptedOn, S15_NO_AGREEMENT_DAYS)
  return { payBy, interestFrom: addDays(payBy, 1), days: S15_NO_AGREEMENT_DAYS, basis: 'no_agreement' }
}

// ---------------------------------------------------------------------------------------------
// s.16 — compound interest at three times the RBI bank rate (INDICATIVE)
// ---------------------------------------------------------------------------------------------

/** s.16: "three times of the bank rate notified by the Reserve Bank". */
export const S16_BANK_RATE_MULTIPLE = 3

/** One effective-dated bank-rate row (msme_bank_rates). */
export interface BankRateRow {
  id?: number
  fromDate: string
  /** RBI Bank Rate, basis points (575 = 5.75 %). */
  rateBp: number
  source: string
}

/** The bank rate in force on `date` (latest row with fromDate ≤ date), or null. */
export function bankRateOn(rows: readonly BankRateRow[], date: string): BankRateRow | null {
  let best: BankRateRow | null = null
  for (const r of rows) if (r.fromDate <= date && (!best || r.fromDate > best.fromDate)) best = r
  return best
}

/** round(a × b / c) for non-negative integers, exactly (BigInt: paise × bp × days can pass 2^53). */
function mulDivRound(a: number, b: number, c: number): number {
  const n = BigInt(a) * BigInt(b)
  const d = BigInt(c)
  return Number((n * 2n + d) / (d * 2n))
}

export interface S16Interest {
  interestPaise: number
  /** Days of delay counted (interestFrom … upTo, both included). */
  days: number
  /** Complete months compounded (monthly rests). */
  months: number
  /** Annual s.16 rate at the start of the delay, bp (3 × bank rate); null = no bank rate on file. */
  rateBp: number | null
}

/**
 * s.16: the buyer "shall ... be liable to pay compound interest with monthly rests to the supplier
 * on that amount from the appointed day or, as the case may be, from the date immediately
 * following the date agreed upon, at three times of the bank rate notified by the Reserve Bank".
 * Computed from `interestFrom` up to and including `upTo` (the payment date, or the report date
 * for a bill still unpaid):
 *  - each complete month (same day-of-month, clamped) adds balance × rate / 12 to the balance —
 *    the monthly rest — at the rate in force on that month's first day;
 *  - the remaining days add balance × rate × days / 365, simple.
 * INDICATIVE: the Act prescribes no day-count convention; MSEFCs and courts vary. Paise, rounded.
 */
export function s16Interest(principalPaise: number, interestFrom: string, upTo: string, rates: readonly BankRateRow[]): S16Interest {
  const days = daysBetween(interestFrom, upTo) + 1
  const first = bankRateOn(rates, interestFrom)
  const rateBp = first ? first.rateBp * S16_BANK_RATE_MULTIPLE : null
  if (principalPaise <= 0 || days <= 0 || !first) return { interestPaise: 0, days: Math.max(0, days), months: 0, rateBp }
  const end = addDays(upTo, 1) // exclusive
  let balance = principalPaise
  let cursor = interestFrom
  let months = 0
  for (;;) {
    const next = addMonthsClamped(interestFrom, months + 1)
    if (next > end) break
    const rate = (bankRateOn(rates, cursor) ?? first).rateBp * S16_BANK_RATE_MULTIPLE
    balance += mulDivRound(balance, rate, 12 * 10000)
    cursor = next
    months++
  }
  const rem = daysBetween(cursor, end)
  if (rem > 0) {
    const rate = (bankRateOn(rates, cursor) ?? first).rateBp * S16_BANK_RATE_MULTIPLE
    balance += mulDivRound(balance, rate * rem, 365 * 10000)
  }
  return { interestPaise: balance - principalPaise, days, months, rateBp }
}

// ---------------------------------------------------------------------------------------------
// Income-tax s.43B(h) — deduction only on actual payment when paid beyond the s.15 time limit
// ---------------------------------------------------------------------------------------------

export type Disallowance43BhStatus = 'disallowed' | 'at_risk' | 'allowed'

export interface Bill43BhInput {
  /** Pending on the financial year's last day. */
  pendingAtFyEnd: number
  /** s.15 last day to pay. */
  payBy: string
  /** Still pending at the end of `payBy` — null when `payBy` has not passed yet (not knowable). */
  pendingAtPayBy: number | null
}

export interface Bill43BhResult {
  status: Disallowance43BhStatus
  /** Added back for the year: unpaid at FY end AND not paid within the s.15 period. */
  disallowed: number
  /** Unpaid at FY end with the s.15 period still running — disallowed unless paid by payBy. */
  atRisk: number
}

/**
 * Income-tax Act 1961 s.43B(h) (inserted by the Finance Act 2023, from AY 2024-25) and its
 * Income-tax Act 2025 counterpart (MSME_SOURCES): "any sum payable by the assessee to a micro or
 * small enterprise beyond the time limit specified in section 15 of the [MSMED Act]" is allowed
 * only in the year it is actually paid. A bill booked and paid late inside the same year is
 * still allowed that year, so only what is UNPAID AT YEAR END matters:
 *  - the s.15 period ended on or before the FY end → all of it still pending at FY end is
 *    disallowed;
 *  - the period ends after the FY end and has run out → the part of the FY-end balance still
 *    unpaid when it ran out is disallowed (what was paid in time is allowed for the year);
 *  - the period is still running on `today`, or the year itself has not ended → at risk.
 * Only amounts claimed as a deduction are affected — a capital purchase on the same supplier
 * ledger is not; the report says to review those.
 */
export function disallowance43Bh(b: Bill43BhInput, fyEnd: string, today: string): Bill43BhResult {
  if (b.pendingAtFyEnd <= 0) return { status: 'allowed', disallowed: 0, atRisk: 0 }
  // The year has not ended: a bill paid late but before the year end is still allowed for the
  // year, so nothing is settled yet — all of it is at risk.
  if (today <= fyEnd) return { status: 'at_risk', disallowed: 0, atRisk: b.pendingAtFyEnd }
  if (b.payBy <= fyEnd) return { status: 'disallowed', disallowed: b.pendingAtFyEnd, atRisk: 0 }
  if (b.payBy >= today || b.pendingAtPayBy == null) return { status: 'at_risk', disallowed: 0, atRisk: b.pendingAtFyEnd }
  const late = Math.min(b.pendingAtFyEnd, Math.max(0, b.pendingAtPayBy))
  return late > 0 ? { status: 'disallowed', disallowed: late, atRisk: 0 } : { status: 'allowed', disallowed: 0, atRisk: 0 }
}

// ---------------------------------------------------------------------------------------------
// MSME Form 1 — half-yearly return of dues to micro / small suppliers beyond 45 days
// ---------------------------------------------------------------------------------------------

export interface FormMsme1Period {
  /** e.g. 'Apr–Sep 2026' */
  label: string
  from: string
  to: string
  /** Due date of the return for the half-year. */
  dueDate: string
  half: 'H1' | 'H2'
}

/** Dues outstanding more than this many days from acceptance are reportable on MSME Form 1. */
export const FORM_MSME1_DAYS = 45

/**
 * The half-year containing `date`: April–September (return due 31 October) or October–March
 * (due 30 April) — MCA's Specified Companies (Furnishing of information about payment to micro
 * and small enterprise suppliers) Order, 2019 (citation in MSME_SOURCES).
 */
export function formMsme1Period(date: string): FormMsme1Period {
  const [y, m] = date.split('-').map(Number) as [number, number]
  if (m >= 4 && m <= 9) return { label: `Apr–Sep ${y}`, from: `${y}-04-01`, to: `${y}-09-30`, dueDate: `${y}-10-31`, half: 'H1' }
  const start = m >= 10 ? y : y - 1
  return { label: `Oct ${start}–Mar ${start + 1}`, from: `${start}-10-01`, to: `${start + 1}-03-31`, dueDate: `${start + 1}-04-30`, half: 'H2' }
}

/** The half-year before the one containing `date` (the one whose return falls due next). */
export function previousFormMsme1Period(date: string): FormMsme1Period {
  return formMsme1Period(addDays(formMsme1Period(date).from, -1))
}

// ---------------------------------------------------------------------------------------------
// Ageing against the s.15 deadline
// ---------------------------------------------------------------------------------------------

export const MSME_AGE_BUCKETS = ['within', 'late_1_30', 'late_31_60', 'late_61_plus'] as const
export type MsmeAgeBucket = (typeof MSME_AGE_BUCKETS)[number]

export const MSME_AGE_LABELS: Record<MsmeAgeBucket, string> = {
  within: 'Within s.15 period',
  late_1_30: '1–30 days late',
  late_31_60: '31–60 days late',
  late_61_plus: '61+ days late'
}

export function msmeAgeBucket(payBy: string, asOn: string): { bucket: MsmeAgeBucket; daysLate: number } {
  const daysLate = Math.max(0, daysBetween(payBy, asOn))
  const bucket: MsmeAgeBucket = daysLate === 0 ? 'within' : daysLate <= 30 ? 'late_1_30' : daysLate <= 60 ? 'late_31_60' : 'late_61_plus'
  return { bucket, daysLate }
}
