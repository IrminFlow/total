/**
 * Foreign-currency exposure and revaluation arithmetic (WP 4.4) — pure, no DB.
 *
 * Basis:
 * - AS 11 (revised 2003), The Effects of Changes in Foreign Exchange Rates, para 11(a): "foreign
 *   currency monetary items should be reported using the closing rate" at each balance sheet
 *   date; para 13: exchange differences arising on the settlement of monetary items, or on
 *   reporting them at rates different from those at which they were initially recorded, "should
 *   be recognised as income or as expenses in the period in which they arise" (para 46/46A
 *   options for long-term items are not modelled).
 * - Ind AS 21, para 23(a): "foreign currency monetary items shall be translated using the closing
 *   rate"; para 28: exchange differences on settling or translating monetary items are
 *   recognised in profit or loss in the period in which they arise.
 *   UNVERIFIED: paragraph numbers and quotations are from the standards as recalled — check them
 *   against the ICAI / MCA published text before relying on the citation.
 * Receivables, payables and foreign-currency bank balances are monetary items; the revaluation
 * journal restates them at the user-entered closing rate. Reversing it on the next day (Tally's
 * "adjustment" practice) keeps the original book rate on the party ledger for settlement, so the
 * realised difference is recognised when the bill is actually settled.
 *
 * Units: INR in paise (integer), foreign amounts in hundredths of the currency ("fc minor",
 * integer — the cent/penny for USD/GBP/EUR), rates as integer micro-rupees per unit
 * (₹83.25 / USD = 83 250 000). fc minor × rate micro / 10⁶ = paise.
 */
import { mulDivRound } from './loanSchedule'

/** ₹ per unit as a decimal (voucher.exchange_rate, user input) → integer micro-rupees. */
export function rateToMicro(rate: number): number {
  return Math.round(rate * 1_000_000)
}

/** Integer micro-rupees → a display string with up to 6 decimals ("83.25"). */
export function microToRateText(micro: number): string {
  const s = (micro / 1_000_000).toFixed(6)
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

/** Parse "83.25" into micro-rupees (exact decimal parse, no float rounding); null if invalid. */
export function parseRateMicro(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  const v = Number(whole) * 1_000_000 + Number((frac + '000000').slice(0, 6))
  return v > 0 ? v : null
}

/** paise → fc minor at a rate (round half away from zero). */
export function fcFromInr(paise: number, rateMicro: number): number {
  return mulDivRound(paise, 1_000_000, rateMicro)
}

/** fc minor → paise at a rate (round half away from zero). */
export function inrFromFc(fcMinor: number, rateMicro: number): number {
  return mulDivRound(fcMinor, rateMicro, 1_000_000)
}

/** One voucher line on an exposure ledger, in chronological order. */
export interface FxLine {
  date: string
  voucherId: number
  /** Signed paise, dr-positive. */
  amount: number
  /** The voucher's currency (null / 'INR' = a rupee voucher). */
  currency: string | null
  /** The voucher's rate in micro-rupees (null for a rupee voucher). */
  rateMicro: number | null
  /** Explicit foreign amount for this line (signed fc minor) — a recorded settlement's party line. */
  fcOverride: number | null
  /** A revaluation (or its reversal) journal: moves rupees only, never the foreign balance. */
  revaluation: boolean
}

export interface Exposure {
  /** Signed fc minor (dr-positive): + is owed to us / held, − is owed by us. */
  fcBalance: number
  /** Signed paise of the exposure lines (dr-positive) — the book value in rupees. */
  inrBook: number
  /** inrBook / fcBalance in micro-rupees, null when nothing is open. */
  carryingRateMicro: number | null
  /** Rupee lines without a foreign amount that were converted at the carrying rate (no realised
   *  difference recognised for them — record settlements through Forex → Settle instead). */
  inferredLines: number
}

/**
 * Fold an exposure ledger's lines into its foreign and rupee balances for `currency`:
 * - a line on a voucher in `currency` carries fc = its override, else amount ÷ the voucher rate;
 * - a revaluation line moves rupees only;
 * - any other line (a rupee receipt or payment against the foreign balance) is converted at the
 *   carrying rate just before it — it settles foreign units at book value, so no gain or loss is
 *   inferred for it.
 */
export function foldExposure(lines: readonly FxLine[], currency: string): Exposure {
  let fc = 0
  let inr = 0
  let inferred = 0
  for (const l of lines) {
    if (l.revaluation) {
      inr += l.amount
      continue
    }
    if (l.fcOverride != null) {
      fc += l.fcOverride
    } else if (l.currency === currency && l.rateMicro && l.rateMicro > 0) {
      fc += fcFromInr(l.amount, l.rateMicro)
    } else if (fc !== 0 && inr !== 0) {
      fc += mulDivRound(l.amount, fc, inr)
      inferred++
    } else {
      inferred++
    }
    inr += l.amount
  }
  return { fcBalance: fc, inrBook: inr, carryingRateMicro: fc !== 0 ? Math.abs(mulDivRound(inr, 1_000_000, fc)) : null, inferredLines: inferred }
}

export interface RevaluationLine {
  /** Restated rupee value of the foreign balance at the closing rate (signed paise). */
  target: number
  /** target − inrBook: + debits the ledger (an asset grows / a liability shrinks), − credits it. */
  adjustment: number
  /** + is a gain, − a loss (equal to `adjustment`: a debit to a monetary item is a gain). */
  gainLoss: number
}

/** Restate one exposure at `closingRateMicro`. */
export function revalue(fcBalance: number, inrBook: number, closingRateMicro: number): RevaluationLine {
  const target = inrFromFc(fcBalance, closingRateMicro)
  const adjustment = target - inrBook
  return { target, adjustment, gainLoss: adjustment }
}

export interface SettlementSplit {
  /** Rupees moved through the bank (positive). */
  bankInr: number
  /** Rupees taken off the party ledger: the carrying value of the units settled (positive). */
  partyInr: number
  /** + realised gain, − realised loss. */
  gainLoss: number
}

/**
 * Realised exchange difference on settling `fcAmount` (positive fc minor) of an exposure at
 * `settleRateMicro`. The party ledger is relieved at its carrying value pro rata (all of inrBook
 * when the whole balance is settled, so nothing is left behind); the bank moves fc × settle rate.
 * Receivable: received more rupees than carried = gain. Payable: paid fewer = gain.
 */
export function settlementSplit(exposure: Pick<Exposure, 'fcBalance' | 'inrBook'>, fcAmount: number, settleRateMicro: number): SettlementSplit {
  const open = Math.abs(exposure.fcBalance)
  if (fcAmount <= 0) throw new Error('Settle a positive foreign amount')
  if (open === 0) throw new Error('Nothing is open in this currency')
  if (fcAmount > open) throw new Error('More than the open foreign balance')
  const carried = Math.abs(exposure.inrBook)
  const partyInr = fcAmount === open ? carried : mulDivRound(carried, fcAmount, open)
  const bankInr = inrFromFc(fcAmount, settleRateMicro)
  const receivable = exposure.fcBalance > 0
  return { bankInr, partyInr, gainLoss: receivable ? bankInr - partyInr : partyInr - bankInr }
}

/** Format fc minor with two decimals and the code: 1234567 → "12,345.67 USD". */
export function formatFc(fcMinor: number, code: string): string {
  const neg = fcMinor < 0
  const abs = Math.abs(fcMinor)
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  return `${neg ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')} ${code}`
}
