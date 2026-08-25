/**
 * Reading a UPI line off a bank statement (#141).
 *
 * A UPI statement is structurally an ordinary statement — date, narration, amount — so the
 * profile machinery in bankImport.ts already imports one, and a PSP export whose headers nothing
 * recognises goes through the column mapper like any other file. What UPI needs on top is
 * narration handling, because a UPI narration is not prose: it is a fixed set of slash-separated
 * fields that every bank writes slightly differently.
 *
 *   UPI/DR/451234567890/ACME TRADERS/HDFC/acmetraders@okhdfc/Invoice 41
 *   UPI-RAVI KUMAR-RAVI@YBL-SBIN0001234-451234567890-RENT AUG
 *   UPI/CR/312345678901/SHREE ENT/UTIB/shree.ent@axl/Payment
 *
 * Two things follow from that shape, and both are the whole value of this module.
 *
 * First, the twelve-digit number is the UTR, and it is unique to the transaction. It is also
 * what the payer quoted when they messaged to say they had paid, so it is very often sitting in
 * the receipt voucher's reference or cheque-number field — a far stronger match than "same
 * amount, within five days".
 *
 * Second, that same UTR poisons narration learning. `significantWords` sees a token that occurs
 * exactly once in the history and will never occur again, and every UPI narration therefore looks
 * unlike every other one. Stripping the UTR and the handle leaves the counterparty name, which is
 * the part that repeats and the part worth remembering.
 *
 * Pure engine code.
 */

/**
 * The UTR / RRN of a UPI transaction: twelve digits.
 *
 * Required to stand alone as a token, because a bank's own running serial is often eleven or
 * thirteen digits sitting in the same narration, and a substring taken out of the middle of one
 * of those would be a reference number that matches nothing — or worse, matches the wrong
 * voucher. NPCI's RRN is twelve; anything else is not one.
 */
export function extractUtr(text: string): string | null {
  const match = text.match(/(?<![0-9])(\d{12})(?![0-9])/)
  return match ? match[1]! : null
}

/**
 * Virtual payment address (`name@bank`) — the counterparty's handle.
 *
 * The local part deliberately excludes '-', even though NPCI permits it in a handle: a hyphen is
 * also what SBI and a dozen PSPs use to separate the fields of the narration, and a greedy class
 * that accepted it read `UPI-RAVI KUMAR-RAVI@YBL` as the handle `kumar-ravi@ybl`. A handle that
 * genuinely contains a hyphen comes back slightly short, which is a cosmetic loss; a handle
 * dragged out of the previous field is a wrong identity.
 */
export function extractVpa(text: string): string | null {
  const match = text.match(/([A-Za-z0-9._]{2,})@([A-Za-z]{2,})/)
  if (!match) return null
  return `${match[1]}@${match[2]}`.toLowerCase()
}

/** IFSC shape: four letters, a zero, then six. Appears as a field of its own in most wordings. */
const IFSC_RE = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/

/** True when this narration is a UPI transfer at all. */
export function isUpiNarration(text: string): boolean {
  return /(^|[^a-z])upi([^a-z]|$)/i.test(text) || extractVpa(text) !== null
}

/**
 * Bank / PSP short codes that appear as a field of their own in a UPI narration.
 *
 * Listed so the counterparty extractor does not return "HDFC" as the name of the party. Kept to
 * the codes that genuinely appear in that slot — an IFSC prefix or a PSP tag — rather than every
 * bank name, because a customer really can be called "Kotak Enterprises".
 */
const BANK_TOKENS = new Set([
  'hdfc', 'icic', 'sbin', 'utib', 'kkbk', 'yesb', 'pytm', 'ibkl', 'punb', 'barb', 'cnrb',
  'iob', 'idib', 'ubin', 'bkid', 'mahb', 'axis', 'okhdfcbank', 'oksbi', 'okicici', 'okaxis',
  'upi', 'dr', 'cr', 'p2a', 'p2m', 'na'
])

/**
 * The counterparty's name, as far as the narration reveals it.
 *
 * Picks the longest slash- or dash-separated field that is not the UTR, not a handle, not a bank
 * code and not pure digits. "Longest" rather than "the third one" on purpose: the field order is
 * not stable across banks, and counting positions produces the payment note on one bank's
 * statement and the payer's name on another's.
 *
 * Returns null rather than a guess when nothing in the narration looks like a name — a wrong name
 * here becomes a learned association that mis-files every future payment from that party.
 */
export function upiCounterparty(text: string): string | null {
  const utr = extractUtr(text)
  const fields = text
    .split(/[/\-|]/)
    .map((f) => f.trim())
    .filter((f) => f !== '')

  let best: string | null = null
  let bestRank = -1
  for (const field of fields) {
    if (field === utr) continue
    if (/^\d+$/.test(field)) continue
    if (field.includes('@')) continue
    if (IFSC_RE.test(field)) continue
    const key = field.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (BANK_TOKENS.has(key)) continue
    // Two characters is not a name; it is an abbreviation nobody can act on.
    if (field.replace(/[^A-Za-z]/g, '').length < 3) continue
    // A field with no digits in it beats one with digits at any length: 'Invoice 41' is the
    // payment note and changes every month, 'ACME TRADERS' is the party and does not.
    const rank = (/\d/.test(field) ? 0 : 1000) + field.length
    if (rank > bestRank) {
      best = field
      bestRank = rank
    }
  }
  return best
}

/**
 * The part of a UPI narration worth remembering.
 *
 * Feeds the narration memory instead of the raw cell. Non-UPI narrations pass through untouched:
 * an NEFT line's reference is already stable enough for the memory to work with, and rewriting it
 * would invalidate everything learned before this existed.
 */
export function learnableNarration(text: string): string {
  if (!isUpiNarration(text)) return text
  return upiCounterparty(text) ?? text
}
