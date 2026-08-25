/**
 * Foreign currency: the rate, the two amounts, and the difference between them (roadmap F #140).
 *
 * Three decisions are encoded here, and every one of them is about a number staying answerable
 * years later.
 *
 * **A rate is not money, so it is not paise.** ₹83.4525 to the dollar has four decimals, and a
 * quoted rate can have six. Storing it in paise would round the rate before it was ever used and
 * every amount computed from it would inherit the error. It is stored as `rateMicro`: integer
 * millionths of a rupee per ONE major unit of the foreign currency. 83.4525 → 83_452_500.
 *
 * **The foreign amount is stored, not derived.** A voucher for USD 1,200.00 is a voucher for
 * USD 1,200.00 forever. Deriving it back out of the rupee figure and today's rate would make the
 * invoice say a different dollar amount every time it was reprinted — and the dollar amount is
 * the one the customer agreed to. `fcMinor` is an integer in the foreign currency's own minor
 * unit (cents), because a foreign currency is no more a float than the rupee is.
 *
 * **The rate used is recorded on the entry that used it, never looked up again.** A revaluation
 * posted at the March closing rate has to keep saying March's rate in June, when the rate table
 * says something else. Everything in this module takes the rate as an argument; nothing in it
 * knows where rates are kept.
 *
 * Conversion, exactly: with `d` decimals in the foreign currency,
 *
 *     paise = fcMinor × rateMicro ÷ 10^(d + 4)
 *
 * — because fcMinor/10^d is the major amount, ×rateMicro/10^6 is rupees, ×100 is paise. Done in
 * BigInt: fcMinor × rateMicro passes 2^53 at around USD 100,000, which is not a large invoice.
 */

/** Signed integer division rounded half away from zero, in BigInt. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const q = (2n * n + d) / (2n * d)
  return negative ? -q : q
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n)
}

/** Millionths of a rupee per one major unit of the foreign currency. ₹83.4525/USD = 83_452_500. */
export type RateMicro = number

/** How many micro-units one whole rupee-per-unit is. Exported so callers never write the zeroes. */
export const RATE_SCALE = 1_000_000

/** Rupee amount (integer paise) of `fcMinor` minor units at `rateMicro`. Signed; sign follows the
 *  foreign amount, so a credit balance stays a credit balance. */
export function inrPaiseFor(fcMinor: number, rateMicro: RateMicro, decimals: number): number {
  if (!Number.isInteger(fcMinor) || !Number.isInteger(rateMicro)) {
    throw new Error('fx: amounts and rates are integers')
  }
  if (decimals < 0 || decimals > 6) throw new Error('fx: currency decimals out of range')
  return Number(divRound(BigInt(fcMinor) * BigInt(rateMicro), pow10(decimals + 4)))
}

/**
 * The foreign amount that `paise` represents at `rateMicro` — used to show what a rupee figure
 * is worth in the account's own currency, never to store a foreign amount that was typed.
 */
export function fcMinorFor(paise: number, rateMicro: RateMicro, decimals: number): number {
  if (rateMicro === 0) throw new Error('fx: a rate of zero converts nothing')
  return Number(divRound(BigInt(paise) * pow10(decimals + 4), BigInt(rateMicro)))
}

/**
 * Parse a typed rate into micro-units. Accepts '83.4525', '83', '1,234.5' and a bare '.5'.
 * Refuses more than six decimals rather than rounding one away silently: a seventh decimal in a
 * quoted rate means the user is pasting from somewhere this app cannot represent exactly, and
 * they should know that before it is stored.
 */
export function parseRate(input: string): RateMicro | null {
  const cleaned = input.trim().replace(/,/g, '')
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') return null
  const [whole, frac = ''] = cleaned.split('.')
  if (frac.length > 6) return null
  const micro = Number(`${whole || '0'}${frac.padEnd(6, '0')}`)
  if (!Number.isSafeInteger(micro) || micro <= 0) return null
  return micro
}

/** A rate for reading: trailing zeroes trimmed, but never below `minDecimals`. */
export function formatRate(rateMicro: RateMicro, minDecimals = 4): string {
  const negative = rateMicro < 0
  const abs = Math.abs(rateMicro)
  const whole = Math.trunc(abs / RATE_SCALE)
  let frac = String(abs % RATE_SCALE).padStart(6, '0')
  while (frac.length > minDecimals && frac.endsWith('0')) frac = frac.slice(0, -1)
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** A foreign amount for reading: 120000 minor units with 2 decimals is '1,200.00'. Grouped in
 *  threes, western style — a US dollar figure is not lakhs. */
export function formatFc(fcMinor: number, decimals: number, code?: string): string {
  const negative = fcMinor < 0
  const abs = Math.abs(fcMinor)
  const scale = 10 ** decimals
  const whole = Math.trunc(abs / scale).toLocaleString('en-US')
  const frac = decimals > 0 ? `.${String(abs % scale).padStart(decimals, '0')}` : ''
  return `${negative ? '-' : ''}${code ? `${code} ` : ''}${whole}${frac}`
}

export interface RevaluationInput {
  /** Closing balance in the foreign currency's minor units, signed dr-positive. */
  fcMinor: number
  /** What the books say the same balance is worth, integer paise, signed dr-positive. */
  bookPaise: number
  /** The closing rate for the period end being revalued. */
  closingRateMicro: RateMicro
  decimals: number
}

export interface Revaluation {
  /** The balance restated at the closing rate, signed dr-positive. */
  restatedPaise: number
  /** restated − book. Positive means the ledger must be debited. */
  differencePaise: number
  /** Which side the FOREIGN-CURRENCY LEDGER takes; the gain/loss account takes the other. */
  ledgerSide: 'dr' | 'cr'
  /** Gain, loss, or nothing at all — the answer the screen prints. */
  effect: 'gain' | 'loss' | 'none'
  /** Nothing to post. A revaluation that posts a zero-value journal is noise in the day book. */
  isNil: boolean
}

/**
 * Restate a monetary balance at the closing rate (AS 11 / Ind AS 21 paragraph 23(a): monetary
 * items are reported using the closing rate, and the difference goes to the statement of profit
 * and loss in the period it arises).
 *
 * Signed dr-positive throughout, which is what makes one function correct for both sides of the
 * balance sheet. An asset that is worth more rupees than the books say is a debit to the asset
 * and a credit to exchange gain; a liability that costs more rupees is a credit to the liability
 * and a debit to exchange loss — and both fall out of `restated − book` without a special case.
 *
 * The difference is NOT reversed at the start of the next period. Under AS 11 the restated figure
 * is the new carrying amount of the item; reversing it would put the balance back at a rate that
 * stopped being true at the period end, and the next revaluation would then report the whole
 * movement again as if it had happened twice.
 */
export function revalue(input: RevaluationInput): Revaluation {
  const restatedPaise = inrPaiseFor(input.fcMinor, input.closingRateMicro, input.decimals)
  const differencePaise = restatedPaise - input.bookPaise
  return {
    restatedPaise,
    differencePaise,
    ledgerSide: differencePaise >= 0 ? 'dr' : 'cr',
    effect: revaluationEffect(differencePaise),
    isNil: differencePaise === 0
  }
}

/**
 * Gain or loss, from the sign alone — and it really is the sign alone, on both sides of the
 * balance sheet, which is the payoff for keeping everything dr-positive.
 *
 * A dollar bank account worth more rupees is a debit and a gain. A dollar creditor that shrank is
 * also a debit (the credit balance moved toward zero) and also a gain. Nature never enters into
 * it, and a version of this that took a `nature` argument would have two branches that agreed.
 */
export function revaluationEffect(diffPaise: number): 'gain' | 'loss' | 'none' {
  if (diffPaise === 0) return 'none'
  return diffPaise > 0 ? 'gain' : 'loss'
}

/** The narration a revaluation journal carries, so the entry explains itself in a day book. */
export function revaluationNarration(input: {
  ledgerName: string
  code: string
  fcMinor: number
  decimals: number
  rateMicro: RateMicro
  asOn: string
}): string {
  return (
    `Exchange revaluation of ${input.ledgerName} as on ${input.asOn}: ` +
    `${formatFc(input.fcMinor, input.decimals, input.code)} at ${formatRate(input.rateMicro)}`
  )
}

/** The ledger the unrealised difference is posted to. Named, not typed by hand at each site. */
export const FX_GAIN_LOSS_LEDGER = 'Exchange Gain / Loss (Unrealised)'
