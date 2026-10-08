/**
 * Name resolution for AI drafting (WP 5.3). Pure: the drafting tools hand it the candidates
 * (parties, ledgers, stock items, bills) and the text the user used, and it says which one is
 * meant — or that several are close and the user has to choose. It NEVER picks silently between
 * near-equals: a draft tool turns `ambiguous` into a `needs_clarification` result listing the
 * candidates, and the assistant asks the user.
 *
 * Rules, in order:
 *   1. An identifier match (GSTIN, PAN, barcode — `keys`, case-insensitive, spaces ignored) is
 *      exact and wins outright. Several candidates sharing the key = ambiguous.
 *   2. A normalised-name match (case, punctuation, quotes, "&"/"and", "M/s", trailing
 *      "a/c" / "account" and company suffixes such as "Pvt Ltd" ignored) wins when exactly one
 *      candidate has it. Two with the same normalised name = ambiguous.
 *   3. Otherwise every candidate is scored (prefix, all-words, word overlap, small typo) and the
 *      best wins only when it is clearly ahead: score ≥ 70 and at least 15 points above the
 *      runner-up. Close scores = ambiguous; nothing ≥ 45 = none (with the closest few as hints).
 *   `secondary` keys (an HSN code) count as a word match, never as an identifier.
 */

export interface ResolveCandidate {
  id: number
  name: string
  /** Exact identifiers (GSTIN, PAN, barcode). */
  keys?: (string | null | undefined)[]
  /** Weaker attributes matched as words (HSN, alias). */
  secondary?: (string | null | undefined)[]
  /** Shown to the user when asking which one (group, GSTIN, rate). */
  detail?: string
}

export interface ResolveChoice {
  id: number
  name: string
  detail?: string
  score: number
}

export type Resolution =
  | { status: 'match'; id: number; name: string; why: string; score: number }
  | { status: 'ambiguous'; candidates: ResolveChoice[] }
  | { status: 'none'; closest: ResolveChoice[] }

const COMPANY_SUFFIXES = /\b(private limited|pvt\.? ltd\.?|pvt|ltd\.?|limited|llp|inc|co\.?|a\/c|ac|account)$/

/** Unicode-aware: NFKC folded, lower-case, quotes and punctuation dropped (letters, combining
 *  marks and digits of ANY script kept — Devanagari names stay distinct), "&" → "and", "M/s"
 *  dropped, spaces collapsed, trailing "a/c" and company suffixes dropped. A name made only of
 *  punctuation or emoji normalises to "" — and "" never matches anything. */
export function normaliseName(s: string): string {
  let t = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”"'‘’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/^m\/s\.?\s+/, '')
    .replace(/[^\p{L}\p{M}\p{N}/]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  for (let i = 0; i < 3; i++) {
    const next = t.replace(COMPANY_SUFFIXES, '').replace(/[\s/]+$/, '').trim()
    if (next === t || next === '') break
    t = next
  }
  return t.replace(/\//g, ' ').replace(/\s+/g, ' ').trim()
}

const keyOf = (s: string): string => s.replace(/\s+/g, '').toUpperCase()

function words(s: string): string[] {
  return s.split(' ').filter(Boolean)
}

/** Levenshtein distance, capped (returns cap + 1 once exceeded). */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      cur.push(v)
      rowMin = Math.min(rowMin, v)
    }
    if (rowMin > cap) return cap + 1
    prev = cur
  }
  return prev[b.length]!
}

/** 0–94: how well `query` (normalised) matches a candidate name (normalised). */
export function scoreName(query: string, name: string): number {
  if (!query || !name) return 0
  if (query === name) return 94
  const qw = words(query)
  const nw = words(name)
  // A prefix ending on a word boundary ("umbrella" of "umbrella retail") is strong; a mid-word
  // prefix counts only from five characters ("umbre"), so "umb" or "kri" never auto-picks.
  if (name.startsWith(query + ' ')) return query.length >= 3 ? 82 : 40
  if (name.startsWith(query)) return query.length >= 5 ? 80 : 50
  if (query.startsWith(name + ' ')) return 72
  // Every query word is the start of some name word ("umb ret" → "umbrella retail").
  const allPrefix = qw.every((w) => nw.some((n) => n.startsWith(w)))
  if (allPrefix) return qw.length >= 2 ? 78 : qw[0]!.length >= 5 || nw.includes(qw[0]!) ? 70 : 50
  const d = editDistance(query, name, 2)
  if (d <= 2 && query.length >= 5) return d === 1 ? 74 : 66
  const shared = qw.filter((w) => nw.some((n) => n === w || (w.length >= 4 && editDistance(w, n, 1) <= 1))).length
  if (shared === 0) return 0
  return Math.round((60 * shared) / Math.max(qw.length, nw.length))
}

export interface ResolveOptions {
  /** Minimum winning score for a fuzzy match (default 70). */
  minScore?: number
  /** Lead over the runner-up a fuzzy winner needs (default 15). */
  margin?: number
  /** How many candidates to list when asking (default 6). */
  limit?: number
}

const choice = (c: ResolveCandidate, score: number): ResolveChoice => ({ id: c.id, name: c.name, ...(c.detail ? { detail: c.detail } : {}), score })

export function resolveName(query: string, candidates: readonly ResolveCandidate[], opts: ResolveOptions = {}): Resolution {
  const minScore = opts.minScore ?? 70
  const margin = opts.margin ?? 15
  const limit = opts.limit ?? 6
  const raw = query.trim()
  if (!raw) return { status: 'none', closest: [] }

  // 1. identifiers
  const k = keyOf(raw)
  if (k.length >= 4) {
    const byKey = candidates.filter((c) => (c.keys ?? []).some((x) => x && keyOf(x) === k))
    if (byKey.length === 1) return { status: 'match', id: byKey[0]!.id, name: byKey[0]!.name, why: `its identifier is ${raw}`, score: 100 }
    if (byKey.length > 1) return { status: 'ambiguous', candidates: byKey.slice(0, limit).map((c) => choice(c, 100)) }
  }

  // 2. normalised name — an empty one (punctuation, emoji) matches nothing
  const q = normaliseName(raw)
  if (!q) return { status: 'none', closest: [] }
  const exactRaw = candidates.filter((c) => c.name.trim().toLowerCase() === raw.toLowerCase())
  if (exactRaw.length === 1) return { status: 'match', id: exactRaw[0]!.id, name: exactRaw[0]!.name, why: 'exact name', score: 100 }
  const exact = candidates.filter((c) => { const n = normaliseName(c.name); return n !== '' && n === q })
  if (exact.length === 1) return { status: 'match', id: exact[0]!.id, name: exact[0]!.name, why: 'same name (ignoring case and punctuation)', score: 95 }
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact.slice(0, limit).map((c) => choice(c, 95)) }

  // 3. scores
  const scored = candidates
    .map((c) => {
      const byName = scoreName(q, normaliseName(c.name))
      const bySecondary = Math.max(0, ...(c.secondary ?? []).map((s) => (s && keyOf(s) === k ? 76 : 0)))
      return { c, score: Math.max(byName, bySecondary) }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name))
  const best = scored[0]
  if (!best || best.score < 45) return { status: 'none', closest: scored.slice(0, 3).map((s) => choice(s.c, s.score)) }
  const runnerUp = scored[1]
  if (best.score >= minScore && (!runnerUp || best.score - runnerUp.score >= margin)) {
    const why =
      best.score >= 80 ? 'the only name starting with that' : best.score >= 76 && (best.c.secondary ?? []).some((s) => s && keyOf(s) === k) ? `its code is ${raw}` : 'the closest name (a small spelling difference)'
    return { status: 'match', id: best.c.id, name: best.c.name, why, score: best.score }
  }
  const close = scored.filter((s) => s.score >= Math.max(45, best.score - margin))
  return { status: 'ambiguous', candidates: close.slice(0, limit).map((s) => choice(s.c, s.score)) }
}
