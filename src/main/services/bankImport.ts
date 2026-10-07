// Bank statement import workspace (WP 4.1): parse any supported format (shared/bankFormats),
// keep the statement lines (deduplicated per bank ledger by import_hash), propose matches against
// open bank-ledger entries (shared/bankMatch), confirm them in bulk (bank date set, audited),
// create vouchers in bulk from unmatched lines through saveVoucher, learn rules from both, and
// undo the last import. The stateless CSV import in banking.ts stays for the older flow.
import type { DB } from '../db/connection'
import type { PreviewLine, StatementPreview, CommitResult, ImportSummary, WorkspaceEntry, LineSuggestion, WorkspaceLine, Workspace, LearnedRuleRecord, CreateResult, LearnedRuleEdit, CreateFromLineInput, MatchGroupInput, WorkspaceQuery, StatementSource } from '@shared/bankTypes'
import {
  base64ToBytes, importHashes, parseStatementFile, type BankFormatId, type ImportProfile, type ParsedStatement, type StatementLine
} from '@shared/bankFormats'
import {
  DEFAULT_MATCH_OPTIONS, learn, proposeMatches, renderNarration, ruleConfidence, suggestLearned, validateGroup,
  type LearnedRule, type LearnedStatus, type MatchEntry, type MatchLine, type MatchOptions, type MatchProposal, type Side
} from '@shared/bankMatch'
import { matchRules, type RuleRow } from '@shared/bankRules'
import { writeAudit } from './audit'
import { bankLedgers, listRules, recordRuleHit } from './banking'
import { cashBankGroupIds } from './masters'
import { IN_BOOKS, deleteVoucher, getVoucher, saveVoucher } from './vouchers'

// ---------- profiles ----------

interface ProfileRow {
  delimiter: string; encoding: string; header_row: number; date_format: string; date_col: number; value_date_col: number | null
  desc_cols: string; ref_col: number | null; amount_mode: string; debit_col: number | null; credit_col: number | null
  amount_col: number | null; flag_col: number | null; balance_col: number | null; signed_negative_is_deposit: number
}

export function getImportProfile(db: DB, bankLedgerId: number, format: 'csv' | 'xlsx'): ImportProfile | null {
  const r = db.prepare('SELECT * FROM bank_import_profiles WHERE bank_ledger_id = ? AND format = ?').get(bankLedgerId, format) as ProfileRow | undefined
  if (!r) return null
  return {
    delimiter: r.delimiter as ImportProfile['delimiter'],
    encoding: r.encoding as ImportProfile['encoding'],
    headerRow: r.header_row,
    dateFormat: r.date_format as ImportProfile['dateFormat'],
    dateCol: r.date_col,
    valueDateCol: r.value_date_col,
    descCols: JSON.parse(r.desc_cols) as number[],
    refCol: r.ref_col,
    amountMode: r.amount_mode as ImportProfile['amountMode'],
    debitCol: r.debit_col,
    creditCol: r.credit_col,
    amountCol: r.amount_col,
    flagCol: r.flag_col,
    balanceCol: r.balance_col,
    signedNegativeIsDeposit: !!r.signed_negative_is_deposit
  }
}

export function saveImportProfile(db: DB, bankLedgerId: number, format: 'csv' | 'xlsx', p: ImportProfile): ImportProfile {
  assertBankLedger(db, bankLedgerId)
  const before = getImportProfile(db, bankLedgerId, format)
  db.prepare(
    `INSERT INTO bank_import_profiles (bank_ledger_id, format, delimiter, encoding, header_row, date_format, date_col, value_date_col,
       desc_cols, ref_col, amount_mode, debit_col, credit_col, amount_col, flag_col, balance_col, signed_negative_is_deposit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (bank_ledger_id, format) DO UPDATE SET delimiter = excluded.delimiter, encoding = excluded.encoding,
       header_row = excluded.header_row, date_format = excluded.date_format, date_col = excluded.date_col,
       value_date_col = excluded.value_date_col, desc_cols = excluded.desc_cols, ref_col = excluded.ref_col,
       amount_mode = excluded.amount_mode, debit_col = excluded.debit_col, credit_col = excluded.credit_col,
       amount_col = excluded.amount_col, flag_col = excluded.flag_col, balance_col = excluded.balance_col,
       signed_negative_is_deposit = excluded.signed_negative_is_deposit, updated_at = excluded.updated_at`
  ).run(
    bankLedgerId, format, p.delimiter, p.encoding, p.headerRow, p.dateFormat, p.dateCol, p.valueDateCol, JSON.stringify(p.descCols),
    p.refCol, p.amountMode, p.debitCol, p.creditCol, p.amountCol, p.flagCol, p.balanceCol, p.signedNegativeIsDeposit ? 1 : 0
  )
  const id = (db.prepare('SELECT id FROM bank_import_profiles WHERE bank_ledger_id = ? AND format = ?').get(bankLedgerId, format) as { id: number }).id
  writeAudit(db, 'bank_import_profile', id, before ? 'update' : 'create', before ? { bankLedgerId, format, ...before } : null, { bankLedgerId, format, ...p })
  return p
}

function assertBankLedger(db: DB, id: number): void {
  if (!bankLedgers(db).some((b) => b.id === id)) throw new Error('That ledger is not a bank account')
}

// ---------- preview / commit ----------




function parseSource(db: DB, bankLedgerId: number, src: StatementSource): { parsed: ParsedStatement & { grid: string[][] | null; profile: ImportProfile | null }; profileSource: StatementPreview['profileSource'] } {
  const bytes = src.base64 != null ? base64ToBytes(src.base64) : undefined
  let profileSource: StatementPreview['profileSource'] = src.profile ? 'given' : null
  let profile = src.profile ?? null
  // A saved mapping applies when the payload doesn't bring one (tabular formats only).
  const probe = (): BankFormatId => src.format ?? parseStatementFile({ fileName: src.fileName, bytes, text: bytes ? undefined : src.text, format: undefined, profile: null }).format
  if (!profile && (src.format ?? null) !== 'pasted') {
    const format = probe()
    if (format === 'csv' || format === 'xlsx') {
      const saved = getImportProfile(db, bankLedgerId, format)
      if (saved) {
        profile = saved
        profileSource = 'saved'
      }
    }
  }
  const parsed = parseStatementFile({ fileName: src.fileName, bytes, text: bytes ? undefined : src.text, format: src.format, profile })
  if (!profileSource && parsed.profile) profileSource = 'detected'
  return { parsed, profileSource }
}

export function previewStatement(db: DB, bankLedgerId: number, src: StatementSource): StatementPreview {
  assertBankLedger(db, bankLedgerId)
  const { parsed, profileSource } = parseSource(db, bankLedgerId, src)
  const hashes = importHashes(parsed.lines)
  const known = new Set(
    (db.prepare('SELECT import_hash AS h FROM bank_statement_lines WHERE bank_ledger_id = ?').all(bankLedgerId) as { h: string }[]).map((r) => r.h)
  )
  const lines = parsed.lines.map((l, i) => ({ ...l, lineNo: i + 1, hash: hashes[i]!, duplicate: known.has(hashes[i]!) }))
  const duplicateCount = lines.filter((l) => l.duplicate).length
  return {
    fileName: src.fileName,
    format: parsed.format,
    profile: parsed.profile,
    profileSource,
    grid: parsed.grid ? parsed.grid.slice(0, 40) : null,
    lines,
    newCount: lines.length - duplicateCount,
    duplicateCount,
    warnings: parsed.warnings,
    account: parsed.account,
    openingBalance: parsed.openingBalance,
    closingBalance: parsed.closingBalance
  }
}


/** Store the statement's new lines (duplicates skipped). Saves the tabular mapping for the bank
 *  ledger unless `saveProfile` is false. One audited 'import' row per committed statement. */
export function commitStatement(db: DB, bankLedgerId: number, src: StatementSource, opts: { saveProfile?: boolean } = {}): CommitResult {
  const preview = previewStatement(db, bankLedgerId, src)
  const fresh = preview.lines.filter((l) => !l.duplicate)
  const run = db.transaction((): CommitResult => {
    if (opts.saveProfile !== false && preview.profile && (preview.format === 'csv' || preview.format === 'xlsx')) {
      saveImportProfile(db, bankLedgerId, preview.format, preview.profile)
    }
    if (fresh.length === 0) return { importId: null, inserted: 0, duplicates: preview.duplicateCount }
    const res = db
      .prepare(
        `INSERT INTO bank_statement_imports (bank_ledger_id, format, file_name, line_count, duplicate_count, account, opening_balance, closing_balance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(bankLedgerId, preview.format, preview.fileName.slice(0, 255), fresh.length, preview.duplicateCount, preview.account, preview.openingBalance, preview.closingBalance)
    const importId = Number(res.lastInsertRowid)
    const ins = db.prepare(
      `INSERT INTO bank_statement_lines (import_id, bank_ledger_id, line_no, date, value_date, description, reference, deposit, withdrawal, balance, import_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const l of fresh) {
      ins.run(importId, bankLedgerId, l.lineNo, l.date, l.valueDate, l.description.slice(0, 1000), l.reference.slice(0, 120), l.deposit, l.withdrawal, l.balance, l.hash)
    }
    writeAudit(db, 'bank_statement', importId, 'import', null, {
      bankLedgerId, fileName: preview.fileName, format: preview.format, lines: fresh.length, duplicatesSkipped: preview.duplicateCount
    })
    return { importId, inserted: fresh.length, duplicates: preview.duplicateCount }
  })
  return run()
}

// ---------- workspace ----------


export function listImports(db: DB, bankLedgerId: number): ImportSummary[] {
  return db
    .prepare(
      `SELECT i.id, i.imported_at AS importedAt, i.file_name AS fileName, i.format, i.line_count AS lineCount, i.duplicate_count AS duplicateCount,
              (SELECT COUNT(DISTINCT m.statement_line_id) FROM bank_statement_matches m JOIN bank_statement_lines l ON l.id = m.statement_line_id WHERE l.import_id = i.id) AS matched,
              (SELECT COUNT(*) FROM bank_statement_matches m JOIN bank_statement_lines l ON l.id = m.statement_line_id WHERE l.import_id = i.id AND m.created_voucher = 1) AS created
       FROM bank_statement_imports i WHERE i.bank_ledger_id = ? ORDER BY i.id DESC`
    )
    .all(bankLedgerId) as ImportSummary[]
}

interface LineRow {
  id: number; importId: number; lineNo: number; date: string; valueDate: string | null; description: string; reference: string
  deposit: number; withdrawal: number; balance: number | null; ignoredAt: string | null
}





function openEntries(db: DB, bankLedgerId: number): (WorkspaceEntry & { side: Side; instrumentNo: string | null; partyKey: number | null })[] {
  const rows = db
    .prepare(
      `SELECT vl.id AS lineId, v.id AS voucherId, v.number, vt.name AS voucherType, v.date, vl.dr_cr AS drCr, vl.amount, v.instrument_no AS instrumentNo,
              (SELECT GROUP_CONCAT(DISTINCT l2.name) FROM voucher_lines vl2 JOIN ledgers l2 ON l2.id = vl2.ledger_id
                 WHERE vl2.voucher_id = v.id AND vl2.dr_cr <> vl.dr_cr) AS particulars,
              (SELECT vl3.ledger_id FROM voucher_lines vl3 WHERE vl3.voucher_id = v.id AND vl3.dr_cr <> vl.dr_cr ORDER BY vl3.amount DESC, vl3.id LIMIT 1) AS particularsLedgerId,
              COALESCE(v.party_ledger_id, (SELECT vl4.ledger_id FROM voucher_lines vl4 WHERE vl4.voucher_id = v.id AND vl4.dr_cr <> vl.dr_cr ORDER BY vl4.amount DESC, vl4.id LIMIT 1)) AS partyKey
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vl.ledger_id = ? AND vl.bank_date IS NULL AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(bankLedgerId) as {
      lineId: number; voucherId: number; number: string; voucherType: string; date: string; drCr: 'dr' | 'cr'; amount: number
      instrumentNo: string | null; particulars: string | null; particularsLedgerId: number | null; partyKey: number | null
    }[]
  return rows.map((r) => ({
    voucherId: r.voucherId, lineId: r.lineId, number: r.number, voucherType: r.voucherType, date: r.date, amount: r.amount,
    particulars: r.particulars ?? '', particularsLedgerId: r.particularsLedgerId, side: r.drCr === 'dr' ? 'deposit' : 'withdrawal',
    instrumentNo: r.instrumentNo, partyKey: r.partyKey
  }))
}

interface LearnedRow {
  id: number; direction: Side; tokens: string; ledger_id: number; party_ledger_id: number | null; voucher_kind: string
  narration_template: string | null; hits: number; applied: number; rejected: number; status: LearnedStatus
}

function learnedRules(db: DB): LearnedRule[] {
  return (db.prepare('SELECT * FROM bank_learned_rules ORDER BY id').all() as LearnedRow[]).map((r) => ({
    id: r.id, direction: r.direction, tokens: JSON.parse(r.tokens) as string[], ledgerId: r.ledger_id, partyLedgerId: r.party_ledger_id,
    voucherKind: r.voucher_kind, narrationTemplate: r.narration_template, hits: r.hits, applied: r.applied, rejected: r.rejected, status: r.status
  }))
}

const sideOf = (l: { deposit: number }): Side => (l.deposit > 0 ? 'deposit' : 'withdrawal')

/** Suggest a ledger for an unmatched line: an active manual bank rule wins (explicit intent),
 *  otherwise the best learned rule. */
function suggestionFor(
  line: { description: string; reference: string; date: string; deposit: number; withdrawal: number },
  manual: RuleRow[],
  learned: LearnedRule[],
  names: Map<number, string>,
  minScore: number
): LineSuggestion | null {
  const hit = matchRules([line], manual)[0]
  if (hit) {
    return {
      source: 'rule', ruleId: hit.rule.id, ledgerId: hit.rule.ledgerId, ledgerName: names.get(hit.rule.ledgerId) ?? '', partyLedgerId: null,
      voucherKind: hit.rule.kind, narration: line.description, confidence: 1, evidence: 0, status: 'manual'
    }
  }
  const s = suggestLearned({ description: line.description, side: sideOf(line) }, learned, minScore)
  if (!s) return null
  return {
    source: 'learned', ruleId: s.rule.id, ledgerId: s.rule.ledgerId, ledgerName: names.get(s.rule.ledgerId) ?? '', partyLedgerId: s.rule.partyLedgerId,
    voucherKind: s.rule.voucherKind, narration: renderNarration(s.rule.narrationTemplate, line), confidence: s.score,
    evidence: s.rule.hits + s.rule.applied, status: s.rule.status
  }
}


/** The statement lines of a bank account with proposals for the open ones. Read-only. */
export function statementWorkspace(db: DB, bankLedgerId: number, q: WorkspaceQuery = {}): Workspace {
  assertBankLedger(db, bankLedgerId)
  const opts: MatchOptions = { ...DEFAULT_MATCH_OPTIONS, ...q.options }
  const rows = db
    .prepare(
      `SELECT l.id, l.import_id AS importId, l.line_no AS lineNo, l.date, l.value_date AS valueDate, l.description, l.reference,
              l.deposit, l.withdrawal, l.balance, l.ignored_at AS ignoredAt
       FROM bank_statement_lines l WHERE l.bank_ledger_id = ? ${q.importId ? 'AND l.import_id = ?' : ''}
       ORDER BY l.date, l.import_id, l.line_no`
    )
    .all(...(q.importId ? [bankLedgerId, q.importId] : [bankLedgerId])) as LineRow[]
  const matchRows = db
    .prepare(
      `SELECT m.statement_line_id AS lineId, m.voucher_id AS voucherId, m.created_voucher AS created FROM bank_statement_matches m
       JOIN bank_statement_lines l ON l.id = m.statement_line_id WHERE l.bank_ledger_id = ?`
    )
    .all(bankLedgerId) as { lineId: number; voucherId: number; created: number }[]
  const matchesByLine = new Map<number, { voucherId: number; created: boolean }[]>()
  for (const m of matchRows) matchesByLine.set(m.lineId, [...(matchesByLine.get(m.lineId) ?? []), { voucherId: m.voucherId, created: !!m.created }])

  const open = openEntries(db, bankLedgerId)
  const openLines = rows.filter((r) => !r.ignoredAt && !matchesByLine.has(r.id))
  const proposals = proposeMatches(
    openLines.map((r): MatchLine => ({ id: r.id, date: r.date, amount: r.deposit || r.withdrawal, side: sideOf(r), reference: r.reference, description: r.description })),
    open.map((e): MatchEntry => ({ id: e.lineId, voucherId: e.voucherId, date: e.date, amount: e.amount, side: e.side, instrumentNo: e.instrumentNo, partyName: e.particulars, partyKey: e.partyKey })),
    opts
  )
  const entryByLineId = new Map(open.map((e) => [e.lineId, e]))
  const proposalByLine = new Map<number, MatchProposal>()
  for (const p of proposals) for (const id of p.lineIds) proposalByLine.set(id, p)

  const names = new Map((db.prepare('SELECT id, name FROM ledgers').all() as { id: number; name: string }[]).map((l) => [l.id, l.name]))
  const manual: RuleRow[] = listRules(db)
    .filter((r) => r.active)
    .map((r) => ({ id: r.id, pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind, matchField: r.matchField === 'reference' ? 'reference' : 'description', minAmount: r.minAmount, maxAmount: r.maxAmount }))
  const learned = learnedRules(db)

  const voucherSummary = (voucherId: number): WorkspaceEntry | null => {
    const v = db
      .prepare(
        `SELECT v.id AS voucherId, v.number, vt.name AS voucherType, v.date,
                (SELECT vl.id FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id = ? ORDER BY vl.id LIMIT 1) AS lineId,
                (SELECT COALESCE(SUM(vl.amount), 0) FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id = ?) AS amount,
                (SELECT vl.ledger_id FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id <> ? ORDER BY vl.amount DESC, vl.id LIMIT 1) AS particularsLedgerId
         FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ?`
      )
      .get(bankLedgerId, bankLedgerId, bankLedgerId, voucherId) as (Omit<WorkspaceEntry, 'particulars'> & { lineId: number | null }) | undefined
    if (!v) return null
    return { ...v, lineId: v.lineId ?? 0, particulars: v.particularsLedgerId ? (names.get(v.particularsLedgerId) ?? '') : '' }
  }

  const lines: WorkspaceLine[] = []
  for (const r of rows) {
    const matched = matchesByLine.get(r.id)
    const status: WorkspaceLine['status'] = matched ? 'matched' : r.ignoredAt ? 'ignored' : 'open'
    if (status !== 'open' && !q.includeDone) continue
    const p = status === 'open' ? proposalByLine.get(r.id) : undefined
    lines.push({
      id: r.id,
      importId: r.importId,
      date: r.date,
      valueDate: r.valueDate,
      description: r.description,
      reference: r.reference,
      side: sideOf(r),
      amount: r.deposit || r.withdrawal,
      balance: r.balance,
      status,
      matched: (matched ?? []).flatMap((m) => {
        const s = voucherSummary(m.voucherId)
        return s ? [{ ...s, created: m.created }] : []
      }),
      proposal: p
        ? { kind: p.kind, lineIds: p.lineIds, score: p.score, ambiguous: p.ambiguous, reasons: p.reasons, entries: p.entryIds.map((id) => entryByLineId.get(id)!).map(stripEntry) }
        : null,
      suggestion: status === 'open' && !p ? suggestionFor(r, manual, learned, names, q.minSuggestScore ?? 0.4) : null
    })
  }
  return { lines, imports: listImports(db, bankLedgerId), openEntries: open.map(stripEntry) }
}

const stripEntry = (e: WorkspaceEntry): WorkspaceEntry => ({
  voucherId: e.voucherId, lineId: e.lineId, number: e.number, voucherType: e.voucherType, date: e.date, amount: e.amount,
  particulars: e.particulars, particularsLedgerId: e.particularsLedgerId
})

// ---------- learning ----------

/** Apply one observation to the learned rules (audited per rule touched). */
function observe(db: DB, obs: Parameters<typeof learn>[1]): void {
  const ops = learn(learnedRules(db), obs)
  for (const op of ops) {
    if (op.op === 'create') {
      const res = db
        .prepare(
          `INSERT INTO bank_learned_rules (direction, tokens, ledger_id, party_ledger_id, voucher_kind, narration_template, hits)
           VALUES (?, ?, ?, ?, ?, ?, 1)`
        )
        .run(op.rule.direction, JSON.stringify(op.rule.tokens), op.rule.ledgerId, op.rule.partyLedgerId, safeKind(op.rule.voucherKind), op.rule.narrationTemplate)
      writeAudit(db, 'bank_learned_rule', Number(res.lastInsertRowid), 'create', null, { ...op.rule, hits: 1, learnedFrom: obs.narration })
    } else if (op.op === 'reinforce') {
      const before = db.prepare('SELECT * FROM bank_learned_rules WHERE id = ?').get(op.ruleId)
      db.prepare("UPDATE bank_learned_rules SET hits = hits + 1, tokens = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(op.tokens), op.ruleId)
      writeAudit(db, 'bank_learned_rule', op.ruleId, 'update', before, db.prepare('SELECT * FROM bank_learned_rules WHERE id = ?').get(op.ruleId))
    } else {
      const before = db.prepare('SELECT * FROM bank_learned_rules WHERE id = ?').get(op.ruleId)
      db.prepare("UPDATE bank_learned_rules SET rejected = rejected + 1, updated_at = datetime('now') WHERE id = ?").run(op.ruleId)
      writeAudit(db, 'bank_learned_rule', op.ruleId, 'update', before, db.prepare('SELECT * FROM bank_learned_rules WHERE id = ?').get(op.ruleId))
    }
  }
}

const safeKind = (k: string): string => (['payment', 'receipt', 'contra', 'journal'].includes(k) ? k : 'journal')

/** Counter-ledger, party and kind of a voucher, relative to the bank ledger (for learning). */
function voucherFacts(db: DB, voucherId: number, bankLedgerId: number): { ledgerId: number; partyLedgerId: number | null; kind: string } | null {
  const v = getVoucher(db, voucherId)
  if (!v) return null
  const counter = v.lines.filter((l) => l.ledgerId !== bankLedgerId).sort((a, b) => b.amount - a.amount)[0]
  if (!counter) return null
  const kind = (db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(v.voucherTypeId) as { kind: string } | undefined)?.kind ?? 'journal'
  return { ledgerId: counter.ledgerId, partyLedgerId: v.partyLedgerId, kind }
}


export function listLearnedRules(db: DB): LearnedRuleRecord[] {
  const extra = new Map(
    (db
      .prepare(
        `SELECT r.id, l.name AS ledgerName, p.name AS partyName, r.created_at AS createdAt, r.updated_at AS updatedAt FROM bank_learned_rules r
         JOIN ledgers l ON l.id = r.ledger_id LEFT JOIN ledgers p ON p.id = r.party_ledger_id`
      )
      .all() as { id: number; ledgerName: string; partyName: string | null; createdAt: string; updatedAt: string }[]).map((r) => [r.id, r])
  )
  return learnedRules(db)
    .map((r) => {
      const e = extra.get(r.id)!
      return { ...r, ledgerName: e.ledgerName, partyName: e.partyName, createdAt: e.createdAt, updatedAt: e.updatedAt, confidence: ruleConfidence(r) }
    })
    .sort((a, b) => b.hits + b.applied - (a.hits + a.applied) || a.id - b.id)
}


export function updateLearnedRule(db: DB, id: number, edit: LearnedRuleEdit): LearnedRuleRecord {
  const before = db.prepare('SELECT * FROM bank_learned_rules WHERE id = ?').get(id) as LearnedRow | undefined
  if (!before) throw new Error('Learned rule not found')
  const tokens = edit.tokens ? [...new Set(edit.tokens.map((t) => t.trim().toUpperCase()).filter((t) => t.length >= 2))] : null
  if (tokens && tokens.length === 0) throw new Error('A rule needs at least one word to match')
  db.prepare(
    `UPDATE bank_learned_rules SET status = ?, ledger_id = ?, party_ledger_id = ?, voucher_kind = ?, narration_template = ?, tokens = ?,
       updated_at = datetime('now') WHERE id = ?`
  ).run(
    edit.status ?? before.status,
    edit.ledgerId ?? before.ledger_id,
    edit.partyLedgerId !== undefined ? edit.partyLedgerId : before.party_ledger_id,
    edit.voucherKind ?? before.voucher_kind,
    edit.narrationTemplate !== undefined ? (edit.narrationTemplate?.trim() || null) : before.narration_template,
    tokens ? JSON.stringify(tokens) : before.tokens,
    id
  )
  writeAudit(db, 'bank_learned_rule', id, 'update', before, db.prepare('SELECT * FROM bank_learned_rules WHERE id = ?').get(id))
  return listLearnedRules(db).find((r) => r.id === id)!
}

export function deleteLearnedRule(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM bank_learned_rules WHERE id = ?').get(id)
  if (!before) throw new Error('Learned rule not found')
  db.prepare('DELETE FROM bank_learned_rules WHERE id = ?').run(id)
  writeAudit(db, 'bank_learned_rule', id, 'delete', before, null)
}

// ---------- confirm / unmatch / ignore ----------


function lineRows(db: DB, bankLedgerId: number, ids: number[]): LineRow[] {
  const rows = ids.map(
    (id) =>
      db
        .prepare(
          `SELECT l.id, l.import_id AS importId, l.line_no AS lineNo, l.date, l.value_date AS valueDate, l.description, l.reference,
                  l.deposit, l.withdrawal, l.balance, l.ignored_at AS ignoredAt FROM bank_statement_lines l WHERE l.id = ? AND l.bank_ledger_id = ?`
        )
        .get(id, bankLedgerId) as LineRow | undefined
  )
  if (rows.some((r) => !r)) throw new Error('Statement line not found for this bank account')
  return rows as LineRow[]
}

const isMatched = (db: DB, lineId: number): boolean => !!db.prepare('SELECT 1 FROM bank_statement_matches WHERE statement_line_id = ?').get(lineId)

/**
 * Confirm matches (bulk). Each group is one-to-one, several vouchers ↔ one line, or one voucher
 * ↔ several lines; amounts must agree within the tolerance. The vouchers' bank-ledger lines get
 * the statement date as bank date (the latest line date for a split), a match row remembers the
 * previous bank date for undo, and each line's narration teaches the learned rules. All groups
 * in one transaction; each line audited.
 */
export function confirmMatches(db: DB, bankLedgerId: number, groups: MatchGroupInput[], tolerance = 0): { confirmed: number } {
  assertBankLedger(db, bankLedgerId)
  const run = db.transaction(() => {
    let confirmed = 0
    for (const g of groups) {
      const lines = lineRows(db, bankLedgerId, [...new Set(g.lineIds)])
      for (const l of lines) {
        if (l.ignoredAt) throw new Error(`Statement line of ${l.date} is ignored — restore it first`)
        if (isMatched(db, l.id)) throw new Error(`Statement line of ${l.date} (${(Math.max(l.deposit, l.withdrawal) / 100).toFixed(2)}) is already matched`)
      }
      const entries = [...new Set(g.voucherIds)].map((voucherId) => {
        const bankLine = db
          .prepare(
            `SELECT vl.id, vl.dr_cr AS drCr, vl.amount, vl.bank_date AS bankDate, v.date FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
             WHERE vl.voucher_id = ? AND vl.ledger_id = ? AND ${IN_BOOKS} ORDER BY vl.bank_date IS NOT NULL, vl.id LIMIT 1`
          )
          .get(voucherId, bankLedgerId) as { id: number; drCr: 'dr' | 'cr'; amount: number; bankDate: string | null; date: string } | undefined
        if (!bankLine) throw new Error('That voucher has no entry on this bank account (or is out of the books)')
        if (bankLine.bankDate) throw new Error('That voucher is already reconciled')
        return { voucherId, ...bankLine }
      })
      const err = validateGroup(
        lines.map((l) => ({ id: l.id, date: l.date, amount: l.deposit || l.withdrawal, side: sideOf(l), reference: l.reference, description: l.description })),
        entries.map((e) => ({ id: e.id, voucherId: e.voucherId, date: e.date, amount: e.amount, side: e.drCr === 'dr' ? 'deposit' : 'withdrawal', instrumentNo: null, partyName: null, partyKey: null })),
        tolerance
      )
      if (err) throw new Error(err)
      const bankDate = lines.map((l) => l.date).sort().at(-1)!
      for (const e of entries) {
        db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?').run(bankDate, e.id)
        writeAudit(db, 'voucher_line', e.id, 'update', { bankDate: e.bankDate }, { bankDate, statementLineIds: lines.map((l) => l.id) })
      }
      for (const l of lines) {
        for (const e of entries) {
          db.prepare('INSERT INTO bank_statement_matches (statement_line_id, voucher_id, created_voucher, prev_bank_date) VALUES (?, ?, 0, ?)').run(l.id, e.voucherId, e.bankDate)
        }
        writeAudit(db, 'bank_statement_line', l.id, 'update', { matched: [] }, { matched: entries.map((e) => e.voucherId), bankDate })
        confirmed++
      }
      // Learn when the group points at one counter ledger.
      const facts = entries.map((e) => voucherFacts(db, e.voucherId, bankLedgerId)).filter((f): f is NonNullable<typeof f> => !!f)
      if (facts.length === entries.length && new Set(facts.map((f) => f.ledgerId)).size === 1) {
        for (const l of lines) {
          observe(db, { direction: sideOf(l), narration: l.description, ledgerId: facts[0]!.ledgerId, partyLedgerId: facts[0]!.partyLedgerId, voucherKind: facts[0]!.kind })
        }
      }
    }
    return { confirmed }
  })
  return run()
}

/** Undo a confirmed match: bank dates go back to what they were; vouchers created from the line
 *  stay (bin them yourself, or undo the whole import). Audited. */
export function unmatchLine(db: DB, bankLedgerId: number, lineId: number): void {
  lineRows(db, bankLedgerId, [lineId])
  const run = db.transaction(() => {
    const matches = db.prepare('SELECT voucher_id AS voucherId, prev_bank_date AS prev FROM bank_statement_matches WHERE statement_line_id = ?').all(lineId) as { voucherId: number; prev: string | null }[]
    if (matches.length === 0) throw new Error('That statement line is not matched')
    for (const m of matches) {
      // Only reset the bank date when no OTHER statement line still holds this voucher.
      const others = db.prepare('SELECT 1 FROM bank_statement_matches WHERE voucher_id = ? AND statement_line_id <> ?').get(m.voucherId, lineId)
      if (others) continue
      const vl = db.prepare('SELECT id, bank_date AS bankDate FROM voucher_lines WHERE voucher_id = ? AND ledger_id = ? ORDER BY bank_date IS NULL, id LIMIT 1').get(m.voucherId, bankLedgerId) as { id: number; bankDate: string | null } | undefined
      if (vl) {
        db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?').run(m.prev, vl.id)
        writeAudit(db, 'voucher_line', vl.id, 'update', { bankDate: vl.bankDate }, { bankDate: m.prev })
      }
    }
    db.prepare('DELETE FROM bank_statement_matches WHERE statement_line_id = ?').run(lineId)
    writeAudit(db, 'bank_statement_line', lineId, 'update', { matched: matches.map((m) => m.voucherId) }, { matched: [] })
  })
  run()
}

export function setLineIgnored(db: DB, bankLedgerId: number, lineId: number, ignored: boolean): void {
  const [line] = lineRows(db, bankLedgerId, [lineId])
  if (ignored && isMatched(db, lineId)) throw new Error('Unmatch the line before ignoring it')
  db.prepare("UPDATE bank_statement_lines SET ignored_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?").run(ignored ? 1 : 0, lineId)
  writeAudit(db, 'bank_statement_line', lineId, 'update', { ignored: !!line!.ignoredAt }, { ignored })
}

// ---------- bulk create vouchers ----------



/**
 * Create one voucher per unmatched statement line through saveVoucher (payment for a
 * withdrawal, receipt for a deposit, contra when the counter ledger is cash/bank), reconcile its
 * bank line with the statement date, and remember it was created from the statement (so undoing
 * the import bins it). Each line commits on its own: a failure (locked period, validation) is
 * reported and the rest proceed. saveVoucher audits the voucher; the line is audited too.
 */
export function createVouchersFromLines(db: DB, bankLedgerId: number, items: CreateFromLineInput[]): CreateResult {
  assertBankLedger(db, bankLedgerId)
  const cashBank = cashBankGroupIds(db)
  const result: CreateResult = { created: [], failed: [] }
  for (const item of items) {
    try {
      const out = db.transaction(() => {
        const [line] = lineRows(db, bankLedgerId, [item.lineId])
        if (!line) throw new Error('Statement line not found')
        if (line.ignoredAt) throw new Error('Line is ignored')
        if (isMatched(db, line.id)) throw new Error('Line is already matched')
        if (item.ledgerId === bankLedgerId) throw new Error('Pick a ledger other than this bank account')
        const counter = db.prepare('SELECT group_id AS groupId FROM ledgers WHERE id = ?').get(item.ledgerId) as { groupId: number } | undefined
        if (!counter) throw new Error('Ledger not found')
        const isDeposit = line.deposit > 0
        const amount = line.deposit || line.withdrawal
        const kind = item.voucherKind ?? (cashBank.has(counter.groupId) ? 'contra' : isDeposit ? 'receipt' : 'payment')
        const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ? AND is_system = 1 ORDER BY id LIMIT 1').get(kind) as { id: number } | undefined
        if (!vt) throw new Error(`No ${kind} voucher type`)
        const narration = (item.narration ?? line.description).trim().slice(0, 1000) || null
        const voucher = saveVoucher(db, {
          voucherTypeId: vt.id,
          date: line.date,
          partyLedgerId: item.partyLedgerId ?? null,
          narration,
          reference: line.reference ? line.reference.slice(0, 120) : null,
          lines: [
            { ledgerId: item.ledgerId, drCr: isDeposit ? 'cr' : 'dr', amount, costAllocations: [] },
            { ledgerId: bankLedgerId, drCr: isDeposit ? 'dr' : 'cr', amount, costAllocations: [] }
          ]
        })
        const bankLine = voucher.lines.find((l) => l.ledgerId === bankLedgerId)
        if (bankLine) {
          db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?').run(line.date, bankLine.id)
        }
        db.prepare('INSERT INTO bank_statement_matches (statement_line_id, voucher_id, created_voucher, prev_bank_date) VALUES (?, ?, 1, NULL)').run(line.id, voucher.id)
        writeAudit(db, 'bank_statement_line', line.id, 'update', { matched: [] }, { matched: [voucher.id], createdVoucher: voucher.id, bankDate: line.date })
        if (item.source?.kind === 'learned') {
          const before = db.prepare('SELECT * FROM bank_learned_rules WHERE id = ?').get(item.source.ruleId) as LearnedRow | undefined
          if (before && before.ledger_id === item.ledgerId) {
            db.prepare("UPDATE bank_learned_rules SET applied = applied + 1, updated_at = datetime('now') WHERE id = ?").run(item.source.ruleId)
            writeAudit(db, 'bank_learned_rule', item.source.ruleId, 'update', before, db.prepare('SELECT * FROM bank_learned_rules WHERE id = ?').get(item.source.ruleId))
          }
        } else if (item.source?.kind === 'rule') {
          recordRuleHit(db, item.source.ruleId)
        }
        // A suggestion used unchanged is already counted as 'applied'; anything else teaches.
        if (!(item.source?.kind === 'learned')) {
          observe(db, { direction: isDeposit ? 'deposit' : 'withdrawal', narration: line.description, ledgerId: item.ledgerId, partyLedgerId: item.partyLedgerId ?? null, voucherKind: kind })
        }
        return { lineId: line.id, voucherId: voucher.id, number: voucher.number }
      })()
      result.created.push(out)
    } catch (err) {
      result.failed.push({ lineId: item.lineId, error: (err as Error).message })
    }
  }
  return result
}

// ---------- undo import ----------

/**
 * Undo the most recent import of a bank account: bins the vouchers created from its lines
 * (deleteVoucher — audited, refused inside a locked period), puts back the bank dates its
 * confirmed matches set, and removes its lines. Only the latest import can be undone, so an
 * older statement's lines are never pulled out from under newer matches.
 */
export function undoLastImport(db: DB, bankLedgerId: number, importId: number): { binned: number; unmatched: number; removedLines: number } {
  assertBankLedger(db, bankLedgerId)
  const last = db.prepare('SELECT * FROM bank_statement_imports WHERE bank_ledger_id = ? ORDER BY id DESC LIMIT 1').get(bankLedgerId) as { id: number } | undefined
  if (!last) throw new Error('Nothing to undo — no statement imported for this bank account')
  if (last.id !== importId) throw new Error('Only the latest import can be undone')
  const before = db.prepare('SELECT * FROM bank_statement_imports WHERE id = ?').get(importId) as Record<string, unknown>
  const run = db.transaction(() => {
    const matches = db
      .prepare(
        `SELECT m.statement_line_id AS lineId, m.voucher_id AS voucherId, m.created_voucher AS created, m.prev_bank_date AS prev
         FROM bank_statement_matches m JOIN bank_statement_lines l ON l.id = m.statement_line_id WHERE l.import_id = ?`
      )
      .all(importId) as { lineId: number; voucherId: number; created: number; prev: string | null }[]
    let binned = 0
    let unmatched = 0
    const binnedIds = new Set<number>()
    for (const m of matches) {
      if (m.created) {
        if (binnedIds.has(m.voucherId)) continue
        const v = getVoucher(db, m.voucherId)
        if (v && !v.deletedAt) {
          deleteVoucher(db, m.voucherId)
          binned++
        }
        binnedIds.add(m.voucherId)
      } else {
        const others = db
          .prepare(
            `SELECT 1 FROM bank_statement_matches m JOIN bank_statement_lines l ON l.id = m.statement_line_id
             WHERE m.voucher_id = ? AND l.import_id <> ?`
          )
          .get(m.voucherId, importId)
        if (!others) {
          const vl = db.prepare('SELECT id, bank_date AS bankDate FROM voucher_lines WHERE voucher_id = ? AND ledger_id = ? ORDER BY bank_date IS NULL, id LIMIT 1').get(m.voucherId, bankLedgerId) as { id: number; bankDate: string | null } | undefined
          if (vl && vl.bankDate !== m.prev) {
            db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?').run(m.prev, vl.id)
            writeAudit(db, 'voucher_line', vl.id, 'update', { bankDate: vl.bankDate }, { bankDate: m.prev, undoImport: importId })
          }
        }
        unmatched++
      }
    }
    const removedLines = (db.prepare('SELECT COUNT(*) AS n FROM bank_statement_lines WHERE import_id = ?').get(importId) as { n: number }).n
    db.prepare('DELETE FROM bank_statement_imports WHERE id = ?').run(importId)
    writeAudit(db, 'bank_statement', importId, 'delete', before, { undone: true, vouchersBinned: binned, matchesUndone: unmatched, linesRemoved: removedLines })
    return { binned, unmatched, removedLines }
  })
  return run()
}
