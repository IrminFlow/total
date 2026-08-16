import type { DB } from '../db/connection'
import type { BankLineRow, BankRecon } from '@shared/reports'
import { descendantIdsByName } from './masters'
import { isValidISODate } from '@shared/dates'
import { parseCsv } from '@shared/csv'
// IN_BOOKS, not NOT_DELETED: optional (memorandum) and unmatured post-dated vouchers are out of
// the books — the BRS/recon book balance must tie to the same ledger's statement (IN_BOOKS), and
// bank dates must not be assignable to out-of-books entries.
import { IN_BOOKS, saveVoucher } from './vouchers'
import { writeAudit } from './audit'
import { findSumCombos, matchRules, type RuleRow } from '@shared/bankRules'
import type { BankRuleInput } from '@shared/schemas'

export function bankLedgers(db: DB): { id: number; name: string }[] {
  const ids = descendantIdsByName(db, ['Bank Accounts', 'Bank OD A/c'])
  return (db.prepare('SELECT id, name, group_id FROM ledgers ORDER BY name').all() as { id: number; name: string; group_id: number }[])
    .filter((l) => ids.has(l.group_id))
    .map((l) => ({ id: l.id, name: l.name }))
}

export function bankRecon(db: DB, ledgerId: number, from: string, to: string): BankRecon {
  const ledger = db.prepare('SELECT id, name, opening_balance FROM ledgers WHERE id = ?').get(ledgerId) as
    | { id: number; name: string; opening_balance: number }
    | undefined
  if (!ledger) throw new Error('Bank ledger not found')

  const rows = db
    .prepare(
      `SELECT vl.id AS lineId, v.id AS voucherId, v.date, vt.name AS voucherType, v.number,
              v.instrument_no AS instrumentNo, vl.dr_cr AS drCr, vl.amount, vl.bank_date AS bankDate,
              (SELECT GROUP_CONCAT(DISTINCT l2.name)
               FROM voucher_lines vl2 JOIN ledgers l2 ON l2.id = vl2.ledger_id
               WHERE vl2.voucher_id = v.id AND vl2.dr_cr <> vl.dr_cr) AS particulars
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vl.ledger_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(ledgerId, from, to) as (Omit<BankLineRow, 'deposit' | 'withdrawal'> & { drCr: 'dr' | 'cr'; amount: number })[]

  const mapped: BankLineRow[] = rows.map((r) => ({
    lineId: r.lineId,
    voucherId: r.voucherId,
    date: r.date,
    voucherType: r.voucherType,
    number: r.number,
    particulars: r.particulars ?? '',
    instrumentNo: r.instrumentNo,
    deposit: r.drCr === 'dr' ? r.amount : 0,
    withdrawal: r.drCr === 'cr' ? r.amount : 0,
    bankDate: r.bankDate
  }))

  const bookRow = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS m
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS}`
    )
    .get(ledgerId, to) as { m: number }
  const bookBalance = ledger.opening_balance + bookRow.m

  // As-on-date correctness: an entry cleared AFTER the period end was still outstanding within
  // the period, so a bank_date beyond `to` counts as unreconciled here.
  const unrec = (r: BankLineRow): boolean => !r.bankDate || r.bankDate > to
  const unrecDeposits = mapped.filter(unrec).reduce((s, r) => s + r.deposit, 0)
  const unrecWithdrawals = mapped.filter(unrec).reduce((s, r) => s + r.withdrawal, 0)

  return {
    ledgerId,
    ledgerName: ledger.name,
    bookBalance,
    unreconciledDeposits: unrecDeposits,
    unreconciledWithdrawals: unrecWithdrawals,
    bankBalance: bookBalance - unrecDeposits + unrecWithdrawals,
    rows: mapped
  }
}

export function setBankDate(db: DB, lineId: number, bankDate: string | null): void {
  if (bankDate !== null && !isValidISODate(bankDate)) throw new Error('Invalid bank date')
  const before = db.prepare('SELECT bank_date AS bankDate FROM voucher_lines WHERE id = ?').get(lineId) as
    | { bankDate: string | null }
    | undefined
  if (!before) throw new Error('Entry not found')
  const res = db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?').run(bankDate, lineId)
  if (res.changes === 0) throw new Error('Entry not found')
  writeAudit(db, 'voucher_line', lineId, 'update', { bankDate: before.bankDate }, { bankDate })
}

// ---------- statement CSV import ----------

interface StatementRow {
  date: string
  description: string
  /** Cheque/UTR/reference cell, '' when the CSV has no such column. */
  reference: string
  /** Positive paise: money into the account. */
  deposit: number
  /** Positive paise: money out. */
  withdrawal: number
}

const MONTH_NAMES: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
}

function parseDateCell(cell: string): string | null {
  const t = cell.trim().replace(/"/g, '')
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  // 15-Aug-2025 / 15 Aug 25 / 15-August-2025
  m = t.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ](\d{2}|\d{4})$/)
  if (m) {
    const month = MONTH_NAMES[m[2]!.slice(0, 3).toLowerCase()]
    if (month) {
      const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!
      return `${year}-${month}-${m[1]!.padStart(2, '0')}`
    }
    return null
  }
  // 15/08/2025 · 15-08-2025 · 15.08.2025
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/)
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  // 15/08/25 · 15-08-25 · 15.08.25
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/)
  if (m) return `20${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  return null
}

function parseAmountCell(cell: string): number | null {
  const t = cell.trim().replace(/["₹,\s]/g, '')
  if (t === '' || t === '-') return null
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** Parse a bank statement CSV: finds date/debit/credit (or signed amount) columns from the header. */
export function parseStatementCsv(csv: string): StatementRow[] {
  // Full-text parse (v0.3 #67) so descriptions with embedded line breaks survive.
  const records = parseCsv(csv)
  if (records.length < 2) return []
  const header = records[0]!.cells.map((h) => h.trim().toLowerCase())
  const dateIdx = header.findIndex((h) => h.includes('date'))
  const debitIdx = header.findIndex((h) => h.includes('debit') || h.includes('withdraw'))
  const creditIdx = header.findIndex((h) => h.includes('credit') || h.includes('deposit'))
  const amountIdx = header.findIndex((h) => h === 'amount' || h.includes('amount'))
  const descIdx = header.findIndex((h) => h.includes('desc') || h.includes('narrat') || h.includes('particular') || h.includes('remark'))
  const refIdx = header.findIndex((h) => h.includes('ref') || h.includes('chq') || h.includes('cheque') || h.includes('utr'))
  if (dateIdx < 0) throw new Error('No date column found in the CSV header')

  const rows: StatementRow[] = []
  for (const record of records.slice(1)) {
    const cells = record.cells
    const date = parseDateCell(cells[dateIdx] ?? '')
    if (!date) continue
    let deposit = 0
    let withdrawal = 0
    if (debitIdx >= 0 || creditIdx >= 0) {
      withdrawal = Math.abs(parseAmountCell(cells[debitIdx] ?? '') ?? 0)
      deposit = Math.abs(parseAmountCell(cells[creditIdx] ?? '') ?? 0)
    } else if (amountIdx >= 0) {
      const amount = parseAmountCell(cells[amountIdx] ?? '') ?? 0
      if (amount >= 0) deposit = amount
      else withdrawal = -amount
    }
    if (deposit === 0 && withdrawal === 0) continue
    rows.push({
      date,
      description: (cells[descIdx] ?? '').trim(),
      reference: refIdx >= 0 ? (cells[refIdx] ?? '').trim() : '',
      deposit,
      withdrawal
    })
  }
  return rows
}

export interface UnmatchedRow {
  date: string
  description: string
  reference: string
  amount: number
  kind: 'deposit' | 'withdrawal'
}

export interface ImportResult {
  statementRows: number
  matched: number
  alreadyReconciled: number
  unmatched: UnmatchedRow[]
  /** Per-match detail so the renderer can preview-confirm before applying (dryRun). */
  matches: { date: string; description: string; amount: number; kind: 'deposit' | 'withdrawal'; lineId: number }[]
  /** Vouchers auto-created by auto_apply rules during an applying import (audited; empty on dryRun). */
  autoCreated: { date: string; description: string; amount: number; kind: 'deposit' | 'withdrawal'; voucherId: number; ruleId: number }[]
}

/**
 * Read-only matching pass shared by importStatement (which then writes bank_date on the matches)
 * and suggestVouchers (which only cares about what's left over): statement rows are matched to
 * unreconciled book entries by same amount, same direction, book date within ±5 days of the
 * statement date. Rows that miss every open entry but hit an ALREADY-reconciled one under the
 * same test are reported truthfully as alreadyReconciled (a re-imported statement) rather than
 * being lumped into unmatched.
 */
function matchStatement(
  db: DB,
  ledgerId: number,
  csv: string
): {
  statement: StatementRow[]
  matches: { row: StatementRow; lineId: number }[]
  alreadyReconciled: StatementRow[]
  unmatched: UnmatchedRow[]
  usedLineIds: Set<number>
} {
  const statement = parseStatementCsv(csv)
  const open = db
    .prepare(
      `SELECT vl.id AS lineId, v.date, vl.dr_cr AS drCr, vl.amount
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND vl.bank_date IS NULL AND ${IN_BOOKS}`
    )
    .all(ledgerId) as { lineId: number; date: string; drCr: 'dr' | 'cr'; amount: number }[]
  const reconciled = db
    .prepare(
      `SELECT vl.id AS lineId, v.date, vl.dr_cr AS drCr, vl.amount
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND vl.bank_date IS NOT NULL AND ${IN_BOOKS}`
    )
    .all(ledgerId) as { lineId: number; date: string; drCr: 'dr' | 'cr'; amount: number }[]

  const used = new Set<number>()
  const usedReconciled = new Set<number>()
  const matches: { row: StatementRow; lineId: number }[] = []
  const alreadyReconciled: StatementRow[] = []
  const unmatched: UnmatchedRow[] = []

  const closest = (
    pool: { lineId: number; date: string; drCr: 'dr' | 'cr'; amount: number }[],
    taken: Set<number>,
    row: StatementRow,
    amount: number,
    wantSide: 'dr' | 'cr'
  ): { lineId: number } | undefined =>
    pool
      .filter((o) => !taken.has(o.lineId) && o.drCr === wantSide && o.amount === amount)
      .map((o) => ({ o, gap: Math.abs(Date.parse(o.date) - Date.parse(row.date)) }))
      .filter((c) => c.gap <= 5 * 86_400_000)
      .sort((a, b) => a.gap - b.gap)[0]?.o

  for (const row of statement) {
    const amount = row.deposit || row.withdrawal
    const wantSide = row.deposit > 0 ? 'dr' : 'cr'
    const candidate = closest(open, used, row, amount, wantSide)
    if (candidate) {
      used.add(candidate.lineId)
      matches.push({ row, lineId: candidate.lineId })
      continue
    }
    const done = closest(reconciled, usedReconciled, row, amount, wantSide)
    if (done) {
      usedReconciled.add(done.lineId)
      alreadyReconciled.push(row)
      continue
    }
    unmatched.push({
      date: row.date,
      description: row.description,
      reference: row.reference,
      amount,
      kind: row.deposit > 0 ? 'deposit' : 'withdrawal'
    })
  }

  return { statement, matches, alreadyReconciled, unmatched, usedLineIds: used }
}

/**
 * Match statement rows to unreconciled book entries: same amount, same direction, book date
 * within ±5 days of the statement date. With `apply` (the default), matches get their bank_date
 * set and active auto_apply rules create vouchers for whatever's left — all in one transaction.
 * With `apply: false` this is a pure preview (nothing written), so the renderer can confirm
 * before committing; there is no undo, the preview IS the safety net.
 */
export function importStatement(
  db: DB,
  ledgerId: number,
  csv: string,
  opts: { apply?: boolean } = {}
): ImportResult {
  const apply = opts.apply !== false
  const { statement, matches, alreadyReconciled, unmatched } = matchStatement(db, ledgerId, csv)

  const matchDetail = matches.map((m) => ({
    date: m.row.date,
    description: m.row.description,
    amount: m.row.deposit || m.row.withdrawal,
    kind: (m.row.deposit > 0 ? 'deposit' : 'withdrawal') as 'deposit' | 'withdrawal',
    lineId: m.lineId
  }))
  const autoCreated: ImportResult['autoCreated'] = []
  let remaining = unmatched

  if (apply) {
    const setStmt = db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?')
    const run = db.transaction(() => {
      for (const m of matches) setStmt.run(m.row.date, m.lineId)

      // Opt-in auto-apply: rules flagged auto_apply create the voucher outright (same draft
      // shape suggestVouchers offers) and reconcile its bank line against the statement row.
      const autoRules: RuleRow[] = listRules(db)
        .filter((r) => r.active && r.autoApply)
        .map((r) => ({
          id: r.id, pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind,
          matchField: r.matchField === 'reference' ? 'reference' : 'description',
          minAmount: r.minAmount, maxAmount: r.maxAmount
        }))
      if (autoRules.length > 0) {
        const stillUnmatched: UnmatchedRow[] = []
        for (const u of unmatched) {
          const like = {
            description: u.description,
            reference: u.reference,
            deposit: u.kind === 'deposit' ? u.amount : 0,
            withdrawal: u.kind === 'withdrawal' ? u.amount : 0
          }
          const hit = matchRules([like], autoRules)[0]
          if (!hit) {
            stillUnmatched.push(u)
            continue
          }
          const rule = hit.rule
          const isPayment = rule.kind === 'payment'
          const vt = db
            .prepare('SELECT id FROM voucher_types WHERE kind = ? AND is_system = 1')
            .get(rule.kind) as { id: number } | undefined
          if (!vt) {
            stillUnmatched.push(u)
            continue
          }
          const voucher = saveVoucher(db, {
            voucherTypeId: vt.id,
            date: u.date,
            number: undefined,
            partyLedgerId: null,
            narration: `${u.description} (auto-created by bank rule)`,
            reference: u.reference || null,
            instrumentNo: null,
            instrumentDate: null,
            transporterId: null,
            vehicleNo: null,
            transportDistanceKm: null,
            currencyCode: null,
            exchangeRate: null,
            lines: [
              { ledgerId: rule.ledgerId, drCr: isPayment ? 'dr' : 'cr', amount: u.amount, costAllocations: [] },
              { ledgerId, drCr: isPayment ? 'cr' : 'dr', amount: u.amount, costAllocations: [] }
            ],
            inventory: [],
            billRefs: [],
            tds: null
          })
          const bankLine = voucher.lines.find((l) => l.ledgerId === ledgerId)
          if (bankLine) setStmt.run(u.date, bankLine.id)
          recordRuleHit(db, rule.id)
          autoCreated.push({ date: u.date, description: u.description, amount: u.amount, kind: u.kind, voucherId: voucher.id, ruleId: rule.id })
        }
        remaining = stillUnmatched
      }
    })
    run()
  }

  // [lane-Q audit block — keep as one unit when merging] statement-import summary audit row.
  // Not written for dry runs (lane Y's preview-confirm flow) — only an applied import is an event.
  if (apply) {
    writeAudit(db, 'bank_statement', ledgerId, 'import', null,
      { statementRows: statement.length, matched: matches.length, unmatched: remaining.length })
  }

  return {
    statementRows: statement.length,
    matched: matches.length,
    alreadyReconciled: alreadyReconciled.length,
    unmatched: remaining,
    matches: matchDetail,
    autoCreated
  }
}

// ---------- bank rules (auto-categorization) ----------

export interface BankRuleRecord {
  id: number
  pattern: string
  matchField: string
  ledgerId: number
  ledgerName: string
  kind: 'payment' | 'receipt'
  /** Amount window (paise, inclusive); null = unbounded. */
  minAmount: number | null
  maxAmount: number | null
  /** Opt-in: an applying statement import creates the voucher outright when this rule matches. */
  autoApply: boolean
  active: boolean
  hits: number
}

export function listRules(db: DB): BankRuleRecord[] {
  return (
    db
      .prepare(
        `SELECT r.id, r.pattern, r.match_field AS matchField, r.ledger_id AS ledgerId,
                l.name AS ledgerName, r.kind, r.min_amount AS minAmount, r.max_amount AS maxAmount,
                r.auto_apply AS autoApply, r.active, r.hits
         FROM bank_rules r JOIN ledgers l ON l.id = r.ledger_id
         ORDER BY r.pattern COLLATE NOCASE`
      )
      .all() as (Omit<BankRuleRecord, 'active' | 'autoApply'> & { active: number; autoApply: number })[]
  ).map((r) => ({ ...r, active: !!r.active, autoApply: !!r.autoApply }))
}

export function saveRule(db: DB, input: BankRuleInput, id?: number): BankRuleRecord {
  const matchField = input.matchField ?? 'description'
  const minAmount = input.minAmount ?? null
  const maxAmount = input.maxAmount ?? null
  const autoApply = input.autoApply ? 1 : 0
  if (minAmount != null && maxAmount != null && minAmount > maxAmount) {
    throw new Error('Minimum amount cannot exceed the maximum')
  }
  if (id != null) {
    const before = db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(id)
    if (!before) throw new Error('Bank rule not found')
    db.prepare(
      `UPDATE bank_rules SET pattern = ?, match_field = ?, ledger_id = ?, kind = ?,
       min_amount = ?, max_amount = ?, auto_apply = ?, active = ? WHERE id = ?`
    ).run(input.pattern, matchField, input.ledgerId, input.kind, minAmount, maxAmount, autoApply, input.active ? 1 : 0, id)
    writeAudit(db, 'bank_rule', id, 'update', before, input)
  } else {
    const res = db
      .prepare(
        `INSERT INTO bank_rules (pattern, match_field, ledger_id, kind, min_amount, max_amount, auto_apply, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.pattern, matchField, input.ledgerId, input.kind, minAmount, maxAmount, autoApply, input.active ? 1 : 0)
    id = Number(res.lastInsertRowid)
    writeAudit(db, 'bank_rule', id, 'create', null, input)
  }
  const row = listRules(db).find((r) => r.id === id)
  if (!row) throw new Error('Bank rule not found after save')
  return row
}

export function deleteRule(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(id)
  if (!before) throw new Error('Bank rule not found')
  db.prepare('DELETE FROM bank_rules WHERE id = ?').run(id)
  writeAudit(db, 'bank_rule', id, 'delete', before, null)
}

/** Increments a rule's hit counter — called when the user files a voucher built from one of its
 *  suggestions (see suggestVouchers), so "Rules…" can show how often each rule actually fires. */
export function recordRuleHit(db: DB, ruleId: number): void {
  const res = db.prepare('UPDATE bank_rules SET hits = hits + 1 WHERE id = ?').run(ruleId)
  if (res.changes === 0) throw new Error('Bank rule not found')
}

/** Neutral voucher-draft shape consumed by the renderer's voucher-entry nav draft
 *  (see src/renderer/src/state/stores.ts VoucherDraft — partyLedgerId is simply omitted here). */
export interface BankVoucherDraft {
  date: string
  narration: string
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
}

export interface BankSuggestionRow {
  statementRow: UnmatchedRow
  suggestion: {
    ruleId: number
    ledgerId: number
    ledgerName: string
    kind: 'payment' | 'receipt'
    voucherDraft: BankVoucherDraft
  } | null
}

/** Active bank rules in the shared matcher's RuleRow shape (matchField/amount bounds included). */
function activeRuleRows(db: DB): { rules: RuleRow[]; ruleNames: Map<number, string> } {
  const allRules = listRules(db)
  const rules: RuleRow[] = allRules
    .filter((r) => r.active)
    .map((r) => ({
      id: r.id, pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind,
      matchField: r.matchField === 'reference' ? 'reference' : 'description',
      minAmount: r.minAmount, maxAmount: r.maxAmount
    }))
  return { rules, ruleNames: new Map(allRules.map((r) => [r.id, r.ledgerName])) }
}

/**
 * Runs the same matching importStatement uses (matchStatement) to find the statement rows that
 * still have no book-entry match, then runs active bank rules over just those rows to suggest a
 * voucher draft per row. Read-only — never sets bank_date, never touches bank_rules.hits (that's
 * recordRuleHit, called separately once the user actually files a suggested voucher).
 */
export function suggestVouchers(db: DB, ledgerId: number, csv: string): BankSuggestionRow[] {
  const { unmatched } = matchStatement(db, ledgerId, csv)
  const { rules, ruleNames } = activeRuleRows(db)

  return unmatched.map((u) => {
    const statementLike = { description: u.description, reference: u.reference, deposit: u.kind === 'deposit' ? u.amount : 0, withdrawal: u.kind === 'withdrawal' ? u.amount : 0 }
    const match = matchRules([statementLike], rules)[0]
    if (!match) return { statementRow: u, suggestion: null }

    const rule = match.rule
    const isPayment = rule.kind === 'payment'
    const voucherDraft: BankVoucherDraft = {
      date: u.date,
      narration: u.description,
      lines: [
        { ledgerId: rule.ledgerId, drCr: isPayment ? 'dr' : 'cr', amount: u.amount },
        { ledgerId, drCr: isPayment ? 'cr' : 'dr', amount: u.amount }
      ]
    }
    return {
      statementRow: u,
      suggestion: {
        ruleId: rule.id,
        ledgerId: rule.ledgerId,
        ledgerName: ruleNames.get(rule.id) ?? '',
        kind: rule.kind,
        voucherDraft
      }
    }
  })
}

// ---------- statement matching v2: tolerance + many-to-one suggestions (task Y2) ----------

export interface BankMatchSuggestion {
  statementRow: UnmatchedRow
  /** 'tolerance': one open entry within ±tolerance of the row amount.
   *  'many_to_one': ≤3 open entries of the same party summing to the row amount. */
  kind: 'tolerance' | 'many_to_one'
  lines: { lineId: number; voucherId: number; date: string; number: string; amount: number }[]
}

/**
 * Suggestions-only second pass over the rows the exact matcher (pass 1, dbtest-locked) left
 * unmatched: (a) a single open entry whose amount is within ±tolerance (default ±₹1) of the
 * statement row, same direction, ±5 days; (b) many-to-one — up to three open entries from
 * vouchers of the SAME party whose amounts sum to the row (±tolerance), e.g. one NEFT settling
 * three invoices. Read-only: nothing is written; the renderer reconciles the suggested lines
 * explicitly via bank:setBankDate.
 */
export function matchSuggestions(db: DB, ledgerId: number, csv: string, tolerancePaise = 100): BankMatchSuggestion[] {
  const { unmatched, usedLineIds } = matchStatement(db, ledgerId, csv)
  if (unmatched.length === 0) return []

  const open = db
    .prepare(
      `SELECT vl.id AS lineId, v.id AS voucherId, v.date, v.number, vl.dr_cr AS drCr, vl.amount,
              COALESCE(v.party_ledger_id,
                       (SELECT MIN(vl2.ledger_id) FROM voucher_lines vl2
                        WHERE vl2.voucher_id = v.id AND vl2.ledger_id <> vl.ledger_id)) AS partyKey
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND vl.bank_date IS NULL AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(ledgerId) as {
      lineId: number; voucherId: number; date: string; number: string
      drCr: 'dr' | 'cr'; amount: number; partyKey: number | null
    }[]

  const taken = new Set<number>(usedLineIds)
  const suggestions: BankMatchSuggestion[] = []

  for (const row of unmatched) {
    const wantSide = row.kind === 'deposit' ? 'dr' : 'cr'
    const pool = open.filter((o) => !taken.has(o.lineId) && o.drCr === wantSide)

    // (a) tolerance: closest near-miss single within ±5 days
    const single = pool
      .filter((o) => Math.abs(o.amount - row.amount) <= tolerancePaise)
      .map((o) => ({ o, gap: Math.abs(Date.parse(o.date) - Date.parse(row.date)) }))
      .filter((c) => c.gap <= 5 * 86_400_000)
      .sort((a, b) => a.gap - b.gap || Math.abs(a.o.amount - row.amount) - Math.abs(b.o.amount - row.amount))[0]
    if (single) {
      taken.add(single.o.lineId)
      suggestions.push({
        statementRow: row,
        kind: 'tolerance',
        lines: [{ lineId: single.o.lineId, voucherId: single.o.voucherId, date: single.o.date, number: single.o.number, amount: single.o.amount }]
      })
      continue
    }

    // (b) many-to-one: ≤3 open entries of the same party summing to the row amount
    const byParty = new Map<number, typeof pool>()
    for (const o of pool) {
      if (o.partyKey == null) continue
      const list = byParty.get(o.partyKey) ?? []
      list.push(o)
      byParty.set(o.partyKey, list)
    }
    for (const group of byParty.values()) {
      if (group.length < 2) continue
      const combo = findSumCombos(row.amount, group.map((g) => g.amount), 3, tolerancePaise, 1)[0]
      if (!combo) continue
      const lines = combo.map((i) => group[i]!)
      for (const l of lines) taken.add(l.lineId)
      suggestions.push({
        statementRow: row,
        kind: 'many_to_one',
        lines: lines.map((l) => ({ lineId: l.lineId, voucherId: l.voucherId, date: l.date, number: l.number, amount: l.amount }))
      })
      break
    }
  }

  return suggestions
}

// ---------- bank reconciliation statement (BRS, task Y2) ----------

export interface BrsItem {
  lineId: number
  voucherId: number
  date: string
  voucherType: string
  number: string
  particulars: string
  instrumentNo: string | null
  amount: number
}

export interface BrsReport {
  ledgerId: number
  ledgerName: string
  asOn: string
  /** Balance per company books as on the date (dr-positive paise). */
  bookBalance: number
  /** Deposits recorded in the books but not yet credited by the bank as on the date. */
  uncredited: BrsItem[]
  uncreditedTotal: number
  /** Cheques/withdrawals issued in the books but not yet presented as on the date. */
  unpresented: BrsItem[]
  unpresentedTotal: number
  /** Derived balance per bank statement: book − uncredited + unpresented. */
  bankBalance: number
}

/**
 * Bank reconciliation statement as on a date. As-on-date correctness (task Y2 #87): an entry
 * whose bank_date falls AFTER `asOn` was still outstanding on that date, so it lists as
 * unpresented/uncredited here even though it has since cleared.
 */
export function brs(db: DB, ledgerId: number, asOn: string): BrsReport {
  const ledger = db.prepare('SELECT id, name, opening_balance FROM ledgers WHERE id = ?').get(ledgerId) as
    | { id: number; name: string; opening_balance: number }
    | undefined
  if (!ledger) throw new Error('Bank ledger not found')

  const rows = db
    .prepare(
      `SELECT vl.id AS lineId, v.id AS voucherId, v.date, vt.name AS voucherType, v.number,
              v.instrument_no AS instrumentNo, vl.dr_cr AS drCr, vl.amount,
              (SELECT GROUP_CONCAT(DISTINCT l2.name)
               FROM voucher_lines vl2 JOIN ledgers l2 ON l2.id = vl2.ledger_id
               WHERE vl2.voucher_id = v.id AND vl2.dr_cr <> vl.dr_cr) AS particulars
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vl.ledger_id = ? AND v.date <= ? AND (vl.bank_date IS NULL OR vl.bank_date > ?)
         AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(ledgerId, asOn, asOn) as (Omit<BrsItem, 'particulars'> & { drCr: 'dr' | 'cr'; particulars: string | null })[]

  const bookRow = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS m
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS}`
    )
    .get(ledgerId, asOn) as { m: number }
  const bookBalance = ledger.opening_balance + bookRow.m

  const toItem = (r: (typeof rows)[number]): BrsItem => ({
    lineId: r.lineId, voucherId: r.voucherId, date: r.date, voucherType: r.voucherType,
    number: r.number, particulars: r.particulars ?? '', instrumentNo: r.instrumentNo, amount: r.amount
  })
  const uncredited = rows.filter((r) => r.drCr === 'dr').map(toItem)
  const unpresented = rows.filter((r) => r.drCr === 'cr').map(toItem)
  const uncreditedTotal = uncredited.reduce((s, r) => s + r.amount, 0)
  const unpresentedTotal = unpresented.reduce((s, r) => s + r.amount, 0)

  return {
    ledgerId,
    ledgerName: ledger.name,
    asOn,
    bookBalance,
    uncredited,
    uncreditedTotal,
    unpresented,
    unpresentedTotal,
    bankBalance: bookBalance - uncreditedTotal + unpresentedTotal
  }
}
