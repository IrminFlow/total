/**
 * Drawing power, from the monthly stock statement (roadmap #372, #373).
 *
 * A cash-credit borrower does not get to draw their sanctioned limit. They get to draw against
 * security they actually hold, month by month, and the bank recomputes it from a statement the
 * borrower files: stock on hand, book debts, and creditors. The arithmetic is the same at every
 * bank in the country and it is the only number the borrower cares about, yet it is almost always
 * filed late and computed by the branch rather than by the borrower.
 *
 * Two rules do all the work, and both are places a hand computation goes wrong:
 *
 *   1. Stock bought on credit is not the borrower's security. Creditors are deducted BEFORE the
 *      margin, not after — deducting after inflates drawing power by the margin on the creditors.
 *   2. Old debts are not security at all. Anything past the bank's cut-off (usually 90 days) is
 *      excluded outright rather than discounted, and including it is the single most common
 *      overstatement in a filed statement.
 */

export interface DrawingPowerMargins {
  /** Percent of paid stock the bank will not lend against. Typically 25. */
  stockMarginPercent: number
  /** Percent of eligible book debts the bank will not lend against. Typically 40. */
  debtorMarginPercent: number
  /** Debts older than this are not security. Typically 90 days. */
  debtorAgeLimitDays: number
  /** The sanctioned cash-credit limit, in paise. Drawing power is capped at it. */
  sanctionedLimitPaise: number
}

export const DEFAULT_MARGINS: DrawingPowerMargins = {
  stockMarginPercent: 25,
  debtorMarginPercent: 40,
  debtorAgeLimitDays: 90,
  sanctionedLimitPaise: 0
}

export interface StockStatementInput {
  /** Month end the statement is as at, ISO. */
  asOn: string
  /** Closing stock at cost, in paise, per the books. */
  stockPaise: number
  /** Book debts within the bank's age limit, in paise. */
  eligibleDebtorsPaise: number
  /** Book debts beyond the age limit — reported, then excluded. */
  ineligibleDebtorsPaise: number
  /** Sundry creditors, in paise. */
  creditorsPaise: number
  /** Cash-credit balance actually utilised on the date, in paise (a credit balance, positive). */
  utilisedPaise: number
}

export interface DrawingPowerResult {
  asOn: string
  stockPaise: number
  creditorsPaise: number
  /** Stock the borrower has actually paid for. Never negative — a business whose creditors exceed
   *  its stock has no paid stock, not negative security. */
  paidStockPaise: number
  stockMarginPaise: number
  dpOnStockPaise: number
  eligibleDebtorsPaise: number
  ineligibleDebtorsPaise: number
  debtorMarginPaise: number
  dpOnDebtorsPaise: number
  /** Before the sanctioned limit is applied. */
  grossDrawingPowerPaise: number
  sanctionedLimitPaise: number
  drawingPowerPaise: number
  /** True when security, not the sanction, is what is limiting the account. */
  cappedBySecurity: boolean
  utilisedPaise: number
  /** Drawing power less what is drawn. Negative means the account is overdrawn against security,
   *  which is what the bank calls and charges penal interest on. */
  headroomPaise: number
  excess: boolean
}

const pct = (paise: number, percent: number): number => Math.sign(paise) * Math.round((Math.abs(paise) * percent) / 100)

export function drawingPower(input: StockStatementInput, margins: DrawingPowerMargins): DrawingPowerResult {
  const paidStock = Math.max(0, input.stockPaise - input.creditorsPaise)
  const stockMargin = pct(paidStock, margins.stockMarginPercent)
  const dpOnStock = paidStock - stockMargin

  const debtorMargin = pct(input.eligibleDebtorsPaise, margins.debtorMarginPercent)
  const dpOnDebtors = input.eligibleDebtorsPaise - debtorMargin

  const gross = dpOnStock + dpOnDebtors
  const limit = margins.sanctionedLimitPaise
  // A zero sanction means nobody has entered one yet, so the security figure stands on its own
  // rather than being capped to nothing.
  const dp = limit > 0 ? Math.min(gross, limit) : gross
  const headroom = dp - input.utilisedPaise

  return {
    asOn: input.asOn,
    stockPaise: input.stockPaise,
    creditorsPaise: input.creditorsPaise,
    paidStockPaise: paidStock,
    stockMarginPaise: stockMargin,
    dpOnStockPaise: dpOnStock,
    eligibleDebtorsPaise: input.eligibleDebtorsPaise,
    ineligibleDebtorsPaise: input.ineligibleDebtorsPaise,
    debtorMarginPaise: debtorMargin,
    dpOnDebtorsPaise: dpOnDebtors,
    grossDrawingPowerPaise: gross,
    sanctionedLimitPaise: limit,
    drawingPowerPaise: dp,
    cappedBySecurity: limit > 0 && gross < limit,
    utilisedPaise: input.utilisedPaise,
    headroomPaise: headroom,
    excess: headroom < 0
  }
}

/** The statement as the bank's own form lays it out, ready to print. */
export function drawingPowerRows(r: DrawingPowerResult, margins: DrawingPowerMargins): {
  label: string
  value: number
  emphasis?: boolean
}[] {
  return [
    { label: 'Stock on hand (at cost)', value: r.stockPaise },
    { label: 'Less: sundry creditors', value: -r.creditorsPaise },
    { label: 'Paid stock', value: r.paidStockPaise, emphasis: true },
    { label: `Less: margin @ ${margins.stockMarginPercent}%`, value: -r.stockMarginPaise },
    { label: 'Drawing power on stock (A)', value: r.dpOnStockPaise, emphasis: true },
    { label: `Book debts up to ${margins.debtorAgeLimitDays} days`, value: r.eligibleDebtorsPaise },
    { label: `Less: margin @ ${margins.debtorMarginPercent}%`, value: -r.debtorMarginPaise },
    { label: 'Drawing power on book debts (B)', value: r.dpOnDebtorsPaise, emphasis: true },
    { label: 'Total drawing power (A + B)', value: r.grossDrawingPowerPaise, emphasis: true },
    { label: 'Sanctioned limit', value: r.sanctionedLimitPaise },
    { label: 'Drawing power available', value: r.drawingPowerPaise, emphasis: true },
    { label: 'Less: utilised', value: -r.utilisedPaise },
    { label: r.excess ? 'EXCESS over drawing power' : 'Headroom', value: r.headroomPaise, emphasis: true }
  ]
}
