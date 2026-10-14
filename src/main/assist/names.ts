// Ask Total — names said in a question → books records, through the SEARCH SERVICE (the palette's
// own search; navigation and names are never resolved by a model). The search finds the
// candidates; the WP 5.3 resolver (shared/aiResolve.ts resolveName) decides — one clear winner
// is taken, close ones are ASKED about ("Which Ramesh?"), never guessed.
import type { DB } from '../db/connection'
import { resolveName, type ResolveCandidate } from '@shared/aiResolve'
import { fyOf } from '@shared/dates'
import { search } from '../services/search'
import { ledgerClassifier, type LedgerClass } from '../ai/ledgerClass'

export type NameResult =
  | { status: 'match'; id: number; name: string }
  | { status: 'choose'; options: { id: number; label: string; sub?: string }[] }
  | { status: 'none' }

const PLURAL = /(?:es|s)$/

function decide(said: string, candidates: ResolveCandidate[]): NameResult {
  if (candidates.length === 0) return { status: 'none' }
  const r = resolveName(said, candidates)
  if (r.status === 'match') return { status: 'match', id: r.id, name: r.name }
  if (r.status === 'ambiguous') return { status: 'choose', options: r.candidates.map((c) => ({ id: c.id, label: c.name, ...(c.detail ? { sub: c.detail } : {}) })) }
  // Nothing clearly ahead: the search's own hits are offered ("Did you mean …?").
  const list = r.closest.length ? r.closest.map((c) => ({ id: c.id, label: c.name, ...(c.detail ? { sub: c.detail } : {}) })) : candidates.slice(0, 6).map((c) => ({ id: c.id, label: c.name, ...(c.detail ? { sub: c.detail } : {}) }))
  return { status: 'choose', options: list.slice(0, 6) }
}

/** A ledger of one of `classes` (debtor / creditor / expense …) called `said`. */
export function findLedger(db: DB, said: string, classes: readonly LedgerClass[], today: string): NameResult {
  const cls = ledgerClassifier(db)
  const hits = search(db, said, { kind: 'ledger', limitPerKind: 25, today, fyStartYear: fyOf(today).startYear }).ledgers?.rows ?? []
  const candidates = hits.filter((h) => classes.includes(cls.cls(h.id))).map((h) => ({ id: h.id, name: h.name, detail: h.groupName }))
  return decide(said, candidates)
}

/** A stock item called `said` ("bags" also finds "Bag"). */
export function findItem(db: DB, said: string, today: string): NameResult {
  const opts = { kind: 'item' as const, limitPerKind: 25, today, fyStartYear: fyOf(today).startYear }
  const forms = [said, ...(PLURAL.test(said) && said.length > 3 ? [said.replace(/es$/, ''), said.replace(/s$/, '')] : [])]
  const seen = new Map<number, ResolveCandidate>()
  for (const f of [...new Set(forms)]) {
    for (const h of search(db, f, opts).items?.rows ?? []) seen.set(h.id, { id: h.id, name: h.name, ...(h.groupName ? { detail: h.groupName } : {}) })
  }
  const candidates = [...seen.values()]
  for (const f of [...new Set(forms)]) {
    const r = decide(f, candidates)
    if (r.status === 'match') return r
  }
  return decide(said, candidates)
}
