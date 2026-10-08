/**
 * WP 6.5 — inter-company pair suggestions. A party ledger in A's books "is" company B when it
 * carries B's GSTIN, or B's PAN (directly or as characters 3–12 of its GSTIN), or — weakest — B's
 * name. A GSTIN / PAN that is also A's own never counts (a ledger carrying the company's own
 * registration — a branch, a self-invoice ledger — is not the other company). A pair is suggested
 * when each side has a ledger for the other; each suggestion lists the kinds it could be and the
 * user picks (name-only matches start with none picked and are never accepted in bulk).
 */
import type { Nature } from '../domain'
import { normKey } from './math'
import type { IntercompanyPair, PairKind } from './types'

export interface SuggestLedger { id: number; name: string; groupName: string; nature: Nature; gstin: string | null; pan: string | null }
export interface SuggestMember { slug: string; name: string; gstin: string | null; pan: string | null; ledgers: SuggestLedger[] }
export type MatchReason = 'gstin' | 'pan' | 'name'
export interface PairSuggestion {
  memberA: string; ledgerAId: number; ledgerAName: string
  memberB: string; ledgerBId: number; ledgerBName: string
  /** Kinds not yet paired for these two ledgers (the user picks which to add). */
  kinds: PairKind[]
  reason: MatchReason
}

const RANK: Record<MatchReason, number> = { gstin: 0, pan: 1, name: 2 }
const up = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim().toUpperCase() : null)
export const panOfGstin = (gstin: string | null): string | null => (gstin && gstin.length >= 12 ? gstin.slice(2, 12).toUpperCase() : null)

/** How (if at all) ledger `l` (in the books of `own`) identifies company `c`. */
export function identifies(
  l: SuggestLedger, c: Pick<SuggestMember, 'name' | 'gstin' | 'pan'>, own?: Pick<SuggestMember, 'gstin' | 'pan'>
): MatchReason | null {
  const cg = up(c.gstin)
  const cp = up(c.pan) ?? panOfGstin(cg)
  const lg = up(l.gstin)
  const lp = up(l.pan) ?? panOfGstin(lg)
  const og = up(own?.gstin), op = up(own?.pan) ?? panOfGstin(og)
  if (cg && lg === cg && lg !== og) return 'gstin'
  if (cp && lp === cp && lp !== op) return 'pan'
  if (normKey(l.name) === normKey(c.name)) return 'name'
  return null
}

function best(m: SuggestMember, other: SuggestMember): { ledger: SuggestLedger; reason: MatchReason } | null {
  let out: { ledger: SuggestLedger; reason: MatchReason } | null = null
  for (const l of m.ledgers) {
    if (l.nature !== 'asset' && l.nature !== 'liability') continue
    const r = identifies(l, other, m)
    if (r && (!out || RANK[r] < RANK[out.reason])) out = { ledger: l, reason: r }
  }
  return out
}

export function suggestPairs(
  members: SuggestMember[],
  existing: Pick<IntercompanyPair, 'memberA' | 'ledgerAId' | 'memberB' | 'ledgerBId' | 'kind'>[]
): PairSuggestion[] {
  const has = (a: string, la: number, b: string, lb: number, kind: PairKind): boolean =>
    existing.some((p) => p.kind === kind && (
      (p.memberA === a && p.ledgerAId === la && p.memberB === b && p.ledgerBId === lb) ||
      (p.memberA === b && p.ledgerAId === lb && p.memberB === a && p.ledgerBId === la)))
  const out: PairSuggestion[] = []
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const A = members[i]!, B = members[j]!
      const inA = best(A, B), inB = best(B, A)
      if (!inA || !inB) continue
      const reason = RANK[inA.reason] >= RANK[inB.reason] ? inA.reason : inB.reason
      const kinds = (['receivable_payable', 'sales_purchase'] as const).filter((k) => !has(A.slug, inA.ledger.id, B.slug, inB.ledger.id, k))
      if (!kinds.length) continue
      out.push({ memberA: A.slug, ledgerAId: inA.ledger.id, ledgerAName: inA.ledger.name, memberB: B.slug, ledgerBId: inB.ledger.id, ledgerBName: inB.ledger.name, kinds, reason })
    }
  }
  // Registration matches first; name-only matches last.
  return out.sort((x, y) => RANK[x.reason] - RANK[y.reason])
}
