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
import type { Language } from '@shared/i18n'
import type { CompanyInfo } from '@shared/domain'
import { toPlainDate } from '@shared/dates'
import { AppError, structuredOf } from '@shared/errors'
import { chargesGstOn, gstRegistrationOf } from '@shared/gst/registration'
import { validateGstin } from '@shared/gst/validate'
import { moneyOutFieldOf } from '@shared/simple/money'
import { narrationPrefix } from '@shared/capture/categorise'
import {
  becauseFor, choiceFitsSide, choiceForAccount, endOfDayBalance, gstBillComplete, intentForChoice, repeatedLines,
  type BankAcceptItem, type BankGstContext, type BankAcceptResult, type BankAccountInfo, type BankLineFacts, type BankLineView, type BankSetup, type BankSuggestion, type BankView
} from '@shared/simple/bank'
import { ledgerClassifier } from '../ai/ledgerClass'
import { categoriseStatement } from '../ai/capture/bankCategorise'
import { bankLedgers, brs } from './banking'
import { confirmMatches, reconcileSavedDraft, statementWorkspace } from './bankImport'
import { createLedger, descendantIdsByName } from './masters'
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
/** `lang` = the reader's language for the dates in the "because …" (default the company's). */
export async function bankView(db: DB, bankLedgerId: number, today: string, lang: Language = companyLanguage(db)): Promise<BankView> {
  const bankName = assertBank(db, bankLedgerId)
  const ws = statementWorkspace(db, bankLedgerId, { includeDone: true })
  const accounts = new Map(bankAccounts(db).map((a) => [a.id, a]))
  // The WP 5.4 chain without the model (no asker, useAi false): rules → memory → history → party.
  const cat = await categoriseStatement({ db, today, ask: null }, bankLedgerId, { useAi: false })
  const catBy = new Map(cat.rows.map((r) => [r.lineId, r]))

  // WP 10.x: each line's per-account identity (import_hash — date, signed amount, narration,
  // same-day occurrence), stable across a re-import, so the screen can remember "Skip for now".
  const keys = new Map(
    (db.prepare('SELECT id, import_hash AS h FROM bank_statement_lines WHERE bank_ledger_id = ?').all(bankLedgerId) as { id: number; h: string }[]).map((r) => [r.id, r.h])
  )
  const repeats = repeatedLines(ws.lines.map((l) => ({ id: l.id, date: l.date, side: l.side, amount: l.amount, reference: l.reference, description: l.description })))
  const lines: BankLineView[] = ws.lines.map((l) => {
    const key = keys.get(l.id)
    const base = { id: l.id, date: l.date, description: l.description, reference: l.reference, side: l.side, amount: l.amount, ...(key ? { key } : {}) }
    if (l.status === 'matched') return { ...base, status: 'done', done: l.matched.map((m) => ({ voucherId: m.voucherId, name: m.particulars })), suggestion: null, match: null }
    if (l.status === 'ignored') return { ...base, status: 'left_out', done: [], suggestion: null, match: null }
    let suggestion: BankSuggestion | null = null
    let match: BankLineView['match'] = null
    const p = l.proposal
    if (p && !p.ambiguous && p.entries.length) {
      const first = p.entries[0]!
      match = { name: first.particulars, date: first.date, amount: p.entries.reduce((s, e) => s + e.amount, 0) }
      suggestion = { choice: { kind: 'existing' }, source: 'match', because: becauseFor('match', { name: first.particulars, date: toPlainDate(first.date, lang) }) }
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

/** A bank charge with GST: the bank as a supplier — the creditor with the GSTIN given, else the
 *  one named "<bank> (charges)", else that one added (under Sundry Creditors, with the GSTIN and
 *  its state when given; audited by createLedger, inside the line's transaction). */
function bankAsSupplier(db: DB, bankLedgerId: number, gstinRaw: string | undefined): number {
  const gstin = gstinRaw?.trim().toUpperCase() || null
  if (gstin && !validateGstin(gstin).valid) throw new AppError('simple_bank_bad_gstin', `${gstin} is not a GSTIN`, { field: 'gstin' })
  const creditors = descendantIdsByName(db, ['Sundry Creditors'])
  const rows = db.prepare('SELECT id, name, group_id AS groupId, gstin FROM ledgers').all() as { id: number; name: string; groupId: number; gstin: string | null }[]
  const own = rows.filter((r) => creditors.has(r.groupId))
  const byGstin = gstin ? own.find((r) => r.gstin?.toUpperCase() === gstin) : undefined
  if (byGstin) return byGstin.id
  const bank = rows.find((r) => r.id === bankLedgerId)!
  const name = `${bank.name} (charges)`
  const byName = own.find((r) => r.name.toLowerCase() === name.toLowerCase())
  if (byName) return byName.id
  const groupId = (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Creditors'").get() as { id: number }).id
  return createLedger(db, {
    name, groupId, openingBalance: 0, gstin, stateCode: gstin ? gstin.slice(0, 2) : null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

/** A refusal of the purchase a GST bill becomes, on the bank line's own questions (Money out's
 *  remap: its party is the bill's supplier, its account the expense). */
function onLineFields(err: unknown): never {
  if (!(err instanceof AppError)) throw err
  const at = (f: string | undefined): string | undefined => moneyOutFieldOf(f, true)
  throw new AppError(err.code, err.message, {
    ...(at(err.field) ? { field: at(err.field) } : {}),
    ...(err.params ? { params: err.params } : {}),
    ...(err.issues ? { issues: err.issues.map((i) => ({ ...i, ...(at(i.field) ? { field: at(i.field) } : {}) })) } : {})
  })
}

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
  // A GST bill on a bank expense / the GST on a bank charge: Money out's purchase intent.
  const c = item.choice
  let gst: BankGstContext | undefined
  if ((c.kind === 'expense' || c.kind === 'charges') && c.gstBill) {
    if (!gstBillComplete(c)) throw new AppError('simple_bank_bill_incomplete', 'Say who the GST bill is from, its number and its GST rate', { field: 'gstBill' })
    const stateOf = db.prepare('SELECT state_code AS s FROM ledgers WHERE id = ?')
    const facts = gstRegistrationOf(company)
    gst = {
      facts,
      companyStateCode: company.stateCode,
      supplierState: (id) => (stateOf.get(id) as { s: string | null } | undefined)?.s ?? null,
      // The bank becomes a supplier only when the line's date charges GST (WP 8.0): on any other
      // date the answer is the plain payment, and no "<bank> (charges)" creditor is added for it.
      chargesSupplierId: c.kind === 'charges' && chargesGstOn(facts, line.date) ? bankAsSupplier(db, bankLedgerId, c.gstBill.gstin) : null
    }
  }
  const intent = intentForChoice(line, c, bankLedgerId, item.clientId, gst)
  if (!intent) throw new AppError('simple_bank_wrong_choice', 'Nothing to save for this answer', { field: 'choice' })
  let posted: ReturnType<typeof postIntent>
  try {
    posted = postIntent(db, company, intent, today)
  } catch (err) {
    if (intent.kind === 'purchase') onLineFields(err)
    throw err
  }
  // The money that left the bank: the entry itself, or a GST bill's payment.
  const voucherId = posted.entries.find((e) => e.role === 'money' || e.role === 'payment')?.voucherId ?? posted.voucherIds[0]!
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
