import type { DB } from '../db/connection'
import type { BankLineRow, BankRecon } from '@shared/reports'
import { descendantIdsByName } from './masters'
import { isValidISODate } from '@shared/dates'
import { parseCsvLine } from '@shared/csv'
import { NOT_DELETED } from './vouchers'
import { writeAudit } from './audit'
import { matchRules, type RuleRow } from '@shared/bankRules'
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
       WHERE vl.ledger_id = ? AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
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
       WHERE vl.ledger_id = ? AND v.date <= ? AND ${NOT_DELETED}`
    )
    .get(ledgerId, to) as { m: number }
  const bookBalance = ledger.opening_balance + bookRow.m

  const unrecDeposits = mapped.filter((r) => !r.bankDate).reduce((s, r) => s + r.deposit, 0)
  const unrecWithdrawals = mapped.filter((r) => !r.bankDate).reduce((s, r) => s + r.withdrawal, 0)

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
  /** Positive paise: money into the account. */
  deposit: number
  /** Positive paise: money out. */
  withdrawal: number
}

function parseDateCell(cell: string): string | null {
  const t = cell.trim().replace(/"/g, '')
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/)
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
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0]!).map((h) => h.trim().toLowerCase())
  const dateIdx = header.findIndex((h) => h.includes('date'))
  const debitIdx = header.findIndex((h) => h.includes('debit') || h.includes('withdraw'))
  const creditIdx = header.findIndex((h) => h.includes('credit') || h.includes('deposit'))
  const amountIdx = header.findIndex((h) => h === 'amount' || h.includes('amount'))
  const descIdx = header.findIndex((h) => h.includes('desc') || h.includes('narrat') || h.includes('particular') || h.includes('remark'))
  if (dateIdx < 0) throw new Error('No date column found in the CSV header')

  const rows: StatementRow[] = []
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
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
    rows.push({ date, description: (cells[descIdx] ?? '').trim(), deposit, withdrawal })
  }
  return rows
}

export interface ImportResult {
  statementRows: number
  matched: number
  alreadyReconciled: number
  unmatched: { date: string; description: string; amount: number; kind: 'deposit' | 'withdrawal' }[]
}

/**
 * Read-only matching pass shared by importStatement (which then writes bank_date on the matches)
 * and suggestVouchers (which only cares about what's left over): statement rows are matched to
 * unreconciled book entries by same amount, same direction, book date within ±5 days of the
 * statement date.
 */
function matchStatement(
  db: DB,
  ledgerId: number,
  csv: string
): { statement: StatementRow[]; matches: { row: StatementRow; lineId: number }[]; unmatched: ImportResult['unmatched'] } {
  const statement = parseStatementCsv(csv)
  const open = db
    .prepare(
      `SELECT vl.id AS lineId, v.date, vl.dr_cr AS drCr, vl.amount
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND vl.bank_date IS NULL AND ${NOT_DELETED}`
    )
    .all(ledgerId) as { lineId: number; date: string; drCr: 'dr' | 'cr'; amount: number }[]

  const used = new Set<number>()
  const matches: { row: StatementRow; lineId: number }[] = []
  const unmatched: ImportResult['unmatched'] = []

  for (const row of statement) {
    const amount = row.deposit || row.withdrawal
    const wantSide = row.deposit > 0 ? 'dr' : 'cr'
    const candidate = open
      .filter((o) => !used.has(o.lineId) && o.drCr === wantSide && o.amount === amount)
      .map((o) => ({ o, gap: Math.abs(Date.parse(o.date) - Date.parse(row.date)) }))
      .filter((c) => c.gap <= 5 * 86_400_000)
      .sort((a, b) => a.gap - b.gap)[0]
    if (candidate) {
      used.add(candidate.o.lineId)
      matches.push({ row, lineId: candidate.o.lineId })
    } else {
      unmatched.push({
        date: row.date,
        description: row.description,
        amount,
        kind: row.deposit > 0 ? 'deposit' : 'withdrawal'
      })
    }
  }

  return { statement, matches, unmatched }
}

/**
 * Match statement rows to unreconciled book entries: same amount, same direction,
 * book date within ±5 days of the statement date. Matches get their bank_date set.
 */
export function importStatement(db: DB, ledgerId: number, csv: string): ImportResult {
  const { statement, matches, unmatched } = matchStatement(db, ledgerId, csv)
  const setStmt = db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?')
  const run = db.transaction(() => {
    for (const m of matches) setStmt.run(m.row.date, m.lineId)
  })
  run()

  return { statementRows: statement.length, matched: matches.length, alreadyReconciled: 0, unmatched }
}

// ---------- bank rules (auto-categorization) ----------

export interface BankRuleRecord {
  id: number
  pattern: string
  matchField: string
  ledgerId: number
  ledgerName: string
  kind: 'payment' | 'receipt'
  active: boolean
  hits: number
}

export function listRules(db: DB): BankRuleRecord[] {
  return (
    db
      .prepare(
        `SELECT r.id, r.pattern, r.match_field AS matchField, r.ledger_id AS ledgerId,
                l.name AS ledgerName, r.kind, r.active, r.hits
         FROM bank_rules r JOIN ledgers l ON l.id = r.ledger_id
         ORDER BY r.pattern COLLATE NOCASE`
      )
      .all() as (Omit<BankRuleRecord, 'active'> & { active: number })[]
  ).map((r) => ({ ...r, active: !!r.active }))
}

export function saveRule(db: DB, input: BankRuleInput, id?: number): BankRuleRecord {
  if (id != null) {
    const before = db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(id)
    if (!before) throw new Error('Bank rule not found')
    db.prepare('UPDATE bank_rules SET pattern = ?, ledger_id = ?, kind = ?, active = ? WHERE id = ?').run(
      input.pattern,
      input.ledgerId,
      input.kind,
      input.active ? 1 : 0,
      id
    )
    writeAudit(db, 'bank_rule', id, 'update', before, input)
  } else {
    const res = db
      .prepare('INSERT INTO bank_rules (pattern, ledger_id, kind, active) VALUES (?, ?, ?, ?)')
      .run(input.pattern, input.ledgerId, input.kind, input.active ? 1 : 0)
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
  statementRow: { date: string; description: string; amount: number; kind: 'deposit' | 'withdrawal' }
  suggestion: {
    ruleId: number
    ledgerId: number
    ledgerName: string
    kind: 'payment' | 'receipt'
    voucherDraft: BankVoucherDraft
  } | null
}

/**
 * Runs the same matching importStatement uses (matchStatement) to find the statement rows that
 * still have no book-entry match, then runs active bank rules over just those rows to suggest a
 * voucher draft per row. Read-only — never sets bank_date, never touches bank_rules.hits (that's
 * recordRuleHit, called separately once the user actually files a suggested voucher).
 */
export function suggestVouchers(db: DB, ledgerId: number, csv: string): BankSuggestionRow[] {
  const { unmatched } = matchStatement(db, ledgerId, csv)
  const allRules = listRules(db)
  const rules: RuleRow[] = allRules
    .filter((r) => r.active)
    .map((r) => ({ id: r.id, pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind }))
  const ruleNames = new Map(allRules.map((r) => [r.id, r.ledgerName]))

  return unmatched.map((u) => {
    const statementLike = { description: u.description, deposit: u.kind === 'deposit' ? u.amount : 0, withdrawal: u.kind === 'withdrawal' ? u.amount : 0 }
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
