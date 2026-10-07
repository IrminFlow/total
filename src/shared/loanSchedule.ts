/**
 * Loan / EMI schedule engine (WP 4.4) — pure, no DB. All money is integer paise; the only float
 * is the annuity factor used to derive the EMI itself, which is rounded to the paise once and
 * never fed back into balances.
 *
 * Reducing balance (the method Indian banks quote for term and home loans):
 *
 *     EMI = P · r · (1 + r)^n / ((1 + r)^n − 1)        r = annual rate / 12 / 100, n = instalments
 *
 * This is the present value of an ordinary annuity solved for the payment — the standard formula
 * behind every bank's published EMI calculator. Worked examples pinned in loanSchedule.test.ts
 * (both reproducible by hand from the formula): ₹1,00,000 at 12 % for 12 months → EMI ₹8,884.88,
 * first month's interest ₹1,000.00; ₹10,00,000 at 10 % for 240 months → EMI ₹9,650.22.
 *   UNVERIFIED / bank-specific: banks differ on EMI rounding (some round up to the rupee) and on
 *   broken-period interest between disbursement and the first EMI — the bank's own schedule
 *   always wins; enter its EMI as the override when it differs.
 *
 * Rounding (documented, deterministic):
 * - EMI: the formula's value rounded half-up to the paise (or the user's override).
 * - Each month's interest = round_half_up(opening balance × annual rate / 12) in paise, computed
 *   exactly in BigInt (the rate is held in thousandths of a percent: 10.5 % = 10 500).
 * - Principal = EMI − interest; the LAST instalment repays the whole remaining balance (it
 *   absorbs every rounding remainder), so Σ principal = the amount owed exactly and the closing
 *   balance is zero.
 * - Monthly rests: interest is charged on the balance at each instalment date; a prepayment made
 *   between instalments reduces the balance the next instalment's interest is computed on (no
 *   broken-period day count).
 *
 * Flat rate (optional; vehicle / consumer loans): total interest = P × rate × n / 12, spread
 * evenly (floor per instalment, the last takes the remainder); principal = P / n likewise. The
 * effective rate of a flat loan is far higher than the quoted one — the screen says so.
 *
 * Moratorium: `moratoriumMonths` instalment dates come first. `capitalise` adds each month's
 * interest to the balance (no payment; booked as a journal Dr interest / Cr loan);
 * `interest_only` pays just the interest. EMIs are then computed on the balance after the
 * moratorium over `tenureMonths` instalments.
 */

export type EmiMethod = 'reducing' | 'flat'
export type MoratoriumMode = 'capitalise' | 'interest_only'
export type PrepaymentEffect = 'reduce_tenure' | 'reduce_emi'
export type ScheduleKind = 'emi' | 'moratorium' | 'prepayment'

export interface LoanTerms {
  /** Amount disbursed, paise. */
  principal: number
  /** Annual rate in thousandths of a percent (10.5 % = 10 500). */
  annualRateMilli: number
  /** Number of EMIs after any moratorium. */
  tenureMonths: number
  /** Date of the first instalment (or first moratorium month); later ones fall on the same day of
   *  each following month, clamped to the month's last day. */
  firstDueDate: string
  method: EmiMethod
  moratoriumMonths: number
  moratoriumMode: MoratoriumMode
  /** The bank's stated EMI when it differs from the formula (reducing balance only). */
  emiOverride: number | null
}

export interface Prepayment {
  date: string
  /** Paise, positive. */
  amount: number
  effect: PrepaymentEffect
}

export interface ScheduleRow {
  /** 1-based position in the schedule. */
  seq: number
  dueDate: string
  kind: ScheduleKind
  opening: number
  /** Cash paid on this row (0 for a capitalised moratorium month). */
  payment: number
  interest: number
  /** Principal repaid (negative for a capitalised moratorium month: the balance grows). */
  principal: number
  closing: number
}

export interface LoanSchedule {
  /** The EMI the schedule started with (after any moratorium). */
  emi: number
  rows: ScheduleRow[]
  totalInterest: number
  totalPayment: number
}

/** a × b / d for integers, rounded half away from zero — exact via BigInt (any signs, d ≠ 0). */
export function mulDivRound(a: number, b: number, d: number): number {
  if (d === 0) throw new Error('Division by zero')
  const neg = (a < 0) !== (b < 0) !== (d < 0)
  const n = BigInt(Math.abs(Math.round(a))) * BigInt(Math.abs(Math.round(b)))
  const den = BigInt(Math.abs(Math.round(d)))
  const q = Number((n * 2n + den) / (den * 2n))
  return neg && q !== 0 ? -q : q
}

/** One month's interest on `balance` at `annualRateMilli` (thousandths of a percent). */
export function monthlyInterest(balance: number, annualRateMilli: number): number {
  return mulDivRound(balance, annualRateMilli, 1_200_000)
}

/** The reducing-balance EMI for `principal` over `n` monthly instalments, rounded to the paise. */
export function emiFor(principal: number, annualRateMilli: number, n: number): number {
  if (n <= 0) throw new Error('Tenure must be at least one instalment')
  if (principal <= 0) return 0
  if (annualRateMilli === 0) return Math.ceil(principal / n)
  const r = annualRateMilli / 1_200_000
  const f = Math.pow(1 + r, n)
  return Math.round((principal * r * f) / (f - 1))
}

/** `firstDueDate`'s day-of-month, `k` months on, clamped to the month's length. */
export function instalmentDate(firstDueDate: string, k: number): string {
  const [y, m, d] = firstDueDate.split('-').map(Number) as [number, number, number]
  const idx = y * 12 + (m - 1) + k
  const yy = Math.floor(idx / 12)
  const mm = (idx % 12) + 1
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

export function validateTerms(t: LoanTerms): string[] {
  const errors: string[] = []
  if (!Number.isSafeInteger(t.principal) || t.principal <= 0) errors.push('Principal must be above zero')
  if (!Number.isSafeInteger(t.annualRateMilli) || t.annualRateMilli < 0 || t.annualRateMilli > 60_000) errors.push('Rate must be between 0 % and 60 %')
  if (!Number.isInteger(t.tenureMonths) || t.tenureMonths < 1 || t.tenureMonths > 600) errors.push('Tenure must be 1 to 600 months')
  if (!Number.isInteger(t.moratoriumMonths) || t.moratoriumMonths < 0 || t.moratoriumMonths > 60) errors.push('Moratorium must be 0 to 60 months')
  if (t.method === 'flat' && t.moratoriumMonths > 0 && t.moratoriumMode === 'capitalise') errors.push('A flat-rate loan cannot capitalise moratorium interest')
  if (t.method === 'flat' && t.emiOverride != null) errors.push('A flat-rate EMI is fixed by the rate; leave the EMI blank')
  if (t.emiOverride != null && (!Number.isSafeInteger(t.emiOverride) || t.emiOverride <= 0)) errors.push('EMI must be above zero')
  return errors
}

/** Generate the full schedule for a loan and its prepayments. Throws on terms that cannot amortise. */
export function generateSchedule(terms: LoanTerms, prepayments: readonly Prepayment[] = []): LoanSchedule {
  const errors = validateTerms(terms)
  if (errors.length) throw new Error(errors.join('; '))
  if (terms.method === 'flat') {
    if (prepayments.length) throw new Error('Prepayments apply to reducing-balance loans only')
    return flatSchedule(terms)
  }
  const rows: ScheduleRow[] = []
  const pre = [...prepayments].sort((a, b) => a.date.localeCompare(b.date))
  let pi = 0
  let balance = terms.principal
  let seq = 0
  const push = (r: Omit<ScheduleRow, 'seq'>): void => {
    rows.push({ seq: ++seq, ...r })
  }

  for (let k = 0; k < terms.moratoriumMonths; k++) {
    const dueDate = instalmentDate(terms.firstDueDate, k)
    const interest = monthlyInterest(balance, terms.annualRateMilli)
    if (terms.moratoriumMode === 'capitalise') {
      push({ dueDate, kind: 'moratorium', opening: balance, payment: 0, interest, principal: -interest, closing: balance + interest })
      balance += interest
    } else {
      push({ dueDate, kind: 'moratorium', opening: balance, payment: interest, interest, principal: 0, closing: balance })
    }
  }

  let emi = terms.emiOverride ?? emiFor(balance, terms.annualRateMilli, terms.tenureMonths)
  const startEmi = emi
  const n = terms.tenureMonths
  for (let i = 0; i < n && balance > 0; i++) {
    const dueDate = instalmentDate(terms.firstDueDate, terms.moratoriumMonths + i)
    // Prepayments dated before this instalment reduce the balance first.
    while (pi < pre.length && pre[pi]!.date < dueDate && balance > 0) {
      const p = pre[pi++]!
      const amount = Math.min(p.amount, balance)
      push({ dueDate: p.date, kind: 'prepayment', opening: balance, payment: amount, interest: 0, principal: amount, closing: balance - amount })
      balance -= amount
      if (balance > 0 && p.effect === 'reduce_emi') emi = emiFor(balance, terms.annualRateMilli, n - i)
    }
    if (balance <= 0) break
    const interest = monthlyInterest(balance, terms.annualRateMilli)
    const last = i === n - 1 || balance + interest <= emi
    const principal = last ? balance : emi - interest
    if (principal <= 0) throw new Error('The EMI does not cover the monthly interest — the loan would never be repaid')
    push({ dueDate, kind: 'emi', opening: balance, payment: principal + interest, interest, principal, closing: balance - principal })
    balance -= principal
  }
  // A prepayment dated after the last instalment has nothing left to repay — ignored.
  return summarise(startEmi, rows)
}

function flatSchedule(t: LoanTerms): LoanSchedule {
  const rows: ScheduleRow[] = []
  let seq = 0
  const monthly = monthlyInterest(t.principal, t.annualRateMilli)
  for (let k = 0; k < t.moratoriumMonths; k++) {
    rows.push({ seq: ++seq, dueDate: instalmentDate(t.firstDueDate, k), kind: 'moratorium', opening: t.principal, payment: monthly, interest: monthly, principal: 0, closing: t.principal })
  }
  const n = t.tenureMonths
  const totalInterest = mulDivRound(t.principal, t.annualRateMilli * n, 1_200_000)
  const intEach = Math.floor(totalInterest / n)
  const prinEach = Math.floor(t.principal / n)
  let balance = t.principal
  for (let i = 0; i < n; i++) {
    const last = i === n - 1
    const interest = last ? totalInterest - intEach * (n - 1) : intEach
    const principal = last ? balance : prinEach
    rows.push({
      seq: ++seq, dueDate: instalmentDate(t.firstDueDate, t.moratoriumMonths + i), kind: 'emi',
      opening: balance, payment: principal + interest, interest, principal, closing: balance - principal
    })
    balance -= principal
  }
  return summarise(prinEach + intEach, rows)
}

function summarise(emi: number, rows: ScheduleRow[]): LoanSchedule {
  return {
    emi,
    rows,
    totalInterest: rows.reduce((s, r) => s + r.interest, 0),
    totalPayment: rows.reduce((s, r) => s + r.payment, 0)
  }
}

/** Interest falling due in [from, to] (the "interest for the year" figure). */
export function interestBetween(rows: readonly Pick<ScheduleRow, 'dueDate' | 'interest'>[], from: string, to: string): number {
  return rows.filter((r) => r.dueDate >= from && r.dueDate <= to).reduce((s, r) => s + r.interest, 0)
}

/** Percent text for a rate held in thousandths of a percent: 10500 → "10.5". */
export function rateMilliText(milli: number): string {
  const s = (milli / 1000).toFixed(3)
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

/** Parse "10.5" / "10.75 %" into thousandths of a percent; null when not a plain non-negative number. */
export function parseRateMilli(text: string): number | null {
  const t = text.replace('%', '').trim()
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  return Number(whole) * 1000 + Number((frac + '000').slice(0, 3))
}
