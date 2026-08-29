/**
 * Late fee and interest on a GST return filed after its due date.
 *
 * The app showed due dates and then said nothing about missing one, which is the moment a filer
 * most wants a number: the choice between filing today and filing next week is a rupee amount,
 * and until you can see it the deadline is abstract.
 *
 * Two separate charges, often conflated:
 *
 *  - **Late fee** is per day of delay, per return, fixed by the form and by whether the return is
 *    nil. It accrues whether or not any tax was owed.
 *  - **Interest** is 18% per annum on the tax actually paid late, under section 50. A return with
 *    no tax liability carries no interest however late it is.
 *
 * Both are computed here rather than quoted from the portal, so the figure is an estimate and is
 * labelled as one — the portal is authoritative and applies caps and waivers this cannot know
 * about (amnesty schemes have repeatedly capped GSTR-3B fees retrospectively).
 */

/** Section 50(1). 18% per annum on tax paid late. */
export const INTEREST_RATE_PERCENT = 18

/** A year for interest purposes: 365 days, not 360. */
const DAYS_IN_YEAR = 365

export interface LateFeeRule {
  /** Per day of delay, in paise, when the return has any liability. */
  perDayPaise: number
  /** Per day of delay, in paise, when the return is nil. */
  perDayNilPaise: number
  /** Statutory ceiling on the late fee for one return, in paise. */
  capPaise: number
  /** Whether interest under section 50 can arise on this form at all. */
  interestApplies: boolean
}

const RUPEE = 100

/**
 * Per-form late fee rules.
 *
 * GSTR-1 and GSTR-3B are ₹50/day (₹25 CGST + ₹25 SGST) and ₹20/day nil, capped at ₹5,000 per
 * return under the general rule. CMP-08 has no late fee of its own -- it is a payment statement,
 * so only interest arises -- while GSTR-4 carries the ₹50/₹20 fee capped at ₹2,000. PMT-06 is a
 * challan, not a return: no fee, interest only. IFF is optional, so nothing at all.
 *
 * These have been amended repeatedly and turnover-linked caps exist above ₹5 crore; the figures
 * here are the general small-business case, which is who this app is for.
 */
export const LATE_FEE_RULES: Record<string, LateFeeRule> = {
  'GSTR-1': { perDayPaise: 50 * RUPEE, perDayNilPaise: 20 * RUPEE, capPaise: 5000 * RUPEE, interestApplies: false },
  'GSTR-3B': { perDayPaise: 50 * RUPEE, perDayNilPaise: 20 * RUPEE, capPaise: 5000 * RUPEE, interestApplies: true },
  'GSTR-4': { perDayPaise: 50 * RUPEE, perDayNilPaise: 20 * RUPEE, capPaise: 2000 * RUPEE, interestApplies: true },
  'CMP-08': { perDayPaise: 0, perDayNilPaise: 0, capPaise: 0, interestApplies: true },
  'PMT-06': { perDayPaise: 0, perDayNilPaise: 0, capPaise: 0, interestApplies: true },
  IFF: { perDayPaise: 0, perDayNilPaise: 0, capPaise: 0, interestApplies: false }
}

export interface LateChargeInput {
  form: string
  /** ISO date the return was due. */
  dueDate: string
  /** ISO date it was (or will be) filed. */
  filedDate: string
  /** Tax paid with the return, in paise. Zero makes the return nil for fee purposes. */
  taxPaise: number
}

export interface LateCharge {
  /** Days late; 0 when filed on or before the due date. */
  daysLate: number
  lateFeePaise: number
  interestPaise: number
  totalPaise: number
  /** True when the fee hit its statutory ceiling, which changes the advice: past the cap, another
   *  week of delay costs only interest. */
  feeCapped: boolean
}

/** Whole days from `from` to `to`; negative if `to` precedes `from`. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)
}

/**
 * Late fee and interest for one return.
 *
 * An unknown form is charged nothing rather than guessed at: inventing a fee for a form whose
 * rule we do not have would be a number the filer might act on.
 */
export function lateCharge(input: LateChargeInput): LateCharge {
  const daysLate = Math.max(0, daysBetween(input.dueDate, input.filedDate))
  const rule = LATE_FEE_RULES[input.form]
  if (daysLate === 0 || !rule) {
    return { daysLate, lateFeePaise: 0, interestPaise: 0, totalPaise: 0, feeCapped: false }
  }

  const perDay = input.taxPaise > 0 ? rule.perDayPaise : rule.perDayNilPaise
  const uncapped = perDay * daysLate
  const lateFeePaise = rule.capPaise > 0 ? Math.min(uncapped, rule.capPaise) : uncapped

  // Integer paise throughout: (tax × 18 × days) / (100 × 365), floored. Multiplying before
  // dividing keeps the whole computation in integers, so no float ever touches an amount.
  const interestPaise =
    rule.interestApplies && input.taxPaise > 0
      ? Math.floor((input.taxPaise * INTEREST_RATE_PERCENT * daysLate) / (100 * DAYS_IN_YEAR))
      : 0

  return {
    daysLate,
    lateFeePaise,
    interestPaise,
    totalPaise: lateFeePaise + interestPaise,
    feeCapped: rule.capPaise > 0 && uncapped >= rule.capPaise
  }
}
