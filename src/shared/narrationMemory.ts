/**
 * Auto-match on narration keywords, learned from past matches (#133).
 *
 * A bank rule is something the user has to think of and write down. Most of them never do — but
 * they do post the same electricity bill every month, and the narration says so every time. This
 * remembers the significant words of a narration against the ledger the user actually chose, and
 * offers the same ledger the next time those words show up.
 *
 * Two things it must not do. It must not learn the bank's own vocabulary — 'NEFT', 'UPI',
 * 'CHARGES' would end up pointing at whatever ledger was posted first and then at everything. And
 * it must not sound confident about one observation: seeing 'MAHANAGAR' once and offering it back
 * at 95% is how a suggestion engine posts a year of entries to the wrong ledger. Confidence here
 * is coverage of the narration multiplied by how often the evidence has actually been seen, so a
 * single sighting can never clear the bulk-accept threshold on its own.
 *
 * Pure engine code — the DB side lives in src/main/services/banking.ts.
 */

/**
 * Words that appear in bank narrations without saying anything about who was paid: transfer
 * mechanisms, direction markers, the bank's own abbreviations. Learning these would tie every
 * NEFT in the file to whichever ledger the first NEFT went to.
 */
export const NARRATION_NOISE = new Set([
  'neft', 'rtgs', 'imps', 'upi', 'ach', 'ecs', 'nach', 'atm', 'pos', 'emi',
  'chq', 'cheque', 'clg', 'clearing', 'trf', 'transfer', 'txn', 'tran', 'ref',
  'inb', 'inf', 'mob', 'net', 'banking', 'bank', 'debit', 'credit', 'dr', 'cr',
  'the', 'and', 'for', 'from', 'via', 'inr', 'rs', 'payment', 'paid', 'received',
  'charges', 'charge', 'gst', 'tax', 'auto', 'sweep', 'reversal', 'return'
])

/** How many keywords one narration is allowed to contribute — a 20-word remark should not
 *  outvote a 3-word one just by carrying more tokens. */
const MAX_KEYWORDS = 6

/**
 * The words of a narration worth remembering: letters only, at least three of them, not one of
 * the bank's own words, de-duplicated, in first-seen order.
 *
 * Anything with a digit in it is dropped outright — a UTR, a cheque number or a date is unique to
 * one transaction, so remembering it would build a memory that can never match anything again.
 */
export function significantWords(description: string, max = MAX_KEYWORDS): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of description.split(/[^A-Za-z0-9]+/)) {
    if (raw === '' || /\d/.test(raw)) continue
    const word = raw.toLowerCase()
    if (word.length < 3 || NARRATION_NOISE.has(word) || seen.has(word)) continue
    seen.add(word)
    out.push(word)
    if (out.length >= max) break
  }
  return out
}

export interface MemoryEntry {
  keyword: string
  ledgerId: number
  kind: 'payment' | 'receipt'
  /** How many separate matches taught this keyword→ledger pair. */
  hits: number
}

export interface LearnedSuggestion {
  ledgerId: number
  kind: 'payment' | 'receipt'
  /** 0–100. Integer, because it is shown to a person and compared against a threshold they set. */
  confidence: number
  /** The narration words that carried the match — the "why" behind the suggestion. */
  matched: string[]
  /** Another ledger scored exactly as well. Halves the confidence and bars bulk-accept: with two
   *  equal answers the engine does not have one. */
  ambiguous: boolean
}

/**
 * How much a keyword seen `hits` times is worth, as a multiplier on coverage.
 *
 * Deliberately steep at the bottom. One observation is an anecdote and tops out at 40%, which no
 * sane threshold accepts; it takes three before the engine will speak with a full voice.
 */
function supportFactor(hits: number): number {
  if (hits >= 3) return 1
  if (hits === 2) return 0.75
  return 0.4
}

/**
 * Best ledger for a narration, given everything learned so far.
 *
 * Score is the share of the narration's significant words that point at the ledger, scaled by how
 * well-observed that evidence is. Only memory of the same direction counts — a name learned from
 * payments says nothing about a deposit with the same wording, which is usually a refund.
 */
export function suggestFromMemory(
  description: string,
  kind: 'payment' | 'receipt',
  memory: MemoryEntry[]
): LearnedSuggestion | null {
  const words = significantWords(description)
  if (words.length === 0) return null
  const wordSet = new Set(words)

  const byLedger = new Map<number, { matched: string[]; evidence: number }>()
  for (const entry of memory) {
    if (entry.kind !== kind || !wordSet.has(entry.keyword)) continue
    const acc = byLedger.get(entry.ledgerId) ?? { matched: [], evidence: 0 }
    if (!acc.matched.includes(entry.keyword)) acc.matched.push(entry.keyword)
    acc.evidence = Math.max(acc.evidence, entry.hits)
    byLedger.set(entry.ledgerId, acc)
  }
  if (byLedger.size === 0) return null

  const scored = [...byLedger.entries()]
    .map(([ledgerId, acc]) => ({
      ledgerId,
      matched: acc.matched,
      confidence: Math.round((acc.matched.length / words.length) * supportFactor(acc.evidence) * 100)
    }))
    // Ledger id breaks ties so the same books always answer the same way — a suggestion that
    // moves between runs is impossible to trust or to test.
    .sort((a, b) => b.confidence - a.confidence || a.ledgerId - b.ledgerId)

  const top = scored[0]!
  if (top.confidence === 0) return null
  const ambiguous = scored.length > 1 && scored[1]!.confidence === top.confidence
  return {
    ledgerId: top.ledgerId,
    kind,
    confidence: ambiguous ? Math.round(top.confidence / 2) : top.confidence,
    matched: top.matched,
    ambiguous
  }
}

/**
 * Default bar for "accept this without looking at it" (#134).
 *
 * 80 means the narration is mostly known words pointing one way, seen at least three times. A
 * rule-based match is 100 and always clears it; a single-observation guess is 40 and never can.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 80
