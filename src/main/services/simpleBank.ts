// Bank, simple (WP 9.6, plan 2026-10-13 §3 "Bank"): the simple Bank screen's reads and its one
// write. Nothing here is new banking logic — it composes the WP 4.1 / 5.4 / 9.1 services:
//
// - bankSetup: the bank accounts (banking.bankLedgers — what the statement import accepts) and
//   every account's class (ai/ledgerClass.ts), simple category and owner flag, so a suggestion can
//   be read as a plain choice (shared/simple/bank.ts `choiceForAccount`);
// - bankView: the statement lines of one bank (bankImport.statementWorkspace, matched lines kept
//   as "Done"); for each open line the matcher's proposal (an entry already in the books) or the
//   WP 5.4 categoriser's suggestion WITHOUT the model (rules → WP 5.6 memory → narration history →
//   named party: categoriseStatement with no asker — the model is only asked from the screen, when
//   AI is ready, through the existing bankImport:categorise); and the one sentence's facts from
//   banking.brs as on the latest statement line (nothing stored);
// - acceptLines: each accepted line in its OWN transaction — "Already recorded" confirms the
//   matcher's proposal (bankImport.confirmMatches); every other choice is a WP 9.1 intent saved by
//   simplePost.postIntent (saveVoucher: lock, closed year, credit hold … all apply) and its line
//   then reconciled by bankImport.reconcileSavedDraft — the same call a saved categoriser draft
//   makes (a CONFIRMED match: an import undo keeps the voucher; the narration is learned). A line
//   that can't be reconciled rolls its entry back, so nothing is left half done. Failures are
//   reported per line with the structured error (plain message on its row).
import type { DB } from '../db/connection'
import { companyLanguage } from '../i18n'
import type { CompanyInfo } from '@shared/domain'
import { toPlainDate } from '@shared/dates'
import { AppError, structuredOf } from '@shared/errors'
import { narrationPrefix } from '@shared/capture/categorise'
import {
  becauseFor, choiceFitsSide, choiceForAccount, endOfDayBalance, intentForChoice, repeatedLines,
  type BankAcceptItem, type BankAcceptResult, type BankAccountInfo, type BankLineFacts, type BankLineView, type BankSetup, type BankSuggestion, type BankView
} from '@shared/simple/bank'
import { ledgerClassifier } from '../ai/ledgerClass'
import { categoriseStatement } from '../ai/capture/bankCategorise'
import { bankLedgers, brs } from './banking'
import { confirmMatches, reconcileSavedDraft, statementWorkspace } from './bankImport'
import { descendantIdsByName } from './masters'
import { postIntent } from './simplePost'
import { IN_BOOKS } from './vouchers'

function assertBank(db: DB, bankLedgerId: number): string {
  const b = bankLedgers(db).find((x) => x.id === bankLedgerId)
  if (!b) throw new AppError('simple_bank_not_bank', 'That account is not a bank account', { field: 'bank' })
  return b.name
}

export function bankAccounts(db: DB): BankAccountInfo[] {
  const cls = ledgerClassifier(db)
  const owner = descendantIdsByName(db, ['Capital Account'])
  const rows = db.prepare('SELECT id, name, group_id AS groupId, simple_category AS category FROM ledgers ORDER BY name COLLATE NOCASE').all() as {
    id: number; name: string; groupId: number; category: string | null
  }[]
  return rows.map((r) => ({ id: r.id, name: r.name, cls: cls.cls(r.id), category: r.category, owner: owner.has(r.groupId) }))
}

export function bankSetup(db: DB): BankSetup {
  const accounts = bankAccounts(db)
  const byCategory = (key: string, name: string): number | null =>
    accounts.find((a) => a.category === key)?.id ?? accounts.find((a) => a.name.toLowerCase() === name.toLowerCase())?.id ?? null
  return {
    banks: bankLedgers(db),
    accounts,
    ids: {
      bankCharges: byCategory('bank_charges', 'Bank charges'),
      interest: byCategory('interest_received', 'Interest received'),
      ownerMoney: byCategory('owner_capital', "Owner's money"),
      drawings: byCategory('owner_drawings', "Owner's drawings")
    }
  }
}

/** The simple Bank screen for one bank account: its lines, suggestions and the sentence's facts. */
export async function bankView(db: DB, bankLedgerId: number, today: string): Promise<BankView> {
  const bankName = assertBank(db, bankLedgerId)
  const ws = statementWorkspace(db, bankLedgerId, { includeDone: true })
  const accounts = new Map(bankAccounts(db).map((a) => [a.id, a]))
  // The WP 5.4 chain without the model (no asker, useAi false): rules → memory → history → party.
  const cat = await categoriseStatement({ db, today, ask: null }, bankLedgerId, { useAi: false })
  const catBy = new Map(cat.rows.map((r) => [r.lineId, r]))

  const repeats = repeatedLines(ws.lines.map((l) => ({ id: l.id, date: l.date, side: l.side, amount: l.amount, reference: l.reference, description: l.description })))
  const lines: BankLineView[] = ws.lines.map((l) => {
    const base = { id: l.id, date: l.date, description: l.description, reference: l.reference, side: l.side, amount: l.amount }
    if (l.status === 'matched') return { ...base, status: 'done', done: l.matched.map((m) => ({ voucherId: m.voucherId, name: m.particulars })), suggestion: null, match: null }
    if (l.status === 'ignored') return { ...base, status: 'left_out', done: [], suggestion: null, match: null }
    let suggestion: BankSuggestion | null = null
    let match: BankLineView['match'] = null
    const p = l.proposal
    if (p && !p.ambiguous && p.entries.length) {
      const first = p.entries[0]!
      match = { name: first.particulars, date: first.date, amount: p.entries.reduce((s, e) => s + e.amount, 0) }
      suggestion = { choice: { kind: 'existing' }, source: 'match', because: becauseFor('match', { name: first.particulars, date: toPlainDate(first.date, companyLanguage(db)) }) }
    } else {
      const row = catBy.get(l.id)
      const acc = row?.ledgerId ? accounts.get(row.ledgerId) : undefined
      const choice = row && row.source !== 'none' ? choiceForAccount(acc, l.side, bankLedgerId) : null
      // A repeated row gets no pre-selected answer (the user says whether it is real money).
      if (row && acc && choice && row.source !== 'none' && !repeats.has(l.id)) {
        suggestion = { choice, source: row.source, because: becauseFor(row.source, { name: acc.name, words: narrationPrefix(l.description) }) }
      }
    }
    return { ...base, status: 'open', done: [], suggestion, match, ...(repeats.has(l.id) ? { repeat: true } : {}) }
  })

  // The sentence: the BRS as on the latest statement line (entries the bank has not shown yet),
  // and the statement lines up to then that still need an answer.
  const asOn = ws.lines.reduce<string | null>((m, l) => (m == null || l.date > m ? l.date : m), null)
  let differ = 0
  let difference = 0
  let bankBalance: number | null = null
  let statementBalance: number | null = null
  if (asOn) {
    const r = brs(db, bankLedgerId, asOn)
    differ = r.uncredited.length + r.unpresented.length
    difference = r.uncreditedTotal - r.unpresentedTotal
    bankBalance = r.bankBalance
    // WP 10.8: the balance the statement itself prints at the end of that day (if it prints one
    // on that day — an earlier day's balance is never compared with the books as on this one).
    // Ignored lines count: the bank's balance moved with them whether or not the books record them.
    const imp = db
      .prepare('SELECT import_id AS id FROM bank_statement_lines WHERE bank_ledger_id = ? AND date = ? AND balance IS NOT NULL ORDER BY import_id DESC LIMIT 1')
      .get(bankLedgerId, asOn) as { id: number } | undefined
    if (imp) {
      const day = db
        .prepare('SELECT line_no AS lineNo, deposit, withdrawal, balance FROM bank_statement_lines WHERE import_id = ? AND date = ?')
        .all(imp.id, asOn) as { lineNo: number; deposit: number; withdrawal: number; balance: number | null }[]
      const ends = db
        .prepare('SELECT (SELECT date FROM bank_statement_lines WHERE import_id = ? ORDER BY line_no LIMIT 1) AS first, (SELECT date FROM bank_statement_lines WHERE import_id = ? ORDER BY line_no DESC LIMIT 1) AS last')
        .get(imp.id, imp.id) as { first: string; last: string }
      statementBalance = endOfDayBalance(day, ends.first > ends.last)
    }
  }
  const open = lines.filter((l) => l.status === 'open' && asOn != null && l.date <= asOn).length
  const last = ws.imports[0]
  return {
    bankLedgerId,
    bankName,
    lines,
    sentence: { asOn, differ, difference, open, statementBalance, bankBalance },
    lastImport: last ? { id: last.id, fileName: last.fileName, lineCount: last.lineCount } : null
  }
}

interface LineRow {
  id: number
  date: string
  description: string
  reference: string
  deposit: number
  withdrawal: number
  ignored: string | null
}

/** Vouchers in the books this statement line is matched to. */
const matchedVouchers = (db: DB, lineId: number): number[] =>
  (db
    .prepare(`SELECT m.voucher_id AS id FROM bank_statement_matches m JOIN vouchers v ON v.id = m.voucher_id WHERE m.statement_line_id = ? AND ${IN_BOOKS}`)
    .all(lineId) as { id: number }[]).map((r) => r.id)

/** The vouchers an earlier simple:post with this clientId saved (a retry of the same accept). */
function postedBefore(db: DB, clientId: string): number[] {
  const r = db.prepare('SELECT voucher_ids_json AS ids FROM simple_posts WHERE client_id = ?').get(clientId) as { ids: string } | undefined
  return r ? (JSON.parse(r.ids) as { voucherId: number }[]).map((e) => e.voucherId) : []
}

function acceptOne(db: DB, company: CompanyInfo, bankLedgerId: number, item: BankAcceptItem, today: string): number[] {
  const row = db
    .prepare('SELECT id, date, description, reference, deposit, withdrawal, ignored_at AS ignored FROM bank_statement_lines WHERE id = ? AND bank_ledger_id = ?')
    .get(item.lineId, bankLedgerId) as LineRow | undefined
  if (!row || row.ignored) throw new AppError('simple_bank_line_gone', 'This bank line is no longer open (removed or left out)', { field: 'line' })
  const matched = matchedVouchers(db, row.id)
  if (matched.length) {
    // A retry of an accept that already went through: the same entries, nothing new.
    const before = postedBefore(db, item.clientId)
    if (before.some((id) => matched.includes(id))) return before
    throw new AppError('simple_bank_line_done', 'This bank line is already matched to an entry', { field: 'line' })
  }
  const line: BankLineFacts = {
    id: row.id, date: row.date, description: row.description, reference: row.reference,
    side: row.deposit > 0 ? 'deposit' : 'withdrawal', amount: row.deposit || row.withdrawal
  }
  if (!choiceFitsSide(item.choice.kind, line.side)) {
    throw new AppError('simple_bank_wrong_choice', `That answer does not fit money ${line.side === 'deposit' ? 'coming in' : 'going out'}`, { field: 'choice' })
  }
  if (item.choice.kind === 'existing') {
    // The matcher's own proposal, confirmed as the statement workspace would (no new match logic).
    const wl = statementWorkspace(db, bankLedgerId).lines.find((l) => l.id === row.id)
    const p = wl?.proposal
    if (!p || p.ambiguous || !p.entries.length) throw new AppError('simple_bank_no_match', 'No entry in the books matches this bank line any more', { field: 'choice' })
    const voucherIds = [...new Set(p.entries.map((e) => e.voucherId))]
    confirmMatches(db, bankLedgerId, [{ lineIds: p.lineIds, voucherIds, voucherLineIds: p.entries.map((e) => e.lineId) }], 0)
    return voucherIds
  }
  const intent = intentForChoice(line, item.choice, bankLedgerId, item.clientId)
  if (!intent) throw new AppError('simple_bank_wrong_choice', 'Nothing to save for this answer', { field: 'choice' })
  const posted = postIntent(db, company, intent, today)
  const voucherId = posted.entries.find((e) => e.role === 'money')?.voucherId ?? posted.voucherIds[0]!
  const rec = reconcileSavedDraft(db, bankLedgerId, row.id, voucherId)
  if (!rec.ok) throw new AppError('simple_bank_not_matched', `The entry was not saved: ${rec.reason}`, { field: 'line' })
  return posted.voucherIds
}

/** simple:bank:accept — every item in its own transaction; what failed is reported on its line. */
export function acceptLines(db: DB, company: CompanyInfo, bankLedgerId: number, items: BankAcceptItem[], today: string): BankAcceptResult {
  assertBank(db, bankLedgerId)
  const out: BankAcceptResult = { done: [], failed: [] }
  for (const item of items) {
    try {
      const voucherIds = db.transaction(() => acceptOne(db, company, bankLedgerId, item, today))()
      out.done.push({ lineId: item.lineId, voucherIds })
    } catch (err) {
      out.failed.push({ lineId: item.lineId, error: { message: err instanceof Error ? err.message : String(err), ...(structuredOf(err) ?? {}) } })
    }
  }
  return out
}
