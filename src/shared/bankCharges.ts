/**
 * Bank's own charges and interest, recognised from the narration (#135).
 *
 * Every statement carries a handful of rows that are not the business's transactions at all —
 * the bank helping itself to a quarterly fee, the GST on that fee, interest credited on the
 * balance, interest debited on the OD. They never match a voucher, because no voucher was ever
 * written; they sit in the unmatched list forever, and at year end somebody keys twenty of them
 * by hand off a printout.
 *
 * The user could write bank rules for them, and that already works. The reason this module
 * exists instead of a shipped list of rules is that `matchRules` matches a plain substring, and
 * the wordings involved are exactly the ones a substring gets wrong: "CHARGE" is inside
 * "RECHARGE", so a rule saying CHARGE posts every mobile top-up to Bank Charges. That is a
 * voucher with real money in it, posted to the wrong account, and it looks right afterwards.
 *
 * So matching here is on whole words: the narration is cut into tokens and a phrase matches only
 * when its tokens appear as a consecutive run. "BILLDESK RECHARGE" tokenises to
 * ['billdesk','recharge'] and never matches ['charge'].
 *
 * The list is deliberately short and conservative. A wording that is missing costs the user one
 * hand-written rule; a wording that over-matches costs them a misposting they will not find.
 *
 * Pure engine code — src/main/services/banking.ts resolves the ledgers and posts the vouchers.
 */

/** What the bank did to the account, in the four shapes that need different ledgers. */
export type ChargeCategory =
  /** A fee the bank levied: quarterly maintenance, NEFT/IMPS fees, cheque return charges. */
  | 'charge'
  /** GST charged on one of those fees — recoverable input tax, not an expense. */
  | 'gst_on_charge'
  /** Interest the bank charged: OD/CC interest. */
  | 'interest_paid'
  /** Interest the bank credited: savings interest, auto-sweep FD interest. */
  | 'interest_earned'

export interface ChargePhrase {
  /** Word or phrase as it appears in a narration, matched token-wise and case-insensitively. */
  phrase: string
  category: ChargeCategory
}

/**
 * Wordings transcribed from real HDFC / ICICI / SBI / Axis / Kotak statement narrations.
 *
 * Checked against exports seen in the wild as at 2026-08. Anything ambiguous was left out on
 * purpose, and the ones worth naming are:
 *   - "COMMISSION" is not here: a commission paid to an agent is a business expense, and the
 *     narration reads identically.
 *   - "FEE" alone is not here: "ANNUAL FEE" is the bank, "TUITION FEE" is not.
 *   - Bare "GST" is not here: it is a supplier's name half the time. Only the forms banks
 *     actually use for their own tax line are listed.
 */
export const CHARGE_PHRASES: ChargePhrase[] = [
  // Fees the bank levies. Multi-word phrases match as a run, so 'sms alert' will not fire on an
  // SMS from a customer named Alert Traders.
  { phrase: 'chrg', category: 'charge' },
  { phrase: 'chrgs', category: 'charge' },
  { phrase: 'chgs', category: 'charge' },
  { phrase: 'charges', category: 'charge' },
  { phrase: 'service charge', category: 'charge' },
  { phrase: 'service charges', category: 'charge' },
  { phrase: 'bank charges', category: 'charge' },
  { phrase: 'sms alert', category: 'charge' },
  { phrase: 'sms chg', category: 'charge' },
  { phrase: 'amc', category: 'charge' },
  { phrase: 'annual maintenance', category: 'charge' },
  { phrase: 'min bal', category: 'charge' },
  { phrase: 'minimum balance', category: 'charge' },
  { phrase: 'non maintenance', category: 'charge' },
  { phrase: 'nmc', category: 'charge' },
  { phrase: 'cheque return', category: 'charge' },
  { phrase: 'chq return', category: 'charge' },
  { phrase: 'return charge', category: 'charge' },
  { phrase: 'processing fee', category: 'charge' },
  { phrase: 'folio charges', category: 'charge' },
  { phrase: 'cash handling', category: 'charge' },
  { phrase: 'cms fee', category: 'charge' },

  // The bank's own GST line. Always alongside a charge, always a withdrawal.
  { phrase: 'gst on', category: 'gst_on_charge' },
  { phrase: 'gst chrg', category: 'gst_on_charge' },
  { phrase: 'gst charges', category: 'gst_on_charge' },

  // Interest debited — OD, CC, term loan servicing out of the account.
  { phrase: 'int pd', category: 'interest_paid' },
  { phrase: 'interest paid', category: 'interest_paid' },
  { phrase: 'interest charged', category: 'interest_paid' },
  { phrase: 'od interest', category: 'interest_paid' },
  { phrase: 'debit interest', category: 'interest_paid' },

  // Interest credited.
  { phrase: 'int cr', category: 'interest_earned' },
  { phrase: 'interest credit', category: 'interest_earned' },
  { phrase: 'credit interest', category: 'interest_earned' },
  { phrase: 'sb int', category: 'interest_earned' },
  { phrase: 'saving interest', category: 'interest_earned' },
  { phrase: 'fd interest', category: 'interest_earned' },
  { phrase: 'interest on fd', category: 'interest_earned' }
]

/** Which side of the statement each category can appear on. */
const DIRECTION: Record<ChargeCategory, 'deposit' | 'withdrawal'> = {
  charge: 'withdrawal',
  gst_on_charge: 'withdrawal',
  interest_paid: 'withdrawal',
  interest_earned: 'deposit'
}

/** Human label, used for the ledger name and for what the preview says it will do. */
export const CATEGORY_LABEL: Record<ChargeCategory, string> = {
  charge: 'Bank Charges',
  gst_on_charge: 'Bank Charges GST',
  interest_paid: 'Bank Interest Paid',
  interest_earned: 'Bank Interest Received'
}

/**
 * Cut a narration into comparable word tokens.
 *
 * Bank narrations glue words to punctuation and reference numbers — `INT.PD:262850`,
 * `AMC-CHRG/2026`, `GST@18%`. Splitting on anything that is not a letter or digit turns all of
 * those into the same tokens, and dropping pure-digit tokens keeps a reference number from ever
 * being read as a word.
 */
export function narrationTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '' && !/^\d+$/.test(t))
}

/** True when `phrase`'s tokens occur as a consecutive run inside `tokens`. */
function hasRun(tokens: string[], phrase: string): boolean {
  const want = narrationTokens(phrase)
  if (want.length === 0) return false
  for (let i = 0; i + want.length <= tokens.length; i++) {
    let ok = true
    for (let j = 0; j < want.length; j++) {
      if (tokens[i + j] !== want[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

export interface ChargeClassification {
  category: ChargeCategory
  /** The phrase that fired, so the preview can say why rather than just what. */
  phrase: string
}

/**
 * Classify one statement row as the bank's own charge or interest, or null for anything else.
 *
 * The direction is part of the test, not decoration: a deposit whose narration says CHARGES is a
 * refund of one, and posting that as an expense would be backwards. It falls through to null and
 * the user files it themselves.
 *
 * When several phrases fit, the longest wins — 'gst on chrg' is a GST line, not a charge line,
 * and reading it as the latter would put input tax into the P&L.
 */
export function classifyBankLine(
  description: string,
  kind: 'deposit' | 'withdrawal'
): ChargeClassification | null {
  const tokens = narrationTokens(description)
  if (tokens.length === 0) return null

  let best: ChargeClassification | null = null
  let bestLength = 0
  for (const candidate of CHARGE_PHRASES) {
    if (DIRECTION[candidate.category] !== kind) continue
    if (!hasRun(tokens, candidate.phrase)) continue
    const length = candidate.phrase.length
    if (length > bestLength) {
      best = { category: candidate.category, phrase: candidate.phrase }
      bestLength = length
    }
  }
  return best
}

/**
 * Which side of the *voucher* the recognised ledger sits on.
 *
 * A charge is money out of the bank, so the expense is debited and the bank credited — a payment.
 * Interest earned is money in: income credited, bank debited — a receipt.
 */
export function voucherKindFor(category: ChargeCategory): 'payment' | 'receipt' {
  return DIRECTION[category] === 'withdrawal' ? 'payment' : 'receipt'
}
