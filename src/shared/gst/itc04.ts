/**
 * ITC-04 — what went out to a job worker, what came back, and what the law now deems sold.
 *
 * A principal may send inputs or capital goods to a job worker without paying tax (section 143,
 * CGST Act, read with rule 45). The goods travel on a challan, not an invoice: nothing is
 * supplied, nothing is invoiced, no credit is reversed. That concession has a clock attached to
 * it, and the clock is the whole reason this form exists.
 *
 *   - Section 143(3): inputs not received back — or supplied from the job worker's premises —
 *     within ONE YEAR of being sent out are DEEMED to have been supplied by the principal to the
 *     job worker ON THE DAY THEY WERE SENT OUT.
 *   - Section 143(4): the same for capital goods at THREE YEARS, expressly excluding "moulds and
 *     dies, jigs and fixtures, or tools", which have no clock at all.
 *
 * The sting is the backdating. The tax is not due from the day the year ran out; it is due from
 * the day the challan was raised, which means interest under section 50(1) runs for the whole
 * year (or three) as well. A principal who discovers this in year two owes a year of interest on
 * a supply they never made. So the module treats the clock as the primary output and the form
 * tables as the reporting layer over it, rather than the other way round.
 *
 * A partly returned challan is a partly deemed supply. The statute speaks of "the inputs" not
 * received back, and 40 of 100 pieces not coming back is a deemed supply of 40 pieces, valued
 * pro rata. All-or-nothing in either direction would be wrong, and wrong by a lot.
 *
 * Purity: this is engine code — no DB, no Electron. Quantities are integer thousandths
 * (`qtyMilli`), money is integer paise, and the pro-rata split goes through BigInt so a large
 * challan value multiplied by a large quantity cannot silently leave the safe-integer range.
 *
 * Sections were read against the bare CGST Act, 2017 as amended to date, on 2026-08-25.
 * // VERIFY (2026-08-25): section 143(3)/(4) text and the moulds-and-dies exclusion were recalled
 * // from the bare Act rather than re-read from a current CBIC copy. Confirm the wording — in
 * // particular that the capital-goods exclusion still sits inline in 143(4) — before relying on
 * // the exclusion to suppress a deemed supply for a customer.
 */
import { daysBetween, fyFromStartYear, todayISO } from '../dates'
import { computeGst, supplyTypeFor, type GstBreakup, type SupplyType } from './calc'
import { CRORE } from './turnover'
import { isUqc } from './uqc'

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/** What kind of goods went out. The clock length depends on nothing else. */
export type JobWorkGoodsType = 'input' | 'capital_goods'

/**
 * A job-work challan: the delivery challan's sibling.
 *
 * Deliberately the same vocabulary as the sales chain's delivery challan
 * (`src/main/services/salesDocs.ts`, stage `'challan'`) — number, date, description, qtyMilli,
 * rate — because to the storekeeper it is the same piece of paper. What differs is that this one
 * carries a job worker rather than a customer, a goods type, and an expectation of return.
 */
export interface JobWorkChallan {
  /** Challan number as issued by the principal. Rule 55 requires one; it is the join key. */
  challanNumber: string
  /** ISO 'YYYY-MM-DD'. This is also the deemed-supply date if the goods never come back. */
  challanDate: string
  /**
   * Job worker's GSTIN, or null when the job worker is unregistered.
   *
   * Null is a first-class case, not a data-quality problem: sending to an unregistered job worker
   * is ordinary and lawful, and the form takes the job worker's STATE in place of a GSTIN for
   * exactly this row. Dropping unregistered rows would understate the goods out on challan, which
   * is the one number this form exists to state.
   */
  jobWorkerGstin: string | null
  /** Two-digit state code of the job worker's place of business. Required either way. */
  jobWorkerStateCode: string
  goodsType: JobWorkGoodsType
  description: string
  hsn: string
  /** Integer thousandths. 1.5 kg is 1500. */
  qtyMilli: number
  /** Portal unit quantity code — see `./uqc`. */
  uqc: string
  /** Value of the goods sent, integer paise, for the whole `qtyMilli`. */
  taxableValuePaise: number
  /** GST rate the goods would attract, whole or fractional percent (0, 0.25, 3, 5, 12, 18, 28). */
  gstRate: number
  /**
   * Date the job worker actually received the goods, when they were sent DIRECTLY to him by the
   * principal's supplier. The Explanation to section 143 starts the clock from that receipt, not
   * from the challan. Null/absent means the ordinary case: the clock starts on the challan date.
   */
  receivedByJobWorkerOn?: string | null
  /**
   * Extended due-back date where the Commissioner has allowed one under the proviso to section
   * 143(1) — a further year for inputs, a further two years for capital goods. When set it
   * replaces the computed due date.
   */
  extendedDueBackBy?: string | null
  /**
   * Moulds and dies, jigs and fixtures, or tools. Section 143(4) excludes these from the
   * three-year capital-goods clock entirely, so they are never a deemed supply however long they
   * stay with the job worker. Has no effect on 'input' goods.
   */
  mouldsDiesJigsOrTools?: boolean
}

/**
 * What happened to goods on a challan. The form splits receipts by where the goods went, because
 * only one of these outcomes is an outward supply.
 */
export type JobWorkDisposition =
  /** Came back to the principal from the job worker they were sent to. */
  | 'returned'
  /** Moved on to a different job worker without touching the principal's premises. */
  | 'sent_to_other_job_worker'
  /**
   * Supplied to a customer straight from the job worker's premises under section 143(1)(b). This
   * IS a supply by the principal and is invoiced; it discharges the clock the same way a physical
   * return does.
   */
  | 'supplied_from_job_worker_premises'
  /**
   * Waste and scrap generated during the process. Section 143(5) lets the job worker supply it
   * directly if registered, and the principal otherwise. It discharges the balance quantity — the
   * form asks for losses and wastes alongside the goods received back.
   */
  | 'waste_and_scrap'

/** A receipt back (or onward movement) against a challan. */
export interface JobWorkReturn {
  /** The challan the goods originally went out on. Joins to `JobWorkChallan.challanNumber`. */
  originalChallanNumber: string
  originalChallanDate: string
  /** The challan the goods came back / moved on under. Issued by the job worker. */
  receiptChallanNumber: string
  receiptChallanDate: string
  /** Integer thousandths returned under this document. */
  qtyMilli: number
  disposition: JobWorkDisposition
  /** Free text — the form asks for the nature of the job work done. */
  natureOfJobWork?: string | null
}

// ---------------------------------------------------------------------------------------------
// Integer arithmetic
// ---------------------------------------------------------------------------------------------

/**
 * `value * num / den`, exact, rounded half away from zero, in integers.
 *
 * BigInt rather than plain arithmetic because a crore-rupee challan (1e11 paise) multiplied by a
 * quantity in thousandths (1e6) is 1e17 — past 2^53, where JavaScript starts losing whole paise
 * without saying so.
 */
function mulDivRound(value: number, num: number, den: number): number {
  if (den === 0) return 0
  const sign = Math.sign(value) * Math.sign(num) * Math.sign(den) < 0 ? -1 : 1
  const v = BigInt(Math.abs(Math.trunc(value)))
  const n = BigInt(Math.abs(Math.trunc(num)))
  const d = BigInt(Math.abs(Math.trunc(den)))
  const q = (v * n * 2n + d) / (d * 2n) // half away from zero
  return sign * Number(q)
}

/** Tax at `ratePercent` on `paise`, integer, without a float touching the amount. */
function taxOn(paise: number, ratePercent: number): number {
  // Rates go to two decimals at most (0.25%), so basis points are an exact integer basis.
  const basisPoints = Math.round(ratePercent * 100)
  return mulDivRound(paise, basisPoints, 10_000)
}

/**
 * `date` plus whole years, as an ISO calendar date.
 *
 * Anniversary arithmetic, not 365 days: "within one year" is calendar language, and 365 days
 * would fall a day early in every leap year. 29 February clamps back to 28 February, which is the
 * conservative direction — the goods become overdue a day sooner, not a day later.
 */
export function addYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const targetYear = y + years
  const lastDay = new Date(Date.UTC(targetYear, m, 0)).getUTCDate()
  const day = Math.min(d, lastDay)
  return `${targetYear}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------------------------
// The section 143 clock
// ---------------------------------------------------------------------------------------------

/** Years the goods may stay out before the deemed supply bites. */
export const CLOCK_YEARS: Record<JobWorkGoodsType, number> = {
  /** Section 143(3). */
  input: 1,
  /** Section 143(4). */
  capital_goods: 3
}

export type Itc04IssueCode =
  /** A return names a challan that is not in the challan list. */
  | 'unknown-challan'
  /** More came back than went out. Reported, never netted into a negative balance. */
  | 'over-returned'
  /** A receipt dated before the goods left. */
  | 'return-before-challan'
  /** The unit is not a code the portal will accept. */
  | 'invalid-uqc'
  /** Challan quantity is zero or negative — nothing can be apportioned against it. */
  | 'invalid-quantity'

export interface Itc04Issue {
  code: Itc04IssueCode
  challanNumber: string
  message: string
}

export interface DeemedSupplyRow {
  challanNumber: string
  challanDate: string
  goodsType: JobWorkGoodsType
  jobWorkerGstin: string | null
  jobWorkerStateCode: string
  /** True when there is no GSTIN — the form reports the state instead. */
  unregisteredJobWorker: boolean
  description: string
  hsn: string
  uqc: string
  sentMilli: number
  /** Everything accounted for: returned, moved on, supplied from the premises, waste. */
  accountedMilli: number
  /** Never negative. An over-return raises an issue and leaves this at zero. */
  balanceMilli: number
  /** How much more came back than went out, if any. Zero in the normal case. */
  overReturnedMilli: number
  /** Where the clock starts — the challan date, or receipt by the job worker if sent direct. */
  clockStartsOn: string
  /** The last day the goods may come back. Null when no clock applies (moulds, dies, tools). */
  dueBackBy: string | null
  /** True when the due date came from a Commissioner's extension rather than the statute. */
  extended: boolean
  /** Section 143(4) excludes moulds and dies, jigs and fixtures, and tools. */
  exemptFromClock: boolean
  /** Balance still out AND past the due date, as at `asOn`. */
  overdue: boolean
  /** Days past the due date. Zero when not overdue. */
  daysOverdue: number
  /**
   * The date the supply is deemed to have happened: the day the goods were SENT OUT, not the day
   * the year ran out (section 143(3)/(4)). Null unless overdue. Interest under section 50(1) runs
   * from the tax due date for this date's return period.
   */
  deemedSupplyDate: string | null
  /** Pro-rata value of the unreturned balance, integer paise. Zero unless overdue. */
  deemedValuePaise: number
  gstRate: number
  /** Tax on the deemed supply, integer paise. Zero unless overdue. */
  deemedTaxPaise: number
  /**
   * CGST/SGST/IGST split, when the caller told us the principal's state code. Null otherwise —
   * guessing the split from the job worker's state alone is not possible.
   */
  breakup: GstBreakup | null
}

export interface DeemedSupplyReport {
  asOn: string
  /** One row per challan, in the order given. */
  rows: DeemedSupplyRow[]
  /** Just the rows where the clock has run out — what the user actually has to act on. */
  overdue: DeemedSupplyRow[]
  totalDeemedValuePaise: number
  totalDeemedTaxPaise: number
  issues: Itc04Issue[]
}

export interface DeemedSupplyOptions {
  /** The principal's own state code, so the deemed supply can be split intra/inter-state. */
  principalStateCode?: string
}

/**
 * The section 143 clock, challan by challan.
 *
 * Returns a report rather than a bare array because an over-return has to go somewhere: the
 * balance must not be allowed to go negative (a negative balance quietly cancels a real deemed
 * supply on the next challan of the same goods), so it is clamped at zero and the discrepancy is
 * reported as an issue the user has to resolve.
 */
export function deemedSupplies(
  challans: JobWorkChallan[],
  returns: JobWorkReturn[],
  asOn: string,
  opts: DeemedSupplyOptions = {}
): DeemedSupplyReport {
  const issues: Itc04Issue[] = []
  const byChallan = new Map<string, JobWorkChallan>()
  for (const c of challans) byChallan.set(c.challanNumber, c)

  const accounted = new Map<string, number>()
  for (const r of returns) {
    const challan = byChallan.get(r.originalChallanNumber)
    if (!challan) {
      issues.push({
        code: 'unknown-challan',
        challanNumber: r.originalChallanNumber,
        message: `Receipt ${r.receiptChallanNumber} refers to challan ${r.originalChallanNumber}, which is not in the period's challans.`
      })
      continue
    }
    if (r.receiptChallanDate < challan.challanDate) {
      issues.push({
        code: 'return-before-challan',
        challanNumber: challan.challanNumber,
        message: `Receipt ${r.receiptChallanNumber} is dated ${r.receiptChallanDate}, before the challan date ${challan.challanDate}.`
      })
    }
    accounted.set(r.originalChallanNumber, (accounted.get(r.originalChallanNumber) ?? 0) + r.qtyMilli)
  }

  const rows: DeemedSupplyRow[] = challans.map((c) => {
    if (c.qtyMilli <= 0) {
      issues.push({
        code: 'invalid-quantity',
        challanNumber: c.challanNumber,
        message: `Challan ${c.challanNumber} has quantity ${c.qtyMilli}; a challan must send a positive quantity.`
      })
    }
    if (!isUqc(c.uqc)) {
      issues.push({
        code: 'invalid-uqc',
        challanNumber: c.challanNumber,
        message: `Challan ${c.challanNumber} uses unit "${c.uqc}", which is not a portal UQC.`
      })
    }

    const accountedMilli = accounted.get(c.challanNumber) ?? 0
    const rawBalance = c.qtyMilli - accountedMilli
    const overReturnedMilli = rawBalance < 0 ? -rawBalance : 0
    if (overReturnedMilli > 0) {
      issues.push({
        code: 'over-returned',
        challanNumber: c.challanNumber,
        message: `Challan ${c.challanNumber} sent ${c.qtyMilli} but ${accountedMilli} has been accounted for — ${overReturnedMilli} more than went out.`
      })
    }
    const balanceMilli = Math.max(0, rawBalance)

    const exemptFromClock = c.goodsType === 'capital_goods' && c.mouldsDiesJigsOrTools === true
    const clockStartsOn = c.receivedByJobWorkerOn || c.challanDate
    const statutoryDue = addYears(clockStartsOn, CLOCK_YEARS[c.goodsType])
    const extended = !exemptFromClock && !!c.extendedDueBackBy
    const dueBackBy = exemptFromClock ? null : extended ? (c.extendedDueBackBy as string) : statutoryDue

    // The due date itself is still in time: goods sent on 10 Apr 2025 are "within one year" up to
    // and including 10 Apr 2026, and are late on the 11th.
    // // VERIFY (2026-08-25): the boundary-day convention is a reading of "within one year", not a
    // // departmental clarification. If CBIC treats the anniversary itself as late, the comparison
    // // below becomes `asOn >= dueBackBy` and every anniversary-dated return flips.
    const overdue = dueBackBy !== null && balanceMilli > 0 && asOn > dueBackBy
    const daysOverdue = overdue ? daysBetween(dueBackBy as string, asOn) : 0

    const deemedValuePaise = overdue ? mulDivRound(c.taxableValuePaise, balanceMilli, c.qtyMilli) : 0
    const deemedTaxPaise = overdue ? taxOn(deemedValuePaise, c.gstRate) : 0
    const breakup =
      overdue && opts.principalStateCode
        ? computeGst(
            deemedValuePaise,
            c.gstRate,
            supplyTypeFor(opts.principalStateCode, c.jobWorkerStateCode)
          )
        : null

    return {
      challanNumber: c.challanNumber,
      challanDate: c.challanDate,
      goodsType: c.goodsType,
      jobWorkerGstin: c.jobWorkerGstin,
      jobWorkerStateCode: c.jobWorkerStateCode,
      unregisteredJobWorker: !c.jobWorkerGstin,
      description: c.description,
      hsn: c.hsn,
      uqc: c.uqc,
      sentMilli: c.qtyMilli,
      accountedMilli,
      balanceMilli,
      overReturnedMilli,
      clockStartsOn,
      dueBackBy,
      extended,
      exemptFromClock,
      overdue,
      daysOverdue,
      // Section 143(3)/(4): deemed supplied "on the day when the said inputs were sent out" —
      // the challan date, even where the clock itself started later on receipt by the job worker.
      deemedSupplyDate: overdue ? c.challanDate : null,
      deemedValuePaise,
      gstRate: c.gstRate,
      deemedTaxPaise,
      breakup
    }
  })

  const overdueRows = rows.filter((r) => r.overdue)
  return {
    asOn,
    rows,
    overdue: overdueRows,
    totalDeemedValuePaise: overdueRows.reduce((s, r) => s + r.deemedValuePaise, 0),
    totalDeemedTaxPaise: overdueRows.reduce((s, r) => s + r.deemedTaxPaise, 0),
    issues
  }
}

// ---------------------------------------------------------------------------------------------
// Periodicity — dated data, not a constant
// ---------------------------------------------------------------------------------------------

export type Itc04Frequency = 'quarterly' | 'half-yearly' | 'annual'

/**
 * A periodicity regime, with the date it took effect.
 *
 * Shaped after `src/shared/statutory.ts`: the rule is data with an effective date, so a return
 * filed for FY 2019-20 still answers "quarterly" after the 2021 amendment, and re-opening an old
 * period does not silently restate it under today's law.
 */
export interface Itc04PeriodicityRule {
  /** ISO date this regime took effect. */
  effectiveFrom: string
  /** Frequency when no turnover test applies, or the frequency BELOW the threshold. */
  baseFrequency: Itc04Frequency
  /**
   * Preceding-FY aggregate turnover ABOVE which the principal files more often. Null when the
   * regime applies one frequency to everybody.
   */
  thresholdPaise: number | null
  /** Frequency above the threshold. Null when there is no threshold. */
  aboveThresholdFrequency: Itc04Frequency | null
  note: string
}

/**
 * Ascending by date. `itc04PeriodicityOn` picks the last entry that has taken effect, so a date
 * before the first entry gets the first entry rather than an error — the same choice
 * `statutory.ts` makes, for the same reason: someone importing old books wants an answer.
 */
export const ITC04_PERIODICITY_HISTORY: Itc04PeriodicityRule[] = [
  {
    effectiveFrom: '2017-07-01',
    baseFrequency: 'quarterly',
    thresholdPaise: null,
    aboveThresholdFrequency: null,
    note:
      'Rule 45(3) CGST Rules as originally notified: every principal files ITC-04 quarterly, by the 25th of the month after the quarter.'
  },
  {
    effectiveFrom: '2021-10-01',
    baseFrequency: 'annual',
    thresholdPaise: 5 * CRORE,
    aboveThresholdFrequency: 'half-yearly',
    note:
      'Rule 45(3) as substituted by Notification 35/2021-Central Tax dated 24 September 2021, w.e.f. 1 October 2021 and applicable from FY 2021-22: aggregate turnover above ₹5 crore in the preceding FY files half-yearly (Apr–Sep by 25 October, Oct–Mar by 25 April); ₹5 crore or below files annually by 25 April.'
  }
]

// // VERIFY (2026-08-25): notification number (35/2021-Central Tax, 24-09-2021) and its effective
// // date were recalled, not read from the gazette. The ₹5 crore threshold, the half-yearly/annual
// // split and the 25 October / 25 April due dates are confident; the citation is the weak part.
// // Confirm before the number is printed anywhere a user might rely on it.

/** The regime in force on `date`. */
export function itc04PeriodicityOn(
  date: string,
  history: Itc04PeriodicityRule[] = ITC04_PERIODICITY_HISTORY
): Itc04PeriodicityRule {
  let current = history[0] as Itc04PeriodicityRule
  for (const r of history) {
    if (r.effectiveFrom <= date) current = r
    else break
  }
  return current
}

export interface Itc04Obligation {
  frequency: Itc04Frequency
  /** The regime the answer came from, so a screen can show its `note` as the reason. */
  rule: Itc04PeriodicityRule
  /** The threshold applied, paise. Null under a regime that has none. */
  thresholdPaise: number | null
}

/**
 * How often this principal files, from its aggregate turnover in the IMMEDIATELY PRECEDING
 * financial year (rule 45(3) — not the current year's turnover, and not this company file's
 * turnover alone: "aggregate" spans every GSTIN on the PAN).
 *
 * The comparison is strict. The rule reads "exceeds five crore rupees" for half-yearly and "up to
 * five crore rupees" for annual, so a business at exactly ₹5,00,00,000 files annually.
 */
export function itc04Periodicity(
  aggregateTurnoverPaise: number,
  asOn: string = todayISO(),
  history: Itc04PeriodicityRule[] = ITC04_PERIODICITY_HISTORY
): Itc04Obligation {
  const rule = itc04PeriodicityOn(asOn, history)
  const frequency =
    rule.thresholdPaise !== null &&
    rule.aboveThresholdFrequency !== null &&
    aggregateTurnoverPaise > rule.thresholdPaise
      ? rule.aboveThresholdFrequency
      : rule.baseFrequency
  return { frequency, rule, thresholdPaise: rule.thresholdPaise }
}

export interface Itc04Period {
  from: string
  to: string
  /** Human label, e.g. 'Apr–Sep 2025' or 'FY 2025-26'. */
  label: string
  /** Statutory due date for filing this period, ISO. */
  dueDate: string
}

/**
 * The filing periods of a financial year at a given frequency, with their due dates.
 *
 * Half-yearly: Apr–Sep due 25 October, Oct–Mar due 25 April of the next year.
 * Annual: the whole FY, due 25 April of the next year.
 * Quarterly (pre-October-2021): due the 25th of the month after the quarter.
 */
export function itc04PeriodsForFy(fyStartYear: number, frequency: Itc04Frequency): Itc04Period[] {
  const fy = fyFromStartYear(fyStartYear)
  const y = fyStartYear
  if (frequency === 'annual') {
    return [{ from: fy.from, to: fy.to, label: `FY ${fy.label}`, dueDate: `${y + 1}-04-25` }]
  }
  if (frequency === 'half-yearly') {
    return [
      { from: `${y}-04-01`, to: `${y}-09-30`, label: `Apr–Sep ${y}`, dueDate: `${y}-10-25` },
      { from: `${y}-10-01`, to: `${y + 1}-03-31`, label: `Oct–Mar ${fy.label}`, dueDate: `${y + 1}-04-25` }
    ]
  }
  return [
    { from: `${y}-04-01`, to: `${y}-06-30`, label: `Q1 ${fy.label}`, dueDate: `${y}-07-25` },
    { from: `${y}-07-01`, to: `${y}-09-30`, label: `Q2 ${fy.label}`, dueDate: `${y}-10-25` },
    { from: `${y}-10-01`, to: `${y}-12-31`, label: `Q3 ${fy.label}`, dueDate: `${y + 1}-01-25` },
    { from: `${y + 1}-01-01`, to: `${y + 1}-03-31`, label: `Q4 ${fy.label}`, dueDate: `${y + 1}-04-25` }
  ]
}

// ---------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------

/**
 * Table 4 row — inputs/capital goods sent for job work in the period.
 *
 * // VERIFY (2026-08-25): the notified Table 4 also distinguishes a challan issued by the
 * // PRINCIPAL from one issued by a JOB WORKER (goods moving from one job worker to another are
 * // declared on the job worker's challan). This module models only the principal's challan, so
 * // that column is absent. Confirm against the current ITC-04 format before export.
 */
export interface Itc04SentRow {
  jobWorkerGstin: string | null
  jobWorkerStateCode: string
  /** The form takes the state in place of a GSTIN for an unregistered job worker. */
  unregisteredJobWorker: boolean
  challanNumber: string
  challanDate: string
  goodsType: JobWorkGoodsType
  description: string
  hsn: string
  uqc: string
  qtyMilli: number
  taxableValuePaise: number
  gstRate: number
  supply: SupplyType
  /**
   * Rate columns, expressed as amounts for convenience.
   *
   * Sending goods for job work is NOT a supply, so no tax is payable on a Table 4 row and none of
   * this is paid to anyone. The form asks for the rate; the amounts are here so a screen can show
   * what is at stake if the goods do not come back.
   */
  tax: GstBreakup
}

/** A row in 5A / 5B / 5C — goods coming back, moving on, or being supplied out. */
export interface Itc04ReceivedRow {
  originalChallanNumber: string
  originalChallanDate: string
  receiptChallanNumber: string
  receiptChallanDate: string
  jobWorkerGstin: string | null
  jobWorkerStateCode: string
  unregisteredJobWorker: boolean
  goodsType: JobWorkGoodsType
  description: string
  hsn: string
  uqc: string
  qtyMilli: number
  disposition: JobWorkDisposition
  natureOfJobWork: string | null
  /**
   * Pro-rata value of this quantity, integer paise.
   *
   * // VERIFY (2026-08-25): 5A and 5B in the notified form carry quantity but (as recalled) no
   * // taxable-value column; 5C does, because it is an actual outward supply. The value is
   * // computed on every row anyway as information for the screen — do not export it into a 5A/5B
   * // JSON payload without checking the current schema.
   */
  taxableValuePaise: number
  gstRate: number
}

export interface Itc04Totals {
  challanCount: number
  sentQtyMilli: number
  sentValuePaise: number
  receivedBackQtyMilli: number
  sentOnwardQtyMilli: number
  suppliedOutQtyMilli: number
  wasteQtyMilli: number
}

export interface Itc04 {
  period: Itc04Period
  /**
   * True when every table is empty. A nil ITC-04 is a real filing obligation, not an absence of
   * one — the form still has to go in — so this is a flag on a valid form, never a null return.
   */
  nil: boolean
  /** Table 4 — inputs and capital goods sent for job work. */
  table4: Itc04SentRow[]
  /**
   * Table 5A — received back from the job worker the goods were sent to, and losses and wastes.
   *
   * Waste and scrap is folded in here because the notified 5A heading covers "losses and wastes";
   * `disposition` on each row keeps the two distinguishable, and `totals.wasteQtyMilli` states the
   * waste separately.
   */
  table5A: Itc04ReceivedRow[]
  /**
   * Table 5B — the other-job-worker limb.
   *
   * // VERIFY (2026-08-25): the notified 5B heading, as recalled, is "received back from a job
   * // worker OTHER THAN the one the goods were originally sent to" — a receipt, whereas the
   * // `sent_to_other_job_worker` disposition routed here is a despatch. Both describe the same
   * // job-worker-to-job-worker movement seen from different ends, and there is a real chance the
   * // current form wants that movement declared in Table 4 on the job worker's challan instead.
   * // Confirm the heading and the intended limb before this table is filed or exported.
   */
  table5B: Itc04ReceivedRow[]
  /** Table 5C — supplied directly from the job worker's place of business (section 143(1)(b)). */
  table5C: Itc04ReceivedRow[]
  totals: Itc04Totals
  /**
   * The section 143 clock as at `opts.asOn` (default: the period end). Computed over ALL challans
   * passed in, not just the period's, because a challan from two years ago is exactly the one
   * whose year has run out.
   */
  deemed: DeemedSupplyReport
  issues: Itc04Issue[]
}

export interface Itc04Options {
  /** The principal's own state code, for the intra/inter split on Table 4. */
  principalStateCode: string
  /** Date the clock is read on. Defaults to the period end. */
  asOn?: string
}

const inPeriod = (date: string, p: Itc04Period): boolean => date >= p.from && date <= p.to

/**
 * Build one period's ITC-04 from the challans and receipts.
 *
 * Table 4 takes challans DATED IN THE PERIOD. Tables 5A/5B/5C take receipts dated in the period,
 * whatever period their original challan fell in — a challan raised in September and returned in
 * November appears in two different filings, which is the point of the two-sided form.
 */
export function buildItc04(
  period: Itc04Period,
  challans: JobWorkChallan[],
  returns: JobWorkReturn[],
  opts: Itc04Options
): Itc04 {
  const asOn = opts.asOn ?? period.to
  const deemed = deemedSupplies(challans, returns, asOn, {
    principalStateCode: opts.principalStateCode
  })

  const byChallan = new Map<string, JobWorkChallan>()
  for (const c of challans) byChallan.set(c.challanNumber, c)

  const table4: Itc04SentRow[] = challans
    .filter((c) => inPeriod(c.challanDate, period))
    .map((c) => {
      const supply = supplyTypeFor(opts.principalStateCode, c.jobWorkerStateCode)
      return {
        jobWorkerGstin: c.jobWorkerGstin,
        jobWorkerStateCode: c.jobWorkerStateCode,
        unregisteredJobWorker: !c.jobWorkerGstin,
        challanNumber: c.challanNumber,
        challanDate: c.challanDate,
        goodsType: c.goodsType,
        description: c.description,
        hsn: c.hsn,
        uqc: c.uqc,
        qtyMilli: c.qtyMilli,
        taxableValuePaise: c.taxableValuePaise,
        gstRate: c.gstRate,
        supply,
        tax: computeGst(c.taxableValuePaise, c.gstRate, supply)
      }
    })

  const table5A: Itc04ReceivedRow[] = []
  const table5B: Itc04ReceivedRow[] = []
  const table5C: Itc04ReceivedRow[] = []

  for (const r of returns) {
    if (!inPeriod(r.receiptChallanDate, period)) continue
    const c = byChallan.get(r.originalChallanNumber)
    // The unknown-challan issue is already raised by `deemedSupplies`; a row with no challan
    // behind it has no description, HSN or value to report, so it cannot go in a table.
    if (!c) continue
    const row: Itc04ReceivedRow = {
      originalChallanNumber: r.originalChallanNumber,
      originalChallanDate: r.originalChallanDate,
      receiptChallanNumber: r.receiptChallanNumber,
      receiptChallanDate: r.receiptChallanDate,
      jobWorkerGstin: c.jobWorkerGstin,
      jobWorkerStateCode: c.jobWorkerStateCode,
      unregisteredJobWorker: !c.jobWorkerGstin,
      goodsType: c.goodsType,
      description: c.description,
      hsn: c.hsn,
      uqc: c.uqc,
      qtyMilli: r.qtyMilli,
      disposition: r.disposition,
      natureOfJobWork: r.natureOfJobWork ?? null,
      taxableValuePaise:
        c.qtyMilli > 0 ? mulDivRound(c.taxableValuePaise, r.qtyMilli, c.qtyMilli) : 0,
      gstRate: c.gstRate
    }
    if (r.disposition === 'sent_to_other_job_worker') table5B.push(row)
    else if (r.disposition === 'supplied_from_job_worker_premises') table5C.push(row)
    else table5A.push(row) // 'returned' and 'waste_and_scrap' — 5A covers losses and wastes.
  }

  const sumQty = (rows: Itc04ReceivedRow[], pred: (r: Itc04ReceivedRow) => boolean): number =>
    rows.filter(pred).reduce((s, r) => s + r.qtyMilli, 0)

  const totals: Itc04Totals = {
    challanCount: table4.length,
    sentQtyMilli: table4.reduce((s, r) => s + r.qtyMilli, 0),
    sentValuePaise: table4.reduce((s, r) => s + r.taxableValuePaise, 0),
    receivedBackQtyMilli: sumQty(table5A, (r) => r.disposition === 'returned'),
    sentOnwardQtyMilli: table5B.reduce((s, r) => s + r.qtyMilli, 0),
    suppliedOutQtyMilli: table5C.reduce((s, r) => s + r.qtyMilli, 0),
    wasteQtyMilli: sumQty(table5A, (r) => r.disposition === 'waste_and_scrap')
  }

  return {
    period,
    nil:
      table4.length === 0 && table5A.length === 0 && table5B.length === 0 && table5C.length === 0,
    table4,
    table5A,
    table5B,
    table5C,
    totals,
    deemed,
    issues: deemed.issues
  }
}
