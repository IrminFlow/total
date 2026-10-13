// "Did you mean Sales?" (WP 8.4). Before a new account or product is created, its name is compared
// with the existing ones using the WP 5.3 name rules (aiResolve: normaliseName + scoreName — case,
// punctuation, "&"/"and", "M/s", "a/c" and company suffixes ignored; prefixes, shared words and
// small typos scored). Pure.
//
// The UX audit's case: "Sal" typed in a picker became a new ledger next to "Sales". A prompt is
// cheap (the user answers "No, create Sal"), a duplicate account is not, so the bar is lower
// than drafting's auto-pick (70): NEAR_DUPLICATE_MIN_SCORE = 50 catches a 3+ letter prefix
// ("Sal" → Sales), a one- or two-letter typo in a 5+ letter name ("Sarma Traders" → "Sharma Traders")
// and a word the name shares as a whole ("Rent" → "Shop rent"); it does not fire for names that
// merely share a common word ("ABC Traders" vs "XYZ Traders" scores 30).
import { normaliseName, scoreName } from '../aiResolve'

export const NEAR_DUPLICATE_MIN_SCORE = 50
export const NEAR_DUPLICATE_LIMIT = 3

export interface NearDuplicate {
  id: number
  name: string
  score: number
  /** Same name once case / punctuation / suffixes are ignored — creating it would be a copy. */
  same: boolean
}

export function nearDuplicates(name: string, existing: readonly { id: number; name: string }[], limit = NEAR_DUPLICATE_LIMIT): NearDuplicate[] {
  const q = normaliseName(name)
  if (!q) return []
  const out: NearDuplicate[] = []
  for (const e of existing) {
    const n = normaliseName(e.name)
    if (!n) continue
    const same = n === q
    // Both directions: "Sales" typed when "Sal" exists is as much a near-copy as the reverse.
    // Under three letters only an exact copy counts ("Sa" asks about nothing).
    const score = same ? 100 : q.length < 3 ? 0 : Math.max(scoreName(q, n), scoreName(n, q))
    if (score >= NEAR_DUPLICATE_MIN_SCORE) out.push({ id: e.id, name: e.name, score, same })
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return out.slice(0, limit)
}
