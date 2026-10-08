/**
 * Bank statement matching and learning (WP 4.1). Pure — the DB side lives in
 * src/main/services/bankImport.ts.
 *
 * Three parts:
 *  1. Narration tokens. Bank narrations are mostly rail noise (UPI / NEFT / IMPS / RTGS / CHQ /
 *     ACH prefixes, IFSC codes, UTRs and other reference numbers, VPA bank handles). What is left
 *     — usually the counterparty and a purpose word — is what identifies the transaction.
 *  2. Matching statement lines to book entries (bank-ledger voucher lines not yet reconciled):
 *     every candidate pair is scored on amount (exact, or within a tolerance), date gap (within
 *     a window), instrument / reference agreement and counterparty-name overlap; pairs are
 *     assigned greedily by score. Leftovers are tried as groups: several book entries settled by
 *     ONE bank line (one NEFT paying three invoices' receipts) and one book entry split across
 *     several bank lines (a deposit the bank credited in parts).
 *  3. Learning. Each confirmed match or voucher created from a statement line is an observation
 *     (tokens → ledger / party / voucher kind / narration template). Observations with the same
 *     direction and ledger merge into one learned rule whose tokens are the ones they share; a
 *     contradicting observation counts against the rule. Confidence is the Laplace-smoothed
 *     success rate, so a rule learned from one match is a hint and one learned from twelve is a
 *     strong suggestion ("Suggested from 12 earlier matches").
 */
import { findSumCombos } from './bankRules'

// ---------- 1. tokens ----------

/** Rail / boiler-plate words that never identify a counterparty. */
const NOISE = new Set([
  'UPI', 'NEFT', 'IMPS', 'RTGS', 'CHQ', 'CHEQUE', 'CHECK', 'CLG', 'CLEARING', 'CTS', 'MICR', 'ACH', 'NACH', 'ECS', 'ATM', 'POS',
  'BY', 'TO', 'FROM', 'TRANSFER', 'TRF', 'TFR', 'INB', 'MB', 'IB', 'NET', 'NETBANK', 'NETBANKING', 'MOBILE', 'CR', 'DR', 'DEBIT',
  'CREDIT', 'INWARD', 'OUTWARD', 'PAID', 'DEP', 'REF', 'NO', 'TXN', 'TRAN', 'PVT', 'LTD', 'LIMITED', 'PRIVATE', 'THE', 'AND',
  'OF', 'FOR', 'VIA', 'P2A', 'P2M', 'P2P', 'COLLECT', 'PAY', 'PAYMENT', 'RECEIVED', 'INSTA', 'ONLINE', 'SENT', 'OK', 'YBL',
  'OKHDFCBANK', 'OKICICI', 'OKSBI', 'OKAXIS', 'OKHDFC', 'PAYTM', 'APL', 'IBL', 'AXL', 'D', 'C', 'TP'
])
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/

/**
 * Normalised identifying tokens of a narration, in first-seen order: upper-cased, split on
 * anything that is not a letter or digit, VPA handles reduced to their user part, rail words,
 * IFSC codes and reference numbers (any token with 3+ digits) dropped, and single letters
 * dropped.
 */
export function narrationTokens(narration: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const vpaFree = narration.toUpperCase().replace(/([A-Z0-9._-]+)@[A-Z0-9.]+/g, (_, user: string) => user.replace(/[._-]/g, ' '))
  for (const raw of vpaFree.split(/[^A-Z0-9]+/)) {
    const t = raw.trim()
    if (t.length < 2 || NOISE.has(t) || IFSC.test(t)) continue
    if ((t.match(/\d/g) ?? []).length >= 3) continue
    if (/^\d+$/.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Stable key for a token set (sorted, space-joined). */
export const tokenSignature = (tokens: string[]): string => [...new Set(tokens)].sort().join(' ')

/** Share of `rule` tokens present in `line` tokens (0..1). */
export function tokenCoverage(rule: string[], line: string[]): number {
  if (rule.length === 0) return 0
  const set = new Set(line)
  return rule.filter((t) => set.has(t)).length / rule.length
}

/** Digits-only form of a reference / cheque number (leading zeros dropped). */
export const refDigits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '').replace(/^0+/, '')

// ---------- 2. matching ----------

export type Side = 'deposit' | 'withdrawal'

export interface MatchOptions {
  /** ± paise accepted between a statement line and a book entry. */
  amountTolerance: number
  /** ± days between the statement date and the voucher date. */
  dateWindowDays: number
  /** Largest group tried for many-to-one / one-to-many matches. */
  maxGroup: number
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = { amountTolerance: 0, dateWindowDays: 5, maxGroup: 3 }

export interface MatchLine {
  id: number
  date: string
  amount: number
  side: Side
  reference: string
  description: string
}

export interface MatchEntry {
  /** voucher_lines.id of the bank-ledger line. */
  id: number
  voucherId: number
  date: string
  amount: number
  side: Side
  instrumentNo: string | null
  /** Counter-party / particulars name (for name overlap). */
  partyName: string | null
  /** Same key = same counterparty (grouping for many-to-one). */
  partyKey: number | null
}

export type ProposalKind = 'one_to_one' | 'entries_to_line' | 'lines_to_entry'

export interface MatchProposal {
  kind: ProposalKind
  lineIds: number[]
  entryIds: number[]
  /** 0..1 */
  score: number
  /** Another candidate scored the same — the user should pick. */
  ambiguous: boolean
  reasons: string[]
}

const DAY = 86_400_000
const dayGap = (a: string, b: string): number => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / DAY)

/** Score one statement line against one book entry, or null when they can't be the same money. */
export function scorePair(line: MatchLine, entry: MatchEntry, opts: MatchOptions = DEFAULT_MATCH_OPTIONS): { score: number; reasons: string[] } | null {
  if (line.side !== entry.side) return null
  const diff = Math.abs(line.amount - entry.amount)
  if (diff > opts.amountTolerance) return null
  const gap = dayGap(line.date, entry.date)
  if (gap > opts.dateWindowDays) return null
  const reasons: string[] = []
  let score = diff === 0 ? 0.5 : 0.5 * (1 - diff / (opts.amountTolerance + 1)) * 0.8
  reasons.push(diff === 0 ? 'same amount' : `amount within ${diff} paise`)
  score += 0.25 * (1 - gap / (opts.dateWindowDays + 1))
  reasons.push(gap === 0 ? 'same day' : `${gap} day${gap === 1 ? '' : 's'} apart`)
  const inst = refDigits(entry.instrumentNo)
  if (inst.length >= 3 && (refDigits(line.reference) === inst || refDigits(line.description).includes(inst) || line.description.includes(entry.instrumentNo ?? '\u0000'))) {
    score += 0.2
    reasons.push('cheque / reference number agrees')
  }
  if (entry.partyName) {
    const cover = tokenCoverage(narrationTokens(entry.partyName), narrationTokens(line.description))
    if (cover >= 0.5) {
      score += 0.1 * cover
      reasons.push('party name in narration')
    }
  }
  return { score: Math.min(1, Math.round(score * 1000) / 1000), reasons }
}

/**
 * Propose matches for a statement against open book entries. Greedy by score for one-to-one;
 * then groups over what's left (entries_to_line first, then lines_to_entry). Deterministic:
 * ties break on smaller date gap, then lower ids.
 */
export function proposeMatches(lines: MatchLine[], entries: MatchEntry[], opts: MatchOptions = DEFAULT_MATCH_OPTIONS): MatchProposal[] {
  const pairs: { line: MatchLine; entry: MatchEntry; score: number; reasons: string[]; gap: number }[] = []
  for (const line of lines) {
    for (const entry of entries) {
      const s = scorePair(line, entry, opts)
      if (s) pairs.push({ line, entry, ...s, gap: dayGap(line.date, entry.date) })
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.gap - b.gap || a.line.id - b.line.id || a.entry.id - b.entry.id)
  const usedLines = new Set<number>()
  const usedEntries = new Set<number>()
  const out: MatchProposal[] = []
  for (const p of pairs) {
    if (usedLines.has(p.line.id) || usedEntries.has(p.entry.id)) continue
    // Ambiguous: another free entry for this line (or line for this entry) scores the same.
    const rival = pairs.some(
      (q) => q !== p && q.score === p.score &&
        ((q.line.id === p.line.id && !usedEntries.has(q.entry.id) && q.entry.id !== p.entry.id) ||
          (q.entry.id === p.entry.id && !usedLines.has(q.line.id) && q.line.id !== p.line.id))
    )
    usedLines.add(p.line.id)
    usedEntries.add(p.entry.id)
    out.push({ kind: 'one_to_one', lineIds: [p.line.id], entryIds: [p.entry.id], score: p.score, ambiguous: rival, reasons: p.reasons })
  }

  const within = (a: string, b: string): boolean => dayGap(a, b) <= opts.dateWindowDays
  // Several book entries ↔ one bank line (one NEFT settling several receipts / payments).
  for (const line of lines) {
    if (usedLines.has(line.id)) continue
    const pool = entries
      .filter((e) => !usedEntries.has(e.id) && e.side === line.side && e.amount < line.amount + opts.amountTolerance && within(e.date, line.date))
      .sort((a, b) => dayGap(a.date, line.date) - dayGap(b.date, line.date) || a.id - b.id)
    // Same-party groups first (the usual case), then any entries.
    const byParty = new Map<number, MatchEntry[]>()
    for (const e of pool) if (e.partyKey != null) byParty.set(e.partyKey, [...(byParty.get(e.partyKey) ?? []), e])
    const groups = [...byParty.values(), pool]
    for (const [gi, group] of groups.entries()) {
      if (group.length < 2) continue
      const combo = findSumCombos(line.amount, group.map((g) => g.amount), opts.maxGroup, opts.amountTolerance, 1)[0]
      if (!combo) continue
      const picked = combo.map((i) => group[i]!)
      for (const e of picked) usedEntries.add(e.id)
      usedLines.add(line.id)
      const samePartyGroup = gi < groups.length - 1
      out.push({
        kind: 'entries_to_line', lineIds: [line.id], entryIds: picked.map((e) => e.id).sort((a, b) => a - b),
        score: samePartyGroup ? 0.7 : 0.55, ambiguous: !samePartyGroup,
        reasons: [`${picked.length} book entries add up to this bank line`, ...(samePartyGroup ? ['all for the same party'] : [])]
      })
      break
    }
  }
  // One book entry ↔ several bank lines.
  for (const entry of entries) {
    if (usedEntries.has(entry.id)) continue
    const pool = lines
      .filter((l) => !usedLines.has(l.id) && l.side === entry.side && l.amount < entry.amount + opts.amountTolerance && within(l.date, entry.date))
      .sort((a, b) => dayGap(a.date, entry.date) - dayGap(b.date, entry.date) || a.id - b.id)
    if (pool.length < 2) continue
    const combo = findSumCombos(entry.amount, pool.map((l) => l.amount), opts.maxGroup, opts.amountTolerance, 1)[0]
    if (!combo) continue
    const picked = combo.map((i) => pool[i]!)
    for (const l of picked) usedLines.add(l.id)
    usedEntries.add(entry.id)
    out.push({
      kind: 'lines_to_entry', lineIds: picked.map((l) => l.id).sort((a, b) => a - b), entryIds: [entry.id],
      score: 0.55, ambiguous: true, reasons: [`${picked.length} bank lines add up to this book entry`]
    })
  }
  return out
}

/** Server-side check of a user-confirmed group: same side, sums agree within tolerance. */
export function validateGroup(lines: MatchLine[], entries: MatchEntry[], tolerance: number): string | null {
  if (lines.length === 0 || entries.length === 0) return 'Pick at least one statement line and one book entry'
  if (lines.length > 1 && entries.length > 1) return 'Match many-to-one or one-to-many, not many-to-many'
  const sides = new Set([...lines.map((l) => l.side), ...entries.map((e) => e.side)])
  if (sides.size > 1) return 'Deposits can only match receipts into the bank, withdrawals only payments out of it'
  const a = lines.reduce((s, l) => s + l.amount, 0)
  const b = entries.reduce((s, e) => s + e.amount, 0)
  if (Math.abs(a - b) > tolerance) return `Amounts differ by ₹${(Math.abs(a - b) / 100).toFixed(2)} — beyond the ₹${(tolerance / 100).toFixed(2)} tolerance`
  return null
}

// ---------- 3. learning ----------

export type LearnedStatus = 'candidate' | 'accepted' | 'ignored'

export interface LearnedRule {
  id: number
  direction: Side
  tokens: string[]
  ledgerId: number
  partyLedgerId: number | null
  voucherKind: string
  narrationTemplate: string | null
  /** Confirmed matches / created vouchers this rule was learned from. */
  hits: number
  /** Times its suggestion was used (bulk-created or accepted). */
  applied: number
  /** Times the user chose a different ledger for a line this rule matched. */
  rejected: number
  status: LearnedStatus
}

export interface Observation {
  direction: Side
  narration: string
  ledgerId: number
  partyLedgerId: number | null
  voucherKind: string
  narrationTemplate?: string | null
}

/** Laplace-smoothed success rate; an accepted rule is trusted at ≥ 0.9; an ignored one at 0. */
export function ruleConfidence(r: Pick<LearnedRule, 'hits' | 'applied' | 'rejected' | 'status'>): number {
  if (r.status === 'ignored') return 0
  const ok = r.hits + r.applied
  const base = (ok + 1) / (ok + r.rejected + 2)
  // Fewer than three observations stay a hint, whatever the ratio.
  const evidence = Math.min(1, ok / 3)
  const c = base * (0.6 + 0.4 * evidence)
  return Math.round((r.status === 'accepted' ? Math.max(c, 0.9) : c) * 1000) / 1000
}

export type LearnOp =
  | { op: 'create'; rule: Omit<LearnedRule, 'id' | 'hits' | 'applied' | 'rejected' | 'status'> }
  | { op: 'reinforce'; ruleId: number; tokens: string[] }
  | { op: 'contradict'; ruleId: number }

/**
 * What one observation does to the learned rules: the rule for the same direction + ledger whose
 * tokens overlap the narration's is reinforced (its tokens narrowed to the shared ones, never to
 * nothing); otherwise a new candidate is created. Any OTHER rule that would have claimed this
 * narration for a different ledger is contradicted. Narrations with no identifying tokens teach
 * nothing.
 */
export function learn(rules: LearnedRule[], obs: Observation): LearnOp[] {
  const tokens = narrationTokens(obs.narration)
  if (tokens.length === 0) return []
  const ops: LearnOp[] = []
  const same = rules
    .filter((r) => r.direction === obs.direction && r.ledgerId === obs.ledgerId && r.status !== 'ignored')
    .map((r) => ({ r, shared: r.tokens.filter((t) => tokens.includes(t)) }))
    .filter((x) => x.shared.length > 0 && x.shared.length >= Math.min(2, x.r.tokens.length))
    .sort((a, b) => b.shared.length - a.shared.length || b.r.hits - a.r.hits)[0]
  if (same) ops.push({ op: 'reinforce', ruleId: same.r.id, tokens: same.shared })
  else {
    ops.push({
      op: 'create',
      rule: {
        direction: obs.direction, tokens: tokens.slice(0, 6), ledgerId: obs.ledgerId, partyLedgerId: obs.partyLedgerId,
        voucherKind: obs.voucherKind, narrationTemplate: obs.narrationTemplate ?? null
      }
    })
  }
  for (const r of rules) {
    if (r.direction !== obs.direction || r.ledgerId === obs.ledgerId || r.status === 'ignored') continue
    if (tokenCoverage(r.tokens, tokens) === 1) ops.push({ op: 'contradict', ruleId: r.id })
  }
  return ops
}

export interface LearnedSuggestion {
  rule: LearnedRule
  coverage: number
  confidence: number
  score: number
}

/** Best learned rule for a statement line (all of a rule's tokens must appear, or ≥ 75 % of a
 *  rule with 4+ tokens), or null below `minScore`. */
export function suggestLearned(line: { description: string; side: Side }, rules: LearnedRule[], minScore = 0.4): LearnedSuggestion | null {
  const tokens = narrationTokens(line.description)
  if (tokens.length === 0) return null
  let best: LearnedSuggestion | null = null
  for (const rule of rules) {
    if (rule.direction !== line.side || rule.status === 'ignored' || rule.tokens.length === 0) continue
    const coverage = tokenCoverage(rule.tokens, tokens)
    if (coverage < (rule.tokens.length >= 4 ? 0.75 : 1)) continue
    const confidence = ruleConfidence(rule)
    // More specific rules (more tokens) edge out generic ones at equal confidence.
    const score = Math.round(coverage * confidence * (1 + Math.min(rule.tokens.length, 5) / 100) * 1000) / 1000
    if (score < minScore) continue
    if (!best || score > best.score || (score === best.score && rule.hits > best.rule.hits)) best = { rule, coverage, confidence, score }
  }
  return best
}

/** Narration for a voucher created from a statement line: template tokens {narration},
 *  {reference}, {date}; no template = the statement narration. */
export function renderNarration(template: string | null, line: { description: string; reference: string; date: string }): string {
  if (!template || !template.trim()) return line.description
  return template
    .replace(/\{narration\}/g, line.description)
    .replace(/\{reference\}/g, line.reference)
    .replace(/\{date\}/g, line.date)
    .trim()
}
