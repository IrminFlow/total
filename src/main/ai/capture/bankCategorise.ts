// WP 5.4 — "Categorise unmatched" in Banking → statement: deterministic rules first (the pure
// engine in shared/capture/categorise.ts over WP 4.1's statement lines, learned rules and the
// match history), the model ONLY for the residual — with each line's candidate list in its
// context and a structured answer whose ids are enumerated by the schema (and checked again).
// Accepting a row makes a DRAFT through the draft_voucher builder (WP 5.3), linked to its
// statement line: saving the draft reconciles the line (consume.ts → reconcileSavedDraft).
import type { DB } from '../../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { formatPaise } from '@shared/money'
import { applyModelPicks, categoriseLines, kindFor, memoryWhy, type CatLedger, type CatLine, type CategoriseMemory, type CategoryProposal, type RuleHint } from '@shared/capture/categorise'
import { getAiSettings } from '../settings'
import { getMemory, markMemoriesUsed, memoryContextFor } from '../memory'
import { renderPartyName } from '../memoryRules'
import type { CategoriseAcceptResult, StatementCategorisation, StatementCategoryRow } from '@shared/capture/types'
import { categoriseInputs } from '../../services/bankImport'
import { bankLedgers } from '../../services/banking'
import { descendantIdsByName, listLedgers } from '../../services/masters'
import { writeAudit } from '../../services/audit'
import { DraftWork, NeedsClarification, loadMasters } from '../drafting/work'
import { buildAccountingDraft, type AccountingDraftInput } from '../drafting/builders'
import { insertDraft } from '../store'

/** Ledgers classified for the categoriser by their group. */
/** Paise → the rupee text the draft builders read with parseAmountText (integer maths). */
const paiseToRupeeText = (p: number): string => `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`

export function catLedgers(db: DB): CatLedger[] {
  const sets: [CatLedger['kind'], Set<number>][] = [
    ['debtor', descendantIdsByName(db, ['Sundry Debtors'])],
    ['creditor', descendantIdsByName(db, ['Sundry Creditors'])],
    ['cash_bank', descendantIdsByName(db, ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'])],
    ['tax', descendantIdsByName(db, ['Duties & Taxes'])],
    ['expense', descendantIdsByName(db, ['Direct Expenses', 'Indirect Expenses', 'Purchase Accounts'])],
    ['income', descendantIdsByName(db, ['Direct Incomes', 'Indirect Incomes', 'Sales Accounts'])]
  ]
  return listLedgers(db).map((l) => ({ id: l.id, name: l.name, kind: sets.find(([, s]) => s.has(l.groupId))?.[0] ?? 'other' }))
}


/** The residual call to the model (capture/bankCategoriseAi.ts) — injected by the app's IPC so
 *  this module (reachable from the CLI / MCP through draft_voucher and categorise_statement)
 *  never imports the provider. */
export type AskResidual = (lines: CatLine[], residual: CategoryProposal[]) => Promise<{ lineId: number; ledgerId: number | null; reason: string }[]>

export interface CategoriseDeps {
  /** Present only when AI may be used (the app's IPC, AI ready). */
  ask?: AskResidual | null
  db: DB
  today: string
  /** WP 5.6 memory; default = the company's active memories when Settings → AI uses memory. */
  memory?: CategoriseMemory | null
}

/** The categoriser's view of WP 5.6 memory: party memories (a named party is a remembered
 *  default) and the preferred expense / income ledger (heads the residual's candidates). Local
 *  data — consulted even with AI off, but only while Settings → AI → "use memory" is on. */
export function categoriseMemory(db: DB): CategoriseMemory | null {
  if (!getAiSettings(db).useMemory) return null
  const ctx = memoryContextFor(db, true)
  if (!ctx.entries.length) return null
  return {
    party: (id) => {
      const m = ctx.forParty(id)
      return m ? { memoryId: m.id, text: renderPartyName(m.text, m.labels.party ?? null) } : null
    },
    preferred: (side) => {
      const p = ctx.preferredLedger(side === 'withdrawal' ? 'expense' : 'income')
      if (!p) return null
      const m = ctx.entries.find((e) => e.id === p.memoryId)
      return { ledgerId: p.ledgerId, memoryId: p.memoryId, text: m?.text ?? `${side === 'withdrawal' ? 'Expense' : 'Income'} ledger ${p.name ?? ''}`.trim() }
    }
  }
}

function hintsFrom(map: Map<number, { source: 'rule' | 'learned'; ruleId: number; ledgerId: number; partyLedgerId: number | null; status: string; confidence: number; evidence: number }>): Map<number, RuleHint> {
  const out = new Map<number, RuleHint>()
  for (const [lineId, s] of map) {
    out.set(lineId, {
      source: s.source, ruleId: s.ruleId, ledgerId: s.ledgerId, partyLedgerId: s.partyLedgerId,
      status: s.status === 'manual' ? 'manual' : s.status === 'accepted' ? 'accepted' : s.status === 'ignored' ? 'ignored' : 'candidate',
      confidence: s.confidence,
      why: s.source === 'rule' ? 'a bank rule' : `a learned rule (${s.evidence} earlier match${s.evidence === 1 ? '' : 'es'})`
    })
  }
  return out
}

export async function categoriseStatement(deps: CategoriseDeps, bankLedgerId: number, opts: { lineIds?: number[]; useAi?: boolean } = {}): Promise<StatementCategorisation> {
  const { db } = deps
  if (!bankLedgers(db).some((b) => b.id === bankLedgerId)) throw new Error('That ledger is not a bank account')
  const inputs = categoriseInputs(db, bankLedgerId, opts.lineIds)
  const ledgers = catLedgers(db)
  let proposals = categoriseLines(inputs.lines, {
    history: inputs.history, ledgers, bankLedgerId, hints: hintsFrom(inputs.hints), memory: (deps.memory === undefined ? categoriseMemory(db) : deps.memory) ?? undefined
  })
  let aiUsed = false
  let aiNote: string | null = null
  let rejected = 0
  const residual = proposals.filter((p) => p.source === 'none' && p.candidates.length)
  if (residual.length && opts.useAi !== false) {
    if (!deps.ask) aiNote = 'The assistant is off — only the rules and history were used'
    else {
      const res = await deps.ask(inputs.lines, residual)
      aiUsed = true
      const applied = applyModelPicks(proposals, res, ledgers)
      proposals = applied.proposals
      rejected = applied.rejected.length
    }
  }
  const byId = new Map(ledgers.map((l) => [l.id, l.name]))
  const lineBy = new Map(inputs.lines.map((l) => [l.id, l]))
  const rows: StatementCategoryRow[] = proposals.map((p) => {
    const l = lineBy.get(p.lineId)!
    return {
      lineId: p.lineId, date: l.date, description: l.description, reference: l.reference, side: l.side, amount: l.amount,
      ledgerId: p.ledgerId, ledgerName: p.ledgerId ? (byId.get(p.ledgerId) ?? null) : null, partyLedgerId: p.partyLedgerId, kind: p.kind,
      source: p.source, confidence: p.confidence, why: p.why, oldestBillsFirst: p.oldestBillsFirst, candidates: p.candidates,
      ...(p.memoryId ? { memoryId: p.memoryId } : {})
    }
  })
  return { rows, aiUsed, aiNote, rejected }
}

/** An open draft already made for this statement line (one per line). */
export function openDraftForLine(db: DB, statementLineId: number): number | null {
  const r = db
    .prepare("SELECT id FROM ai_drafts WHERE status = 'open' AND json_extract(payload_json, '$.bankLine.statementLineId') = ? ORDER BY id LIMIT 1")
    .get(statementLineId) as { id: number } | undefined
  return r?.id ?? null
}

/** Accepted rows → drafts (draft_voucher's builder), each linked to its statement line. */
export function acceptCategories(
  db: DB,
  company: CompanyInfo,
  today: string,
  bankLedgerId: number,
  items: { lineId: number; ledgerId: number; kind?: 'payment' | 'receipt' | 'contra'; oldestBillsFirst?: boolean; narration?: string; memoryId?: number }[]
): CategoriseAcceptResult {
  if (!bankLedgers(db).some((b) => b.id === bankLedgerId)) throw new Error('That ledger is not a bank account')
  const open = new Map(categoriseInputs(db, bankLedgerId).lines.map((l) => [l.id, l]))
  const ledgers = new Map(catLedgers(db).map((l) => [l.id, l]))
  const result: CategoriseAcceptResult = { drafts: [], failed: [] }
  for (const it of items) {
    try {
      const line = open.get(it.lineId)
      if (!line) throw new Error('This statement line is no longer open (matched, ignored or removed)')
      const existing = openDraftForLine(db, line.id)
      if (existing) throw new Error(`Draft #${existing} is already open for this line — review or discard it first`)
      const ledger = ledgers.get(it.ledgerId)
      if (!ledger) throw new Error('Ledger not found')
      if (ledger.id === bankLedgerId) throw new Error('Pick a ledger other than this bank account')
      // The voucher kind follows the line's side and the ledger, decided HERE — never the
      // renderer's word (a "payment" for a deposit would book money the wrong way).
      const kind = kindFor(ledger, line.side)
      if (it.kind && it.kind !== kind) throw new Error(`A ${line.side} to ${ledger.name} is a ${kind}, not a ${it.kind}`)
      const amount = paiseToRupeeText(line.amount)
      const narration = (it.narration ?? line.description).trim().slice(0, 500) || undefined
      const party = ledger.kind === 'debtor' || ledger.kind === 'creditor'
      const input: AccountingDraftInput =
        party && kind !== 'contra' && it.oldestBillsFirst !== false
          ? { kind, partyLedgerId: ledger.id, accountLedgerId: bankLedgerId, amount, oldestBillsFirst: true, date: line.date, narration, reference: line.reference.slice(0, 120) || undefined }
          : {
              kind, date: line.date, narration, reference: line.reference.slice(0, 120) || undefined,
              lines:
                line.side === 'withdrawal'
                  ? [{ ledgerId: ledger.id, drCr: 'dr', amount }, { ledgerId: bankLedgerId, drCr: 'cr', amount }]
                  : [{ ledgerId: bankLedgerId, drCr: 'dr', amount }, { ledgerId: ledger.id, drCr: 'cr', amount }]
            }
      const w = new DraftWork(loadMasters(db, company, today))
      let built
      try {
        built = buildAccountingDraft(w, input)
      } catch (err) {
        if (err instanceof NeedsClarification) throw new Error(w.clarifications.map((c) => c.question).join(' '))
        throw err
      }
      // WP 5.6: a proposal resting on a memory cites it on the draft (an assumption the user sees),
      // only while that memory is active and still points at the ledger accepted.
      const mem = it.memoryId ? getMemory(db, it.memoryId) : null
      const memUsed = mem && mem.status === 'active' && (mem.data?.partyLedgerId === ledger.id || (mem.kind === 'preference' && mem.data?.ledgerId === ledger.id)) ? mem : null
      const assumptions = [...(built.payload.assumptions ?? []), ...(memUsed ? [memoryWhy({ memoryId: memUsed.id, text: renderPartyName(memUsed.text, memUsed.labels.party ?? null) })] : [])]
      // The draft must post exactly this line on this bank, on its side (as draft_voucher's
      // statementLineId does) — checked for every accepted row.
      const linked = withBankLine(db, built, line.id)
      const payload = { ...linked.payload, assumptions }
      const d = db.transaction(() => {
        const draft = insertDraft(db, { threadId: null, messageId: null, summary: built.summary, payload, unrequested: false, source: 'capture', origin: `Statement line ${line.date}` })
        writeAudit(db, 'ai_draft', draft.id, 'create', null, { tool: 'categorise_statement', statementLineId: line.id, bankLedgerId, summary: built.summary, payload, source: 'capture' })
        if (memUsed) markMemoriesUsed(db, [memUsed.id])
        return draft
      })()
      result.drafts.push({ lineId: line.id, draftId: d.id, summary: built.summary })
    } catch (err) {
      result.failed.push({ lineId: it.lineId, error: (err as Error).message })
    }
  }
  return result
}

/** draft_voucher with `statementLineId` (WP 5.4): the draft must account for that open line —
 *  a line on its bank ledger, on the line's side (deposit = debit), for exactly its amount. */
export function withBankLine<T extends { payload: { lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]; bankLine?: { bankLedgerId: number; statementLineId: number } } }>(
  db: DB,
  built: T,
  statementLineId: number
): T {
  const line = db
    .prepare(
      `SELECT l.id, l.bank_ledger_id AS bank, l.deposit, l.withdrawal, l.ignored_at AS ignored,
              EXISTS (SELECT 1 FROM bank_statement_matches m JOIN vouchers v ON v.id = m.voucher_id
                      WHERE m.statement_line_id = l.id AND v.deleted_at IS NULL AND v.post_dated = 0 AND v.is_optional = 0) AS matched
       FROM bank_statement_lines l WHERE l.id = ?`
    )
    .get(statementLineId) as { id: number; bank: number; deposit: number; withdrawal: number; ignored: string | null; matched: number } | undefined
  if (!line) throw new Error(`There is no statement line ${statementLineId}`)
  if (line.ignored || line.matched) throw new Error(`Statement line ${statementLineId} is already ${line.ignored ? 'ignored' : 'matched'}`)
  const existing = openDraftForLine(db, statementLineId)
  if (existing) throw new Error(`Draft #${existing} is already open for statement line ${statementLineId}`)
  const side: 'dr' | 'cr' = line.deposit > 0 ? 'dr' : 'cr'
  const amount = line.deposit || line.withdrawal
  const onBank = built.payload.lines.filter((l) => l.ledgerId === line.bank)
  if (!onBank.some((l) => l.drCr === side && l.amount === amount)) {
    const name = (db.prepare('SELECT name FROM ledgers WHERE id = ?').get(line.bank) as { name: string } | undefined)?.name ?? 'the bank'
    throw new Error(`Statement line ${statementLineId} is a ${line.deposit > 0 ? 'deposit' : 'withdrawal'} of ${formatPaise(amount, { symbol: true })} on ${name}; the voucher must ${side === 'dr' ? 'debit' : 'credit'} ${name} with exactly that amount`)
  }
  return { ...built, payload: { ...built.payload, bankLine: { bankLedgerId: line.bank, statementLineId } } }
}
