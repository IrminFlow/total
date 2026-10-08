// WP 5.4 — categorising unmatched bank statement lines. Pure; the service (main/ai/capture/
// bankCategorise.ts) loads the lines, the history and the ledgers, and only the RESIDUAL — lines
// no deterministic rule could place — ever goes to the model, with a candidate list it must pick
// from (schema-enforced ids, checked again here: an id outside the line's candidates is dropped).
//
// Deterministic rules, in order:
//   1. a manual bank rule or an accepted learned rule (WP 4.1 — the workspace's own suggestion);
//   2. per-company memory (WP 5.6, when provided): a party named in the narration that the user
//      keeps a party memory for — recorded as "From memory [Mn]: …" (a default, shown as such);
//   3. history: the same narration prefix (its first two identifying tokens — bankMatch
//      narrationTokens drops rail noise, UTRs and IFSCs) on the same side → the ledger used
//      before, when at least three quarters of those earlier entries agree;
//   4. a party named in the narration (every identifying word of a debtor / creditor name);
//   5. a candidate learned rule (a hint learned from one or two matches).
// The remembered default ledger for the side (preference "expense" for withdrawals, "income" for
// deposits) is never applied on its own: it heads the residual's candidates, marked as memory.
// Voucher kind: contra when the ledger is cash / bank, else receipt for a deposit and payment for
// a withdrawal; a party ledger is allocated oldest bill first (the Outstandings engine does that
// when the draft is built).
import { narrationTokens, type Side } from '../bankMatch'

export interface CatLine {
  id: number
  date: string
  description: string
  reference: string
  side: Side
  amount: number
}

export interface HistoryEntry {
  description: string
  side: Side
  ledgerId: number
  partyLedgerId: number | null
  date: string
}

export type CatLedgerKind = 'debtor' | 'creditor' | 'cash_bank' | 'expense' | 'income' | 'tax' | 'other'

export interface CatLedger {
  id: number
  name: string
  kind: CatLedgerKind
}

/** A suggestion the statement workspace already made (manual rule / learned rule). */
export interface RuleHint {
  source: 'rule' | 'learned'
  ruleId: number
  ledgerId: number
  partyLedgerId: number | null
  /** 'accepted' / 'manual' rules are deterministic; 'candidate' ones only a hint. */
  status: 'manual' | 'accepted' | 'candidate' | 'ignored'
  confidence: number
  why: string
}

export type CategorySource = 'rule' | 'learned' | 'memory' | 'history' | 'party' | 'ai' | 'none'

export interface CategoryProposal {
  lineId: number
  ledgerId: number | null
  partyLedgerId: number | null
  kind: 'payment' | 'receipt' | 'contra'
  source: CategorySource
  /** 0..1 */
  confidence: number
  why: string
  /** Allocate against the party's open bills, oldest first. */
  oldestBillsFirst: boolean
  /** For the residual: the ledgers the model may pick from (and the review table offers). */
  candidates: { id: number; name: string; why: string; memoryId?: number }[]
  ruleId?: number
  /** WP 5.6: the memory this proposal rests on (cited on the draft as an assumption). */
  memoryId?: number
}

/** WP 5.6 memory as the categoriser consults it (main builds it from the MemoryContext). */
export interface CategoriseMemory {
  /** The active party memory for this party ledger. */
  party(partyLedgerId: number): { memoryId: number; text: string } | null
  /** The remembered default ledger for withdrawals ('expense') or deposits ('income'). */
  preferred(side: Side): { ledgerId: number; memoryId: number; text: string } | null
}

export interface CategoriseOptions {
  history: readonly HistoryEntry[]
  ledgers: readonly CatLedger[]
  bankLedgerId: number
  hints?: ReadonlyMap<number, RuleHint>
  /** WP 5.6 hook (optional). */
  memory?: CategoriseMemory
  /** Max candidates per residual line. */
  maxCandidates?: number
}

export const HISTORY_AGREEMENT = 0.75

export function narrationPrefix(description: string, n = 2): string {
  return narrationTokens(description).slice(0, n).join(' ')
}

export function kindFor(ledger: CatLedger | undefined, side: Side): 'payment' | 'receipt' | 'contra' {
  if (ledger?.kind === 'cash_bank') return 'contra'
  return side === 'deposit' ? 'receipt' : 'payment'
}

const isParty = (l: CatLedger | undefined): boolean => l?.kind === 'debtor' || l?.kind === 'creditor'

export const memoryWhy = (m: { memoryId: number; text: string }): string => `From memory [M${m.memoryId}]: ${m.text}`

function proposal(line: CatLine, ledger: CatLedger | undefined, p: Omit<CategoryProposal, 'lineId' | 'kind' | 'oldestBillsFirst' | 'partyLedgerId' | 'candidates'> & { partyLedgerId?: number | null }): CategoryProposal {
  return {
    lineId: line.id,
    ledgerId: p.ledgerId,
    partyLedgerId: p.partyLedgerId ?? (isParty(ledger) ? ledger!.id : null),
    kind: kindFor(ledger, line.side),
    source: p.source,
    confidence: p.confidence,
    why: p.why,
    oldestBillsFirst: isParty(ledger),
    candidates: [],
    ...(p.ruleId ? { ruleId: p.ruleId } : {}),
    ...(p.memoryId ? { memoryId: p.memoryId } : {})
  }
}

/** History entries agreeing on one ledger for this line's prefix. */
export function historyVote(line: CatLine, history: readonly HistoryEntry[]): { ledgerId: number; share: number; count: number; total: number; others: number[] } | null {
  const prefix = narrationPrefix(line.description)
  if (!prefix) return null
  const same = history.filter((h) => h.side === line.side && narrationPrefix(h.description) === prefix)
  if (same.length === 0) return null
  const votes = new Map<number, number>()
  for (const h of same) votes.set(h.ledgerId, (votes.get(h.ledgerId) ?? 0) + 1)
  const ranked = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const [ledgerId, count] = ranked[0]!
  return { ledgerId, count, total: same.length, share: count / same.length, others: ranked.slice(1).map(([id]) => id) }
}

/** Party ledgers every identifying word of whose name is in the narration. */
export function partiesNamed(line: CatLine, ledgers: readonly CatLedger[]): CatLedger[] {
  const tokens = new Set(narrationTokens(line.description))
  return ledgers.filter((l) => {
    if (!isParty(l)) return false
    const words = narrationTokens(l.name)
    return words.length > 0 && words.join('').length >= 4 && words.every((w) => tokens.has(w))
  })
}

export function categoriseLines(lines: readonly CatLine[], opts: CategoriseOptions): CategoryProposal[] {
  const byId = new Map(opts.ledgers.map((l) => [l.id, l]))
  const max = opts.maxCandidates ?? 30
  return lines.map((line) => {
    const hint = opts.hints?.get(line.id)
    if (hint && hint.ledgerId !== opts.bankLedgerId && (hint.status === 'manual' || hint.status === 'accepted')) {
      return proposal(line, byId.get(hint.ledgerId), { ledgerId: hint.ledgerId, partyLedgerId: hint.partyLedgerId, source: hint.source, confidence: Math.max(hint.confidence, 0.9), why: hint.why, ruleId: hint.ruleId })
    }
    const named = partiesNamed(line, opts.ledgers)
    if (opts.memory) {
      const remembered = named.map((l) => ({ l, m: opts.memory!.party(l.id) })).filter((x) => x.m)
      if (remembered.length === 1) {
        const { l, m } = remembered[0]!
        return proposal(line, l, { ledgerId: l.id, source: 'memory', confidence: 0.9, why: memoryWhy(m!), memoryId: m!.memoryId })
      }
    }
    const vote = historyVote(line, opts.history)
    if (vote && vote.share >= HISTORY_AGREEMENT && byId.has(vote.ledgerId) && vote.ledgerId !== opts.bankLedgerId) {
      const l = byId.get(vote.ledgerId)!
      return proposal(line, l, {
        ledgerId: l.id, source: 'history', confidence: Math.min(0.95, 0.6 + 0.35 * vote.share * Math.min(1, vote.count / 3)),
        why: `“${narrationPrefix(line.description)}” went to ${l.name} ${vote.count === vote.total ? `all ${vote.count} time${vote.count === 1 ? '' : 's'}` : `${vote.count} of ${vote.total} times`} before`
      })
    }
    const preferred = named.filter((l) => (line.side === 'deposit' ? l.kind === 'debtor' : l.kind === 'creditor'))
    const pick = preferred.length === 1 ? preferred[0] : named.length === 1 ? named[0] : undefined
    if (pick) {
      return proposal(line, pick, { ledgerId: pick.id, source: 'party', confidence: 0.85, why: `the narration names ${pick.name}` })
    }
    if (hint && hint.status === 'candidate' && hint.ledgerId !== opts.bankLedgerId && hint.confidence >= 0.5) {
      return proposal(line, byId.get(hint.ledgerId), { ledgerId: hint.ledgerId, partyLedgerId: hint.partyLedgerId, source: hint.source, confidence: hint.confidence, why: hint.why, ruleId: hint.ruleId })
    }
    // Residual: the candidate list the model (and the user) picks from.
    const cands = new Map<number, { id: number; name: string; why: string; memoryId?: number }>()
    const add = (l: CatLedger | undefined, why: string, memoryId?: number): void => {
      if (!l || l.id === opts.bankLedgerId || cands.has(l.id) || cands.size >= max) return
      cands.set(l.id, { id: l.id, name: l.name, why, ...(memoryId ? { memoryId } : {}) })
    }
    const pref = opts.memory?.preferred(line.side)
    if (pref) add(byId.get(pref.ledgerId), memoryWhy(pref), pref.memoryId)
    if (hint) add(byId.get(hint.ledgerId), hint.why)
    if (vote) {
      add(byId.get(vote.ledgerId), `used ${vote.count} of ${vote.total} times for “${narrationPrefix(line.description)}”`)
      for (const o of vote.others) add(byId.get(o), `also used for “${narrationPrefix(line.description)}”`)
    }
    for (const l of named) add(l, 'named in the narration')
    const first = narrationPrefix(line.description, 1)
    if (first.length >= 4) {
      const loose = historyVote({ ...line, description: first }, opts.history.map((h) => ({ ...h, description: narrationPrefix(h.description, 1) })))
      if (loose) for (const id of [loose.ledgerId, ...loose.others]) add(byId.get(id), `used before for narrations starting “${first}”`)
    }
    const tokens = new Set(narrationTokens(line.description))
    for (const l of opts.ledgers) if (isParty(l) && narrationTokens(l.name).some((w) => w.length >= 4 && tokens.has(w))) add(l, 'a word of its name is in the narration')
    const pool: CatLedgerKind[] = line.side === 'withdrawal' ? ['expense', 'creditor', 'tax', 'cash_bank', 'other'] : ['income', 'debtor', 'cash_bank', 'other']
    for (const k of pool) for (const l of opts.ledgers) if (l.kind === k) add(l, k === 'cash_bank' ? 'a transfer (contra)' : `a ${k === 'other' ? 'ledger' : k} ledger`)
    return {
      lineId: line.id, ledgerId: null, partyLedgerId: null, kind: line.side === 'deposit' ? 'receipt' : 'payment', source: 'none', confidence: 0,
      why: 'no rule, history or party name places this line', oldestBillsFirst: false, candidates: [...cands.values()]
    }
  })
}

/** Apply the model's picks to the residual: only an id from the line's own candidate list counts. */
export function applyModelPicks(
  proposals: readonly CategoryProposal[],
  picks: readonly { lineId: number; ledgerId: number | null; reason: string }[],
  ledgers: readonly CatLedger[]
): { proposals: CategoryProposal[]; rejected: { lineId: number; ledgerId: number; reason: string }[] } {
  const byId = new Map(ledgers.map((l) => [l.id, l]))
  const rejected: { lineId: number; ledgerId: number; reason: string }[] = []
  const pickBy = new Map(picks.map((p) => [p.lineId, p]))
  const out = proposals.map((p) => {
    if (p.source !== 'none') return p
    const pick = pickBy.get(p.lineId)
    if (!pick || pick.ledgerId == null) return p
    if (!p.candidates.some((c) => c.id === pick.ledgerId)) {
      rejected.push({ lineId: p.lineId, ledgerId: pick.ledgerId, reason: 'not one of the line’s candidates' })
      return p
    }
    const l = byId.get(pick.ledgerId)
    const side: Side = p.kind === 'receipt' ? 'deposit' : 'withdrawal'
    return {
      ...p,
      ledgerId: pick.ledgerId,
      partyLedgerId: isParty(l) ? pick.ledgerId : null,
      kind: kindFor(l, side),
      oldestBillsFirst: isParty(l),
      source: 'ai' as const,
      confidence: 0.5,
      why: `suggested by the assistant from the candidates${pick.reason ? `: ${pick.reason.slice(0, 160)}` : ''}`,
      ...(p.candidates.find((c) => c.id === pick.ledgerId)?.memoryId ? { memoryId: p.candidates.find((c) => c.id === pick.ledgerId)!.memoryId } : {})
    }
  })
  return { proposals: out, rejected }
}

/** Structured-output schema for the residual call: one pick per line, ids from the candidates. */
export function categoriseResponseSchema(lineIds: readonly number[], ledgerIds: readonly number[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lineId: { type: 'integer', enum: [...lineIds] },
            ledgerId: { type: ['integer', 'null'], enum: [...ledgerIds, null] },
            reason: { type: 'string' }
          },
          required: ['lineId', 'ledgerId', 'reason'],
          additionalProperties: false
        }
      }
    },
    required: ['picks'],
    additionalProperties: false
  }
}
