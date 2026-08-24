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
import { createHash } from 'node:crypto'

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
  rowNo: number
  date: string
  description: string
  /** Cheque/UTR/reference cell, '' when the CSV has no such column. */
  reference: string
  /** Positive paise: money into the account. */
  deposit: number
  /** Positive paise: money out. */
  withdrawal: number
  /** Balance after this transaction, when supplied by the statement. */
  balance: number | null
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
  const balanceIdx = header.findIndex((h) => h.includes('balance') || h === 'bal')
  if (dateIdx < 0) throw new Error('No date column found in the CSV header')

  const rows: StatementRow[] = []
  for (const [index, record] of records.slice(1).entries()) {
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
      rowNo: index + 1,
      date,
      description: (cells[descIdx] ?? '').trim(),
      reference: refIdx >= 0 ? (cells[refIdx] ?? '').trim() : '',
      deposit,
      withdrawal,
      balance: balanceIdx >= 0 ? parseAmountCell(cells[balanceIdx] ?? '') : null
    })
  }
  return rows
}

export interface UnmatchedRow {
  rowNo: number
  date: string
  description: string
  reference: string
  amount: number
  kind: 'deposit' | 'withdrawal'
}

export interface ImportResult {
  importId: number | null
  openingBalance: number | null
  closingBalance: number | null
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
  alreadyReconciled: { row: StatementRow; lineId: number }[]
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
  const alreadyReconciled: { row: StatementRow; lineId: number }[] = []
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
      alreadyReconciled.push({ row, lineId: done.lineId })
      continue
    }
    unmatched.push({
      rowNo: row.rowNo,
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
  opts: { apply?: boolean; actor?: string; fileName?: string; format?: 'csv' | 'xlsx' | 'ofx' | 'qif' | 'mt940' } = {}
): ImportResult {
  const apply = opts.apply !== false
  const { statement, matches, alreadyReconciled, unmatched } = matchStatement(db, ledgerId, csv)

  const firstWithBalance = statement.find((row) => row.balance != null)
  const lastWithBalance = [...statement].reverse().find((row) => row.balance != null)
  const openingBalance = firstWithBalance?.balance == null
    ? null
    : firstWithBalance.balance - firstWithBalance.deposit + firstWithBalance.withdrawal
  const closingBalance = lastWithBalance?.balance ?? null
  const sourceHash = statement.length > 0 ? createHash('sha256').update(csv).digest('hex') : null

  const matchDetail = matches.map((m) => ({
    date: m.row.date,
    description: m.row.description,
    amount: m.row.deposit || m.row.withdrawal,
    kind: (m.row.deposit > 0 ? 'deposit' : 'withdrawal') as 'deposit' | 'withdrawal',
    lineId: m.lineId
  }))
  let autoCreated: ImportResult['autoCreated'] = []
  let remaining = unmatched
  let importId: number | null = null

  // A retry of byte-identical evidence must be a true no-op. In particular, do this before
  // auto-apply rules run, otherwise a retried statement could create fresh accounting entries
  // before INSERT OR IGNORE reveals that its evidence already exists.
  const existingImport = apply && sourceHash != null
    ? db.prepare('SELECT id FROM bank_statement_imports WHERE ledger_id = ? AND source_hash = ?')
      .get(ledgerId, sourceHash) as { id: number } | undefined
    : undefined
  if (existingImport) importId = existingImport.id

  if (apply && !existingImport) {
    const applied = db.transaction(() => {
      const txAutoCreated: ImportResult['autoCreated'] = []
      let txRemaining = unmatched
      let txImportId: number | null = null
      const createdByRowNo = new Map<number, number>()
      const setStmt = db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ? AND bank_date IS NULL')
      for (const m of matches) {
        if (setStmt.run(m.row.date, m.lineId).changes !== 1) {
          throw new Error('A matched bank entry changed during import; retry the statement')
        }
      }

      // Opt-in auto-apply: rules flagged auto_apply create the voucher outright (same draft
      // shape suggestVouchers offers) and reconcile its bank line against the statement row.
      const autoRuleRecords = listRules(db)
      const autoRules: RuleRow[] = autoRuleRecords
        .filter((r) => r.active && r.autoApply && (r.bankLedgerId == null || r.bankLedgerId === ledgerId))
        .map((r) => ({
          id: r.id, pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind,
          matchField: r.matchField === 'reference' ? 'reference' : 'description',
          minAmount: r.minAmount, maxAmount: r.maxAmount, dateFrom: r.dateFrom, dateTo: r.dateTo
        }))
      if (autoRules.length > 0) {
        const stillUnmatched: UnmatchedRow[] = []
        for (const u of unmatched) {
          const like = {
            date: u.date,
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
            narration: renderRuleNarration(autoRuleRecords.find((candidate) => candidate.id === rule.id)?.narrationTemplate ?? null, u.description, u.reference, true),
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
          if (!bankLine || setStmt.run(u.date, bankLine.id).changes !== 1) {
            throw new Error('Auto-created voucher is missing its unreconciled bank line')
          }
          recordRuleHit(db, rule.id)
          createdByRowNo.set(u.rowNo, voucher.id)
          txAutoCreated.push({ date: u.date, description: u.description, amount: u.amount, kind: u.kind, voucherId: voucher.id, ruleId: rule.id })
        }
        txRemaining = stillUnmatched
      }

      // Evidence, accounting effects, rule hit counts, and the summary audit are one commit.
      // Any malformed row or storage failure rolls the complete import back.
      if (statement.length > 0) {
        const dates = statement.map((row) => row.date).sort()
        const inserted = db.prepare(
          `INSERT INTO bank_statement_imports
           (ledger_id, format, file_name, period_from, period_to, opening_balance, closing_balance, source_hash, row_count, imported_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          ledgerId, opts.format ?? 'csv', opts.fileName ?? null, dates[0], dates[dates.length - 1],
          openingBalance, closingBalance, sourceHash, statement.length, opts.actor ?? 'Local user'
        )
        txImportId = Number(inserted.lastInsertRowid)
        const exact = new Map(matches.map((match) => [match.row.rowNo, match.lineId]))
        const already = new Map(alreadyReconciled.map((match) => [match.row.rowNo, match.lineId]))
        const insertRow = db.prepare(
          `INSERT INTO bank_statement_rows
           (import_id, row_no, date, description, reference, direction, amount, running_balance, status, matched_line_id, created_voucher_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const row of statement) {
          const direction = row.deposit > 0 ? 'deposit' : 'withdrawal'
          const amount = row.deposit || row.withdrawal
          const createdVoucherId = createdByRowNo.get(row.rowNo) ?? null
          const matchedLineId = exact.get(row.rowNo) ?? already.get(row.rowNo) ?? null
          insertRow.run(
            txImportId, row.rowNo, row.date, row.description, row.reference, direction, amount, row.balance,
            matchedLineId != null || createdVoucherId != null ? 'matched' : 'bank_only', matchedLineId, createdVoucherId
          )
        }
      }

      writeAudit(db, 'bank_statement', ledgerId, 'import', null,
        { statementRows: statement.length, matched: matches.length, unmatched: txRemaining.length })
      return { autoCreated: txAutoCreated, remaining: txRemaining, importId: txImportId }
    })()
    autoCreated = applied.autoCreated
    remaining = applied.remaining
    importId = applied.importId
  }

  return {
    importId,
    openingBalance,
    closingBalance,
    statementRows: statement.length,
    matched: matches.length,
    alreadyReconciled: alreadyReconciled.length,
    unmatched: remaining,
    matches: matchDetail,
    autoCreated
  }
}

export type ReconciliationStatus = 'bank_only' | 'matched' | 'ignored' | 'timing_difference'

export interface ReconciliationWorkspace {
  ledgerId: number
  ledgerName: string
  latestImport: null | {
    id: number
    format: 'csv' | 'xlsx' | 'ofx' | 'qif' | 'mt940'
    fileName: string | null
    periodFrom: string
    periodTo: string
    importedBy: string
    importedAt: string
    openingBalance: number | null
    closingBalance: number | null
  }
  statementOpeningBalance: number | null
  bookOpeningBalance: number
  openingDifference: number | null
  counts: { matched: number; bankOnly: number; bookOnly: number; ignored: number; timingDifference: number }
  statementRows: {
    id: number; rowNo: number; date: string; description: string; reference: string
    direction: 'deposit' | 'withdrawal'; amount: number; runningBalance: number | null
    status: ReconciliationStatus; matchedLineId: number | null; createdVoucherId: number | null
    note: string | null; reviewedBy: string | null; reviewedAt: string | null
  }[]
  bookOnlyRows: {
    lineId: number; voucherId: number; date: string; number: string; particulars: string
    direction: 'deposit' | 'withdrawal'; amount: number
  }[]
}

/** The latest durable statement import plus every unresolved item on both sides of the books. */
export function reconciliationWorkspace(db: DB, ledgerId: number): ReconciliationWorkspace {
  const ledger = db.prepare('SELECT id, name, opening_balance AS openingBalance FROM ledgers WHERE id = ?').get(ledgerId) as
    | { id: number; name: string; openingBalance: number }
    | undefined
  if (!ledger) throw new Error('Bank ledger not found')
  const latest = db.prepare(
    `SELECT id, format, file_name AS fileName, period_from AS periodFrom, period_to AS periodTo,
            imported_by AS importedBy, imported_at AS importedAt,
            opening_balance AS openingBalance, closing_balance AS closingBalance
     FROM bank_statement_imports WHERE ledger_id = ? ORDER BY imported_at DESC, id DESC LIMIT 1`
  ).get(ledgerId) as ReconciliationWorkspace['latestImport']

  if (!latest) {
    return {
      ledgerId, ledgerName: ledger.name, latestImport: null, statementOpeningBalance: null,
      bookOpeningBalance: ledger.openingBalance, openingDifference: null,
      counts: { matched: 0, bankOnly: 0, bookOnly: 0, ignored: 0, timingDifference: 0 },
      statementRows: [], bookOnlyRows: []
    }
  }

  const statementRows = db.prepare(
    `SELECT id, row_no AS rowNo, date, description, reference, direction, amount,
            running_balance AS runningBalance, status, matched_line_id AS matchedLineId,
            created_voucher_id AS createdVoucherId, note, reviewed_by AS reviewedBy, reviewed_at AS reviewedAt
     FROM bank_statement_rows WHERE import_id = ? ORDER BY row_no`
  ).all(latest.id) as ReconciliationWorkspace['statementRows']
  const matchedLineIds = statementRows.flatMap((row) => row.matchedLineId == null ? [] : [row.matchedLineId])
  const bookRows = db.prepare(
    `SELECT vl.id AS lineId, v.id AS voucherId, v.date, v.number,
            CASE WHEN vl.dr_cr = 'dr' THEN 'deposit' ELSE 'withdrawal' END AS direction,
            vl.amount,
            COALESCE((SELECT GROUP_CONCAT(DISTINCT l2.name) FROM voucher_lines vl2
                      JOIN ledgers l2 ON l2.id = vl2.ledger_id
                      WHERE vl2.voucher_id = v.id AND vl2.ledger_id <> vl.ledger_id), '') AS particulars
     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
     WHERE vl.ledger_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
     ORDER BY v.date, v.id`
  ).all(ledgerId, latest.periodFrom, latest.periodTo) as ReconciliationWorkspace['bookOnlyRows']
  const matchedSet = new Set(matchedLineIds)
  const bookOnlyRows = bookRows.filter((row) => !matchedSet.has(row.lineId))
  const movement = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS amount
     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
     WHERE vl.ledger_id = ? AND v.date < ? AND ${IN_BOOKS}`
  ).get(ledgerId, latest.periodFrom) as { amount: number }
  const bookOpeningBalance = ledger.openingBalance + movement.amount
  const count = (status: ReconciliationStatus): number => statementRows.filter((row) => row.status === status).length

  return {
    ledgerId, ledgerName: ledger.name, latestImport: latest,
    statementOpeningBalance: latest.openingBalance,
    bookOpeningBalance,
    openingDifference: latest.openingBalance == null ? null : latest.openingBalance - bookOpeningBalance,
    counts: {
      matched: count('matched'), bankOnly: count('bank_only'), bookOnly: bookOnlyRows.length,
      ignored: count('ignored'), timingDifference: count('timing_difference')
    },
    statementRows,
    bookOnlyRows
  }
}

export function classifyStatementRow(
  db: DB,
  rowId: number,
  status: 'bank_only' | 'ignored' | 'timing_difference',
  note: string | null,
  actor: string
): void {
  db.transaction(() => {
    const before = db.prepare('SELECT * FROM bank_statement_rows WHERE id = ?').get(rowId) as
      | (Record<string, unknown> & { status: string; matched_line_id: number | null; created_voucher_id: number | null })
      | undefined
    if (!before) throw new Error('Statement row not found')
    if (before.status === 'matched' || before.matched_line_id != null || before.created_voucher_id != null) {
      throw new Error('Matched statement rows cannot be reclassified')
    }
    const updated = db.prepare(
      `UPDATE bank_statement_rows
       SET status = ?, note = ?, reviewed_by = ?, reviewed_at = datetime('now')
       WHERE id = ? AND status <> 'matched' AND matched_line_id IS NULL AND created_voucher_id IS NULL`
    ).run(status, note, actor, rowId)
    if (updated.changes !== 1) throw new Error('Statement row changed during review; retry')
    writeAudit(db, 'bank_statement_row', rowId, 'update', before, { status, note, actor })
  })()
}

export interface BankTransferSuggestion {
  withdrawalRowId: number
  depositRowId: number
  amount: number
  withdrawalDate: string
  depositDate: string
  fromLedgerId: number
  fromLedgerName: string
  toLedgerId: number
  toLedgerName: string
  reference: string
  description: string
  confidence: number
}

/** Opposite bank-only lines of the same amount across two accounts, ranked for user review. */
export function transferSuggestions(db: DB): BankTransferSuggestion[] {
  const rows = db.prepare(
    `SELECT sr.id, sr.date, sr.description, sr.reference, sr.direction, sr.amount,
            si.ledger_id AS ledgerId, l.name AS ledgerName
     FROM bank_statement_rows sr
     JOIN bank_statement_imports si ON si.id = sr.import_id
     JOIN ledgers l ON l.id = si.ledger_id
     WHERE sr.status = 'bank_only'
       AND si.id = (SELECT MAX(si2.id) FROM bank_statement_imports si2 WHERE si2.ledger_id = si.ledger_id)
     ORDER BY sr.date, sr.id`
  ).all() as { id: number; date: string; description: string; reference: string; direction: 'deposit' | 'withdrawal'; amount: number; ledgerId: number; ledgerName: string }[]
  const withdrawals = rows.filter((row) => row.direction === 'withdrawal')
  const deposits = rows.filter((row) => row.direction === 'deposit')
  const usedDeposits = new Set<number>()
  const suggestions: BankTransferSuggestion[] = []
  const transferText = /\b(self|transfer|trf|neft|imps|upi|sweep)\b/i

  for (const withdrawal of withdrawals) {
    const candidates = deposits
      .filter((deposit) => !usedDeposits.has(deposit.id) && deposit.ledgerId !== withdrawal.ledgerId && deposit.amount === withdrawal.amount)
      .map((deposit) => {
        const gap = Math.abs(Date.parse(deposit.date) - Date.parse(withdrawal.date)) / 86_400_000
        const sameReference = !!withdrawal.reference && withdrawal.reference.toLowerCase() === deposit.reference.toLowerCase()
        const textSignal = transferText.test(withdrawal.description) || transferText.test(deposit.description)
        const confidence = Math.min(99, 55 + (gap === 0 ? 20 : gap <= 1 ? 12 : 0) + (sameReference ? 20 : 0) + (textSignal ? 10 : 0))
        return { deposit, gap, confidence, sameReference, textSignal }
      })
      .filter((candidate) => candidate.gap <= 3 && (candidate.sameReference || candidate.textSignal || candidate.gap <= 1))
      .sort((a, b) => b.confidence - a.confidence || a.gap - b.gap)
    const best = candidates[0]
    if (!best) continue
    usedDeposits.add(best.deposit.id)
    suggestions.push({
      withdrawalRowId: withdrawal.id,
      depositRowId: best.deposit.id,
      amount: withdrawal.amount,
      withdrawalDate: withdrawal.date,
      depositDate: best.deposit.date,
      fromLedgerId: withdrawal.ledgerId,
      fromLedgerName: withdrawal.ledgerName,
      toLedgerId: best.deposit.ledgerId,
      toLedgerName: best.deposit.ledgerName,
      reference: withdrawal.reference || best.deposit.reference,
      description: withdrawal.description || best.deposit.description,
      confidence: best.confidence
    })
  }
  return suggestions
}

/** Post one reviewed Contra voucher and bind each statement side to the exact generated line. */
export function postTransfer(
  db: DB,
  withdrawalRowId: number,
  depositRowId: number,
  actor: string
): { voucherId: number } {
  const load = db.prepare(
    `SELECT sr.id, sr.date, sr.description, sr.reference, sr.direction, sr.amount, sr.status,
            si.ledger_id AS ledgerId
     FROM bank_statement_rows sr JOIN bank_statement_imports si ON si.id = sr.import_id
     WHERE sr.id = ?`
  )
  const withdrawal = load.get(withdrawalRowId) as { id: number; date: string; description: string; reference: string; direction: string; amount: number; status: string; ledgerId: number } | undefined
  const deposit = load.get(depositRowId) as typeof withdrawal
  if (!withdrawal || !deposit) throw new Error('Transfer statement row not found')
  if (withdrawal.status !== 'bank_only' || deposit.status !== 'bank_only') throw new Error('Both transfer sides must still be bank-only')
  if (withdrawal.direction !== 'withdrawal' || deposit.direction !== 'deposit') throw new Error('Choose a withdrawal and its matching deposit')
  if (withdrawal.amount !== deposit.amount) throw new Error('Transfer amounts do not agree')
  if (withdrawal.ledgerId === deposit.ledgerId) throw new Error('A transfer must move between two bank accounts')
  const voucherType = db.prepare("SELECT id FROM voucher_types WHERE kind = 'contra' AND is_system = 1").get() as { id: number } | undefined
  if (!voucherType) throw new Error('Contra voucher type not found')

  let voucherId = 0
  db.transaction(() => {
    const voucher = saveVoucher(db, {
      voucherTypeId: voucherType.id,
      date: withdrawal.date > deposit.date ? withdrawal.date : deposit.date,
      number: undefined,
      partyLedgerId: null,
      narration: `Inter-bank transfer · ${withdrawal.description || deposit.description}`,
      reference: withdrawal.reference || deposit.reference || null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: deposit.ledgerId, drCr: 'dr', amount: deposit.amount, costAllocations: [] },
        { ledgerId: withdrawal.ledgerId, drCr: 'cr', amount: withdrawal.amount, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    voucherId = voucher.id
    const depositLine = voucher.lines.find((line) => line.ledgerId === deposit.ledgerId)!
    const withdrawalLine = voucher.lines.find((line) => line.ledgerId === withdrawal.ledgerId)!
    db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?').run(deposit.date, depositLine.id)
    db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?').run(withdrawal.date, withdrawalLine.id)
    db.prepare("UPDATE bank_statement_rows SET status = 'matched', matched_line_id = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
      .run(withdrawalLine.id, actor, withdrawal.id)
    db.prepare("UPDATE bank_statement_rows SET status = 'matched', matched_line_id = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
      .run(depositLine.id, actor, deposit.id)
    db.prepare('INSERT INTO bank_transfer_matches (withdrawal_row_id, deposit_row_id, voucher_id, linked_by) VALUES (?, ?, ?, ?)')
      .run(withdrawal.id, deposit.id, voucher.id, actor)
  })()
  writeAudit(db, 'bank_transfer', voucherId, 'create', null, { withdrawalRowId, depositRowId, actor })
  return { voucherId }
}

export interface BankChargeSuggestion {
  statementRowId: number
  settlementLineId: number
  bankLedgerId: number
  bankLedgerName: string
  date: string
  description: string
  netAmount: number
  grossBookAmount: number
  deductionAmount: number
  suggestedFeeAmount: number
  suggestedTaxAmount: number
  voucherId: number
  voucherNumber: string
  confidence: number
}

/** Find net deposits that plausibly correspond to a larger gross receipt in the books. */
export function chargeExtractionSuggestions(db: DB): BankChargeSuggestion[] {
  const bankRows = db.prepare(
    `SELECT sr.id, sr.date, sr.description, sr.amount, si.ledger_id AS bankLedgerId, l.name AS bankLedgerName
     FROM bank_statement_rows sr
     JOIN bank_statement_imports si ON si.id = sr.import_id
     JOIN ledgers l ON l.id = si.ledger_id
     WHERE sr.status = 'bank_only' AND sr.direction = 'deposit'
       AND si.id = (SELECT MAX(si2.id) FROM bank_statement_imports si2 WHERE si2.ledger_id = si.ledger_id)
     ORDER BY sr.date, sr.id`
  ).all() as { id: number; date: string; description: string; amount: number; bankLedgerId: number; bankLedgerName: string }[]
  const suggestions: BankChargeSuggestion[] = []
  const usedLines = new Set<number>()
  for (const row of bankRows) {
    const candidates = db.prepare(
      `SELECT vl.id AS lineId, vl.amount, v.id AS voucherId, v.number, v.date,
              COALESCE(v.narration, '') AS narration
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND vl.dr_cr = 'dr' AND vl.bank_date IS NULL AND vl.amount > ? AND ${IN_BOOKS}
         AND NOT EXISTS (SELECT 1 FROM bank_charge_extractions bce WHERE bce.settlement_line_id = vl.id)
       ORDER BY ABS(julianday(v.date) - julianday(?)), vl.amount`
    ).all(row.bankLedgerId, row.amount, row.date) as { lineId: number; amount: number; voucherId: number; number: string; date: string; narration: string }[]
    const candidate = candidates.find((book) => {
      const difference = book.amount - row.amount
      const days = Math.abs(Date.parse(book.date) - Date.parse(row.date)) / 86_400_000
      return !usedLines.has(book.lineId) && days <= 5 && difference <= 5_000_000 && difference <= Math.round(book.amount * 0.2)
    })
    if (!candidate) continue
    usedLines.add(candidate.lineId)
    const deduction = candidate.amount - row.amount
    const suggestedTax = Math.round((deduction * 18) / 118)
    const days = Math.abs(Date.parse(candidate.date) - Date.parse(row.date)) / 86_400_000
    suggestions.push({
      statementRowId: row.id, settlementLineId: candidate.lineId, bankLedgerId: row.bankLedgerId,
      bankLedgerName: row.bankLedgerName, date: row.date, description: row.description,
      netAmount: row.amount, grossBookAmount: candidate.amount, deductionAmount: deduction,
      suggestedFeeAmount: deduction - suggestedTax, suggestedTaxAmount: suggestedTax,
      voucherId: candidate.voucherId, voucherNumber: candidate.number,
      confidence: Math.max(55, 92 - Math.round(days * 7))
    })
  }
  return suggestions
}

export function postChargeExtraction(
  db: DB,
  input: { statementRowId: number; settlementLineId: number; feeLedgerId: number; taxLedgerId: number | null; feeAmount: number; taxAmount: number },
  actor: string
): { voucherId: number } {
  const row = db.prepare(
    `SELECT sr.id, sr.date, sr.description, sr.reference, sr.amount, sr.direction, sr.status,
            si.ledger_id AS bankLedgerId
     FROM bank_statement_rows sr JOIN bank_statement_imports si ON si.id = sr.import_id WHERE sr.id = ?`
  ).get(input.statementRowId) as { id: number; date: string; description: string; reference: string; amount: number; direction: string; status: string; bankLedgerId: number } | undefined
  const settlement = db.prepare(
    `SELECT vl.id, vl.amount, vl.dr_cr AS drCr, vl.ledger_id AS ledgerId, v.id AS voucherId
     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id WHERE vl.id = ? AND ${IN_BOOKS}`
  ).get(input.settlementLineId) as { id: number; amount: number; drCr: string; ledgerId: number; voucherId: number } | undefined
  if (!row || !settlement) throw new Error('Settlement evidence not found')
  if (row.status !== 'bank_only' || row.direction !== 'deposit') throw new Error('Statement line is no longer an unresolved deposit')
  if (settlement.ledgerId !== row.bankLedgerId || settlement.drCr !== 'dr') throw new Error('Gross receipt must debit the same bank account')
  const deduction = settlement.amount - row.amount
  if (deduction <= 0 || input.feeAmount <= 0 || input.taxAmount < 0 || input.feeAmount + input.taxAmount !== deduction) {
    throw new Error('Fee and tax must exactly explain the gross-to-net deduction')
  }
  if (input.taxAmount > 0 && input.taxLedgerId == null) throw new Error('Choose a tax ledger for the tax amount')
  const voucherType = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment' AND is_system = 1").get() as { id: number } | undefined
  if (!voucherType) throw new Error('Payment voucher type not found')
  let voucherId = 0
  db.transaction(() => {
    const lines = [
      { ledgerId: input.feeLedgerId, drCr: 'dr' as const, amount: input.feeAmount, costAllocations: [] as never[] },
      ...(input.taxAmount > 0 ? [{ ledgerId: input.taxLedgerId!, drCr: 'dr' as const, amount: input.taxAmount, costAllocations: [] as never[] }] : []),
      { ledgerId: row.bankLedgerId, drCr: 'cr' as const, amount: deduction, costAllocations: [] as never[] }
    ]
    const voucher = saveVoucher(db, {
      voucherTypeId: voucherType.id, date: row.date, number: undefined, partyLedgerId: null,
      narration: `Settlement charges · ${row.description}`, reference: row.reference || null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines, inventory: [], billRefs: [], tds: null
    })
    voucherId = voucher.id
    const bankLine = voucher.lines.find((line) => line.ledgerId === row.bankLedgerId)!
    db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id IN (?, ?)').run(row.date, settlement.id, bankLine.id)
    db.prepare("UPDATE bank_statement_rows SET status = 'matched', matched_line_id = ?, created_voucher_id = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
      .run(settlement.id, voucher.id, actor, row.id)
    db.prepare(
      `INSERT INTO bank_charge_extractions
       (statement_row_id, settlement_line_id, charge_voucher_id, fee_ledger_id, tax_ledger_id, fee_amount, tax_amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, settlement.id, voucher.id, input.feeLedgerId, input.taxLedgerId, input.feeAmount, input.taxAmount, actor)
  })()
  writeAudit(db, 'bank_charge_extraction', voucherId, 'create', null, { ...input, actor })
  return { voucherId }
}

export type ChequeStatus = 'issued' | 'deposited' | 'cleared' | 'bounced' | 'cancelled' | 'stale'

export interface ChequeLifecycleRow {
  voucherId: number
  date: string
  number: string
  voucherKind: 'payment' | 'receipt'
  instrumentNo: string
  instrumentDate: string | null
  bankLedgerId: number
  bankLedgerName: string
  partyName: string
  amount: number
  status: ChequeStatus
  statusDate: string
  note: string | null
  updatedBy: string | null
}

export function chequeLifecycle(db: DB, asOn: string): ChequeLifecycleRow[] {
  const bankIds = new Set(bankLedgers(db).map((ledger) => ledger.id))
  const raw = db.prepare(
    `SELECT v.id AS voucherId, v.date, v.number, vt.kind AS voucherKind,
            v.instrument_no AS instrumentNo, v.instrument_date AS instrumentDate,
            vl.ledger_id AS bankLedgerId, bl.name AS bankLedgerName, vl.amount,
            COALESCE(pl.name, (SELECT GROUP_CONCAT(DISTINCT ol.name) FROM voucher_lines ovl
              JOIN ledgers ol ON ol.id = ovl.ledger_id WHERE ovl.voucher_id = v.id AND ovl.ledger_id <> vl.ledger_id), '') AS partyName,
            cl.status, cl.status_date AS statusDate, cl.note, cl.updated_by AS updatedBy
     FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
     JOIN voucher_lines vl ON vl.voucher_id = v.id JOIN ledgers bl ON bl.id = vl.ledger_id
     LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
     LEFT JOIN cheque_lifecycle cl ON cl.voucher_id = v.id
     WHERE vt.kind IN ('payment','receipt') AND v.instrument_no IS NOT NULL AND trim(v.instrument_no) <> '' AND ${IN_BOOKS}
     ORDER BY COALESCE(v.instrument_date, v.date), v.id`
  ).all() as (Omit<ChequeLifecycleRow, 'status' | 'statusDate'> & { status: Exclude<ChequeStatus, 'stale'> | null; statusDate: string | null })[]
  return raw.filter((row) => bankIds.has(row.bankLedgerId)).map((row) => {
    const base: 'issued' | 'deposited' = row.voucherKind === 'payment' ? 'issued' : 'deposited'
    const effectiveDate = row.instrumentDate ?? row.date
    const staleAt = new Date(`${effectiveDate}T00:00:00Z`).getTime() + 90 * 86_400_000
    const stale = !row.status && staleAt < new Date(`${asOn}T00:00:00Z`).getTime()
    return { ...row, status: stale ? 'stale' : row.status ?? base, statusDate: row.statusDate ?? effectiveDate }
  })
}

export function updateChequeStatus(
  db: DB,
  voucherId: number,
  status: Exclude<ChequeStatus, 'stale'>,
  statusDate: string,
  note: string | null,
  actor: string
): void {
  if (!isValidISODate(statusDate)) throw new Error('Invalid cheque status date')
  const current = chequeLifecycle(db, statusDate).find((row) => row.voucherId === voucherId)
  if (!current) throw new Error('Cheque voucher not found')
  const transition: Record<ChequeStatus, Exclude<ChequeStatus, 'stale'>[]> = {
    issued: ['issued', 'cleared', 'bounced', 'cancelled'],
    deposited: ['deposited', 'cleared', 'bounced', 'cancelled'],
    stale: ['issued', 'deposited', 'cleared', 'bounced', 'cancelled'],
    bounced: ['deposited', 'cleared', 'cancelled'],
    cleared: ['bounced'],
    cancelled: []
  }
  if (!transition[current.status].includes(status)) throw new Error(`Cannot change a ${current.status} cheque to ${status}`)
  const bankIds = new Set(bankLedgers(db).map((ledger) => ledger.id))
  const bankLines = (db.prepare('SELECT id, ledger_id AS ledgerId FROM voucher_lines WHERE voucher_id = ?').all(voucherId) as { id: number; ledgerId: number }[])
    .filter((line) => bankIds.has(line.ledgerId))
  db.transaction(() => {
    db.prepare(
      `INSERT INTO cheque_lifecycle (voucher_id, status, status_date, note, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(voucher_id) DO UPDATE SET status = excluded.status, status_date = excluded.status_date,
         note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')`
    ).run(voucherId, status, statusDate, note, actor)
    if (status === 'cleared') {
      const set = db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?')
      for (const line of bankLines) set.run(statusDate, line.id)
    } else if (status === 'bounced' || status === 'issued' || status === 'deposited') {
      const clear = db.prepare('UPDATE voucher_lines SET bank_date = NULL WHERE id = ?')
      for (const line of bankLines) clear.run(line.id)
    }
  })()
  writeAudit(db, 'cheque_lifecycle', voucherId, 'update', current, { status, statusDate, note, actor })
}

export interface CashDenomination { denominationPaise: number; count: number }
export interface CashCountSession {
  id: number; date: string; cashLedgerId: number; cashLedgerName: string
  denominations: CashDenomination[]; physicalTotal: number; bookBalance: number; difference: number
  status: 'draft' | 'posted' | 'cancelled'; note: string | null; countedBy: string; countedAt: string
  postedBy: string | null; postedAt: string | null; adjustmentVoucherId: number | null
}

export function cashLedgers(db: DB): { id: number; name: string }[] {
  const ids = descendantIdsByName(db, ['Cash-in-Hand'])
  return (db.prepare('SELECT id, name, group_id AS groupId FROM ledgers ORDER BY name').all() as { id: number; name: string; groupId: number }[])
    .filter((ledger) => ids.has(ledger.groupId)).map(({ id, name }) => ({ id, name }))
}

function cashBookBalance(db: DB, ledgerId: number, asOn: string): number {
  const ledger = db.prepare('SELECT opening_balance AS openingBalance FROM ledgers WHERE id = ?').get(ledgerId) as { openingBalance: number } | undefined
  if (!ledger || !cashLedgers(db).some((cash) => cash.id === ledgerId)) throw new Error('Cash ledger not found')
  const movement = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS amount
     FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
     WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS}`
  ).get(ledgerId, asOn) as { amount: number }
  return ledger.openingBalance + movement.amount
}

function normalizeDenominations(lines: CashDenomination[]): CashDenomination[] {
  const seen = new Set<number>()
  return lines.filter((line) => line.count > 0).map((line) => {
    if (!Number.isInteger(line.denominationPaise) || line.denominationPaise <= 0 || !Number.isInteger(line.count) || line.count < 0 || line.count > 1_000_000) throw new Error('Invalid denomination count')
    if (seen.has(line.denominationPaise)) throw new Error('Duplicate cash denomination')
    seen.add(line.denominationPaise)
    return line
  }).sort((a, b) => b.denominationPaise - a.denominationPaise)
}

export function cashCountPreview(db: DB, ledgerId: number, date: string, lines: CashDenomination[]): Omit<CashCountSession, 'id' | 'cashLedgerName' | 'status' | 'note' | 'countedBy' | 'countedAt' | 'postedBy' | 'postedAt' | 'adjustmentVoucherId'> {
  if (!isValidISODate(date)) throw new Error('Invalid count date')
  const denominations = normalizeDenominations(lines)
  const physicalTotal = denominations.reduce((sum, line) => sum + line.denominationPaise * line.count, 0)
  if (!Number.isSafeInteger(physicalTotal)) throw new Error('Cash count is too large')
  const bookBalance = cashBookBalance(db, ledgerId, date)
  return { date, cashLedgerId: ledgerId, denominations, physicalTotal, bookBalance, difference: physicalTotal - bookBalance }
}

function mapCashCount(row: Record<string, unknown>): CashCountSession {
  return {
    id: Number(row.id), date: String(row.date), cashLedgerId: Number(row.cashLedgerId), cashLedgerName: String(row.cashLedgerName),
    denominations: JSON.parse(String(row.denominationsJson)) as CashDenomination[], physicalTotal: Number(row.physicalTotal),
    bookBalance: Number(row.bookBalance), difference: Number(row.difference), status: row.status as CashCountSession['status'],
    note: row.note == null ? null : String(row.note), countedBy: String(row.countedBy), countedAt: String(row.countedAt),
    postedBy: row.postedBy == null ? null : String(row.postedBy), postedAt: row.postedAt == null ? null : String(row.postedAt),
    adjustmentVoucherId: row.adjustmentVoucherId == null ? null : Number(row.adjustmentVoucherId)
  }
}

export function listCashCounts(db: DB): CashCountSession[] {
  return (db.prepare(
    `SELECT cc.*, cc.cash_ledger_id AS cashLedgerId, l.name AS cashLedgerName,
            cc.denominations_json AS denominationsJson, cc.physical_total AS physicalTotal,
            cc.book_balance AS bookBalance, cc.counted_by AS countedBy, cc.counted_at AS countedAt,
            cc.posted_by AS postedBy, cc.posted_at AS postedAt, cc.adjustment_voucher_id AS adjustmentVoucherId
     FROM cash_count_sessions cc JOIN ledgers l ON l.id = cc.cash_ledger_id ORDER BY cc.date DESC, cc.id DESC`
  ).all() as Record<string, unknown>[]).map(mapCashCount)
}

export function saveCashCount(db: DB, ledgerId: number, date: string, lines: CashDenomination[], note: string | null, actor: string): CashCountSession {
  const preview = cashCountPreview(db, ledgerId, date, lines)
  const result = db.prepare(
    `INSERT INTO cash_count_sessions
     (date, cash_ledger_id, denominations_json, physical_total, book_balance, difference, note, counted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(date, ledgerId, JSON.stringify(preview.denominations), preview.physicalTotal, preview.bookBalance, preview.difference, note, actor)
  const id = Number(result.lastInsertRowid)
  writeAudit(db, 'cash_count', id, 'create', null, preview)
  return listCashCounts(db).find((row) => row.id === id)!
}

export function postCashCount(db: DB, id: number, adjustmentLedgerId: number | null, actor: string): CashCountSession {
  const count = listCashCounts(db).find((row) => row.id === id)
  if (!count) throw new Error('Cash count not found')
  if (count.status !== 'draft') throw new Error('Only a draft cash count can be posted')
  if (count.difference !== 0 && adjustmentLedgerId == null) throw new Error('Choose an adjustment ledger for the difference')
  if (adjustmentLedgerId === count.cashLedgerId) throw new Error('Adjustment ledger must differ from the cash ledger')
  let voucherId: number | null = null
  db.transaction(() => {
    if (count.difference !== 0) {
      const voucherType = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' AND is_system = 1").get() as { id: number } | undefined
      if (!voucherType) throw new Error('Journal voucher type not found')
      const amount = Math.abs(count.difference)
      const cashSide = count.difference > 0 ? 'dr' : 'cr'
      const voucher = saveVoucher(db, {
        voucherTypeId: voucherType.id, date: count.date, number: undefined, partyLedgerId: null,
        narration: `Approved physical cash count difference · session #${count.id}`, reference: null,
        instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
        transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: count.cashLedgerId, drCr: cashSide, amount, costAllocations: [] },
          { ledgerId: adjustmentLedgerId!, drCr: cashSide === 'dr' ? 'cr' : 'dr', amount, costAllocations: [] }
        ], inventory: [], billRefs: [], tds: null
      })
      voucherId = voucher.id
    }
    db.prepare("UPDATE cash_count_sessions SET status = 'posted', posted_by = ?, posted_at = datetime('now'), adjustment_voucher_id = ? WHERE id = ?")
      .run(actor, voucherId, id)
  })()
  writeAudit(db, 'cash_count', id, 'update', count, { status: 'posted', adjustmentVoucherId: voucherId, actor })
  return listCashCounts(db).find((row) => row.id === id)!
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
  confidenceBp: number
  reviewedHits: number
  rejectedHits: number
  source: 'manual' | 'learned'
  rolledBackAt: string | null
  bankLedgerId: number | null
  bankLedgerName: string | null
  dateFrom: string | null
  dateTo: string | null
  narrationTemplate: string | null
}

export function listRules(db: DB): BankRuleRecord[] {
  return (
    db
      .prepare(
        `SELECT r.id, r.pattern, r.match_field AS matchField, r.ledger_id AS ledgerId,
                l.name AS ledgerName, r.kind, r.min_amount AS minAmount, r.max_amount AS maxAmount,
                r.auto_apply AS autoApply, r.active, r.hits,
                r.confidence_bp AS confidenceBp, r.reviewed_hits AS reviewedHits,
                r.rejected_hits AS rejectedHits, r.source, r.rolled_back_at AS rolledBackAt,
                r.bank_ledger_id AS bankLedgerId, bl.name AS bankLedgerName,
                r.date_from AS dateFrom, r.date_to AS dateTo, r.narration_template AS narrationTemplate
         FROM bank_rules r JOIN ledgers l ON l.id = r.ledger_id
         LEFT JOIN ledgers bl ON bl.id = r.bank_ledger_id
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
       min_amount = ?, max_amount = ?, auto_apply = ?, active = ?, bank_ledger_id = ?,
       date_from = ?, date_to = ?, narration_template = ?, rolled_back_at = CASE WHEN ? THEN NULL ELSE rolled_back_at END
       WHERE id = ?`
    ).run(
      input.pattern, matchField, input.ledgerId, input.kind, minAmount, maxAmount, autoApply, input.active ? 1 : 0,
      input.bankLedgerId ?? null, input.dateFrom ?? null, input.dateTo ?? null, input.narrationTemplate ?? null,
      input.active ? 1 : 0, id
    )
    writeAudit(db, 'bank_rule', id, 'update', before, input)
  } else {
    const source = input.source ?? 'manual'
    const confidence = source === 'learned' ? 6000 : 9000
    const res = db
      .prepare(
        `INSERT INTO bank_rules
         (pattern, match_field, ledger_id, kind, min_amount, max_amount, auto_apply, active, source, confidence_bp,
          bank_ledger_id, date_from, date_to, narration_template)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.pattern, matchField, input.ledgerId, input.kind, minAmount, maxAmount, autoApply,
        input.active ? 1 : 0, source, confidence, input.bankLedgerId ?? null, input.dateFrom ?? null,
        input.dateTo ?? null, input.narrationTemplate ?? null
      )
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
  const res = db.prepare(
    `UPDATE bank_rules SET hits = hits + 1, reviewed_hits = reviewed_hits + 1,
     confidence_bp = MIN(10000, confidence_bp + 500), rolled_back_at = NULL WHERE id = ?`
  ).run(ruleId)
  if (res.changes === 0) throw new Error('Bank rule not found')
}

/** Reject a proposed categorisation without deleting its learning history. */
export function rejectRuleSuggestion(db: DB, ruleId: number): BankRuleRecord {
  const before = listRules(db).find((rule) => rule.id === ruleId)
  if (!before) throw new Error('Bank rule not found')
  db.prepare(
    `UPDATE bank_rules SET rejected_hits = rejected_hits + 1,
     confidence_bp = MAX(0, confidence_bp - 1500), active = CASE WHEN confidence_bp <= 1500 THEN 0 ELSE active END
     WHERE id = ?`
  ).run(ruleId)
  const after = listRules(db).find((rule) => rule.id === ruleId)!
  writeAudit(db, 'bank_rule', ruleId, 'update', before, after)
  return after
}

/** One-click rollback for a learned mapping. It remains inspectable and can be re-enabled. */
export function rollbackRule(db: DB, ruleId: number): BankRuleRecord {
  const before = listRules(db).find((rule) => rule.id === ruleId)
  if (!before) throw new Error('Bank rule not found')
  db.prepare("UPDATE bank_rules SET active = 0, rolled_back_at = datetime('now') WHERE id = ?").run(ruleId)
  const after = listRules(db).find((rule) => rule.id === ruleId)!
  writeAudit(db, 'bank_rule', ruleId, 'update', before, after)
  return after
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

function renderRuleNarration(template: string | null, description: string, reference: string, autoCreated: boolean): string {
  const rendered = template
    ? template.replaceAll('{description}', description).replaceAll('{reference}', reference)
    : description
  return autoCreated ? `${rendered} (auto-created by bank rule)` : rendered
}

/** Active bank rules in the shared matcher's RuleRow shape (matchField/amount bounds included). */
function activeRuleRows(db: DB, bankLedgerId: number): { rules: RuleRow[]; ruleNames: Map<number, string> } {
  const allRules = listRules(db)
  const rules: RuleRow[] = allRules
    .filter((r) => r.active && (r.bankLedgerId == null || r.bankLedgerId === bankLedgerId))
    .map((r) => ({
      id: r.id, pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind,
      matchField: r.matchField === 'reference' ? 'reference' : 'description',
      minAmount: r.minAmount, maxAmount: r.maxAmount, dateFrom: r.dateFrom, dateTo: r.dateTo
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
  const { rules, ruleNames } = activeRuleRows(db, ledgerId)
  const ruleRecords = new Map(listRules(db).map((rule) => [rule.id, rule]))

  return unmatched.map((u) => {
    const statementLike = { date: u.date, description: u.description, reference: u.reference, deposit: u.kind === 'deposit' ? u.amount : 0, withdrawal: u.kind === 'withdrawal' ? u.amount : 0 }
    const match = matchRules([statementLike], rules)[0]
    if (!match) return { statementRow: u, suggestion: null }

    const rule = match.rule
    const isPayment = rule.kind === 'payment'
    const voucherDraft: BankVoucherDraft = {
      date: u.date,
      narration: renderRuleNarration(ruleRecords.get(rule.id)?.narrationTemplate ?? null, u.description, u.reference, false),
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
