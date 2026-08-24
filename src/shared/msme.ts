/**
 * Section 43B(h): what a late payment to a small supplier costs.
 *
 * Since FY 2023-24, a sum payable to a **micro or small** enterprise that is still unpaid beyond
 * the time limit in section 15 of the MSMED Act is not deductible in that year at all — it is
 * allowed only in the year it is actually paid. On a business with thin margins, a few unpaid
 * supplier bills at 31 March can move the tax bill by more than the bills are worth.
 *
 * Two things make this hard to do by hand and easy to do here: the limit is not a flat 45 days,
 * and medium enterprises are not covered. Both are the sort of detail a spreadsheet gets wrong
 * in the taxpayer's favour, which is the expensive direction.
 *
 * Nothing in this file is tax advice and nothing posts. It reports what the books say, with the
 * arithmetic visible, for a person to take to their accountant.
 */

/** Only micro and small are within section 43B(h). Medium enterprises are outside it. */
export type MsmeStatus = 'micro' | 'small' | 'medium' | 'not_registered'

export const MSME_STATUSES: MsmeStatus[] = ['micro', 'small', 'medium', 'not_registered']

export const MSME_STATUS_LABELS: Record<MsmeStatus, string> = {
  micro: 'Micro',
  small: 'Small',
  medium: 'Medium',
  not_registered: 'Not registered'
}

/** Whether a supplier's status brings section 43B(h) into play at all. */
export function coveredBy43B(status: MsmeStatus | null): boolean {
  return status === 'micro' || status === 'small'
}

/**
 * Section 15 limits.
 *
 * With a written agreement, the agreed period applies but can never exceed 45 days. With no
 * agreement, the limit is 15 days from acceptance of the goods or services.
 */
export const MSME_LIMIT_WITH_AGREEMENT = 45
export const MSME_LIMIT_NO_AGREEMENT = 15

/**
 * Days allowed before a bill becomes a 43B(h) problem.
 *
 * `creditDays` is the agreed period from the party master. Where none is recorded there is no
 * agreement to rely on, so the 15-day default applies — the conservative reading, and the one an
 * assessing officer will take.
 */
export function allowedDays(creditDays: number | null): number {
  if (creditDays === null || creditDays <= 0) return MSME_LIMIT_NO_AGREEMENT
  return Math.min(creditDays, MSME_LIMIT_WITH_AGREEMENT)
}

/** The date a bill must be paid by to stay deductible. */
export function msmeDueDate(billDate: string, creditDays: number | null): string {
  const dt = new Date(`${billDate}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + allowedDays(creditDays))
  return dt.toISOString().slice(0, 10)
}

/** "45 days (agreed)" / "15 days (no agreement on record)" — the sentence that explains a due date. */
export function describeLimit(creditDays: number | null): string {
  const days = allowedDays(creditDays)
  if (creditDays === null || creditDays <= 0) return `${days} days (no agreement on record)`
  if (creditDays > MSME_LIMIT_WITH_AGREEMENT) {
    return `${days} days (agreed ${creditDays}, capped by section 15)`
  }
  return `${days} days (agreed)`
}

// ---------- interest under section 16 of the MSMED Act ----------

/**
 * Compound interest with monthly rests at three times the RBI bank rate.
 *
 * The bank rate is a parameter rather than a constant: it moves, and a number baked in here would
 * be quietly wrong within a year. It is also not deductible when paid, which is worth stating
 * where the figure is shown.
 */
export const MSME_INTEREST_MULTIPLE = 3

export function msmeInterest(principalPaise: number, bankRatePercent: number, days: number): number {
  if (principalPaise <= 0 || bankRatePercent <= 0 || days <= 0) return 0
  const annualRate = (bankRatePercent * MSME_INTEREST_MULTIPLE) / 100
  const months = days / 30
  // Monthly rests, so compound rather than simple. Floored: never charge a paisa that cannot be
  // justified from the formula.
  const amount = principalPaise * Math.pow(1 + annualRate / 12, months)
  return Math.max(0, Math.floor(amount - principalPaise))
}

// ---------- the report ----------

export interface MsmeBill {
  number: string
  date: string
  pending: number
  /** Agreed credit period from the party master, days. */
  creditDays: number | null
}

export interface MsmeBillLine extends MsmeBill {
  dueDate: string
  limitLabel: string
  /** Days past the section 15 limit as at the reporting date; 0 when still within it. */
  overdueDays: number
  /** True when this bill's amount is disallowed under 43B(h) as at the reporting date. */
  disallowed: boolean
  interest: number
}

export interface MsmeParty {
  ledgerId: number
  name: string
  status: MsmeStatus
  udyamNumber: string | null
  pending: number
  /** Amount past the section 15 limit — the 43B(h) exposure. */
  disallowed: number
  interest: number
  bills: MsmeBillLine[]
}

export interface MsmeReport {
  asOn: string
  bankRatePercent: number
  parties: MsmeParty[]
  /** Total disallowed under 43B(h) as at `asOn`. */
  totalDisallowed: number
  totalPending: number
  totalInterest: number
  /**
   * Suppliers whose MSME status has never been recorded but who are owed money.
   *
   * The single most useful number on the report at first run: an unclassified supplier is not a
   * supplier outside 43B(h), it is one nobody has asked about yet.
   */
  unclassifiedParties: number
  unclassifiedPending: number
}

export interface MsmePartyInput {
  ledgerId: number
  name: string
  status: MsmeStatus | null
  udyamNumber: string | null
  creditDays: number | null
  bills: MsmeBill[]
}

/**
 * What is at risk under 43B(h) as at a date.
 *
 * The date matters: this is normally run as at 31 March, because that is when the disallowance
 * bites, but running it in January is the only way to still do something about it.
 */
export function msmeReport(
  parties: MsmePartyInput[],
  asOn: string,
  bankRatePercent: number
): MsmeReport {
  const daysBetween = (from: string, to: string): number =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

  const covered: MsmeParty[] = []
  let unclassifiedParties = 0
  let unclassifiedPending = 0

  for (const p of parties) {
    const pending = p.bills.reduce((s, b) => s + b.pending, 0)
    if (pending <= 0) continue

    if (p.status === null) {
      unclassifiedParties += 1
      unclassifiedPending += pending
      continue
    }
    if (!coveredBy43B(p.status)) continue

    const bills: MsmeBillLine[] = p.bills.map((b) => {
      const creditDays = b.creditDays ?? p.creditDays
      const dueDate = msmeDueDate(b.date, creditDays)
      const overdueDays = Math.max(0, daysBetween(dueDate, asOn))
      return {
        ...b,
        dueDate,
        limitLabel: describeLimit(creditDays),
        overdueDays,
        disallowed: overdueDays > 0,
        interest: msmeInterest(b.pending, bankRatePercent, overdueDays)
      }
    })

    covered.push({
      ledgerId: p.ledgerId,
      name: p.name,
      status: p.status,
      udyamNumber: p.udyamNumber,
      pending,
      disallowed: bills.filter((b) => b.disallowed).reduce((s, b) => s + b.pending, 0),
      interest: bills.reduce((s, b) => s + b.interest, 0),
      bills: bills.sort((a, b) => b.overdueDays - a.overdueDays || b.pending - a.pending)
    })
  }

  covered.sort((a, b) => b.disallowed - a.disallowed || b.pending - a.pending)

  return {
    asOn,
    bankRatePercent,
    parties: covered,
    totalDisallowed: covered.reduce((s, p) => s + p.disallowed, 0),
    totalPending: covered.reduce((s, p) => s + p.pending, 0),
    totalInterest: covered.reduce((s, p) => s + p.interest, 0),
    unclassifiedParties,
    unclassifiedPending
  }
}
