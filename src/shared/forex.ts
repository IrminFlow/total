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
  /** Signed paise of the foreign-currency lines only (dr-positive) — their book value in rupees. */
  inrBook: number
  /** inrBook / fcBalance in micro-rupees, null when nothing is open. */
  carryingRateMicro: number | null
  /** Rupee lines on the ledger that carry no foreign amount. They are NOT foreign money and are
   *  left out of both the foreign balance and its book value (so they are never revalued). */
  rupeeLines: number
}

/**
 * Fold an exposure ledger's lines into its foreign balance and that balance's rupee book value:
 * - the foreign opening (fx_ledger_currency.opening_fc against the ledger's rupee opening), if any;
 * - a line on a voucher in `currency` carries fc = its override (a recorded settlement), else
 *   amount ÷ the voucher rate; its rupees count in the book value;
 * - a revaluation / reversal line moves the book value only;
 * - any other line is rupee money: excluded from both figures and counted in `rupeeLines`.
 */
export function foldExposure(lines: readonly FxLine[], currency: string, opening: { fc: number; inr: number } | null = null): Exposure {
  let fc = opening?.fc ?? 0
  let inr = opening?.inr ?? 0
  let rupee = 0
  for (const l of lines) {
    if (l.revaluation) {
      inr += l.amount
    } else if (l.fcOverride != null) {
      fc += l.fcOverride
      inr += l.amount
    } else if (l.currency === currency && l.rateMicro && l.rateMicro > 0) {
      fc += fcFromInr(l.amount, l.rateMicro)
      inr += l.amount
    } else {
      rupee++
    }
  }
  return { fcBalance: fc, inrBook: inr, carryingRateMicro: fc !== 0 ? Math.abs(mulDivRound(inr, 1_000_000, fc)) : null, rupeeLines: rupee }
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

// ---------- bill-wise settlement ----------

/** One foreign bill (invoice / bill / the opening) still open, in positive magnitudes. */
export interface ForeignBill {
  name: string
  /** The invoice voucher (null = the ledger's foreign opening). */
  voucherId: number | null
  date: string
  /** Foreign amount still open (fc minor). */
  fcOpen: number
  /** Its rupee book value at the bill's own rate. */
  bookOpen: number
}

export interface ForeignEntry { name: string; voucherId: number | null; date: string; fc: number; inr: number }

/**
 * Open foreign bills: `bills` (positive, in date order) less `reductions` (foreign-currency credit
 * notes / returns — FIFO, at each bill's own rate) less earlier settlements by bill name.
 */
export function openForeignBills(
  bills: readonly ForeignEntry[],
  reductions: readonly { fc: number }[],
  settled: readonly { name: string; fc: number; bookInr: number }[]
): ForeignBill[] {
  const open: ForeignBill[] = bills.map((b) => ({ name: b.name, voucherId: b.voucherId, date: b.date, fcOpen: b.fc, bookOpen: b.inr }))
  const take = (b: ForeignBill, fc: number, book?: number): void => {
    const inr = book ?? (fc === b.fcOpen ? b.bookOpen : mulDivRound(b.bookOpen, fc, b.fcOpen))
    b.fcOpen -= fc
    b.bookOpen -= inr
  }
  for (const s of settled) {
    const b = open.find((x) => x.name === s.name && x.fcOpen > 0)
    if (b) take(b, Math.min(s.fc, b.fcOpen), s.fc >= b.fcOpen ? b.bookOpen : s.bookInr)
  }
  for (const r of reductions) {
    let rest = r.fc
    for (const b of open) {
      if (rest <= 0) break
      if (b.fcOpen <= 0) continue
      const t = Math.min(rest, b.fcOpen)
      take(b, t)
      rest -= t
    }
  }
  return open.filter((b) => b.fcOpen > 0)
}

/** Spread `fcAmount` over the open bills oldest first. */
export function allocateFifo(bills: readonly ForeignBill[], fcAmount: number): { name: string; fc: number }[] {
  const out: { name: string; fc: number }[] = []
  let rest = fcAmount
  for (const b of bills) {
    if (rest <= 0) break
    const t = Math.min(rest, b.fcOpen)
    out.push({ name: b.name, fc: t })
    rest -= t
  }
  if (rest > 0) throw new Error('More than the open foreign balance')
  return out
}

export interface SettlementLine { name: string; voucherId: number | null; fc: number; bookInr: number }

export interface SettlementSplit {
  lines: SettlementLine[]
  fcTotal: number
  /** Rupees moved through the bank (positive). */
  bankInr: number
  /** Book value of the bills relieved, each at its own rate (positive). */
  partyInr: number
  /** + realised gain, − realised loss. */
  gainLoss: number
}

/**
 * Realised exchange difference (AS 11 para 13 / Ind AS 21 para 28), bill by bill: each bill is
 * relieved at its OWN book rate (all of its book value when settled in full), the bank moves the
 * total foreign amount × the settlement rate. Receivable: more rupees in than carried = gain.
 * Payable: fewer rupees out = gain.
 */
export function settleBills(
  bills: readonly ForeignBill[],
  allocations: readonly { name: string; fc: number }[],
  settleRateMicro: number,
  side: 'receivable' | 'payable'
): SettlementSplit {
  if (allocations.length === 0) throw new Error('Pick at least one bill')
  const lines: SettlementLine[] = allocations.map((a) => {
    const b = bills.find((x) => x.name === a.name)
    if (!b) throw new Error(`Bill ${a.name} is not open`)
    if (!(a.fc > 0)) throw new Error(`Enter a positive amount for ${a.name}`)
    if (a.fc > b.fcOpen) throw new Error(`More than is open on ${a.name}`)
    return { name: b.name, voucherId: b.voucherId, fc: a.fc, bookInr: a.fc === b.fcOpen ? b.bookOpen : mulDivRound(b.bookOpen, a.fc, b.fcOpen) }
  })
  const fcTotal = lines.reduce((s, l) => s + l.fc, 0)
  const partyInr = lines.reduce((s, l) => s + l.bookInr, 0)
  const bankInr = inrFromFc(fcTotal, settleRateMicro)
  return { lines, fcTotal, bankInr, partyInr, gainLoss: side === 'receivable' ? bankInr - partyInr : partyInr - bankInr }
}

/** Format fc minor with two decimals and the code: 1234567 → "12,345.67 USD". */
export function formatFc(fcMinor: number, code: string): string {
  const neg = fcMinor < 0
  const abs = Math.abs(fcMinor)
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  return `${neg ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')} ${code}`
}
