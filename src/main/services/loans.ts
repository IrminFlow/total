// Loans and EMI schedules (WP 4.4). A loan's terms + prepayments generate its schedule
// (src/shared/loanSchedule.ts); the rows are stored in loan_schedules so a posted instalment keeps
// its voucher. "Post EMI" creates the payment voucher — Dr the loan ledger (principal), Dr the
// interest ledger (interest), Cr the bank (the instalment) — or, for a capitalised moratorium
// month, a journal Dr interest / Cr loan. A row counts as posted while its voucher is live: binning
// the voucher re-opens the instalment. Instalments post in order.
import type { DB } from '../db/connection'
import {
  generateSchedule, interestBetween, type LoanSchedule, type LoanTerms, type Prepayment, type ScheduleRow
} from '@shared/loanSchedule'
import {
  loanInputSchema, loanPrepaymentInputSchema, postEmiSchema,
  type EmiReminder, type LoanDetail, type LoanInput, type LoanPrepaymentInput, type LoanScheduleRow, type LoanSummary, type PostEmiInput
} from '@shared/cashFinance'
import { fyOf, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { writeAudit } from './audit'
import { findOrCreateLedger } from './masters'
import { closingBalances } from './reports'
import { saveVoucher } from './vouchers'
import { addDays, isCashOrBankLedger, ledgerInfo, postingBlock, systemVoucherTypeId } from './cashFinanceCommon'

export const INTEREST_LEDGER = 'Interest on Loans'
export const INTEREST_GROUP = 'Indirect Expenses'

interface LoanDbRow {
  id: number; name: string; loan_ledger_id: number; bank_ledger_id: number | null; interest_ledger_id: number | null
  principal: number; annual_rate_milli: number; tenure_months: number; disbursed_on: string; first_due_date: string
  method: 'reducing' | 'flat'; moratorium_months: number; moratorium_mode: 'capitalise' | 'interest_only'
  emi_override: number | null; status: 'active' | 'closed'; notes: string | null
}

interface ScheduleDbRow {
  id: number; loan_id: number; seq: number; due_date: string; kind: ScheduleRow['kind']; opening: number; payment: number
  interest: number; principal: number; closing: number; voucher_id: number | null; voucher_number: string | null; live: number | null
}

const termsOf = (l: LoanDbRow): LoanTerms => ({
  principal: l.principal, annualRateMilli: l.annual_rate_milli, tenureMonths: l.tenure_months, firstDueDate: l.first_due_date,
  method: l.method, moratoriumMonths: l.moratorium_months, moratoriumMode: l.moratorium_mode, emiOverride: l.emi_override
})

function loanRow(db: DB, id: number): LoanDbRow {
  const row = db.prepare('SELECT * FROM loans WHERE id = ?').get(id) as LoanDbRow | undefined
  if (!row) throw new Error('Loan not found')
  return row
}

function prepaymentsOf(db: DB, loanId: number): (Prepayment & { id: number })[] {
  return db.prepare('SELECT id, date, amount, effect FROM loan_prepayments WHERE loan_id = ? ORDER BY date, id').all(loanId) as (Prepayment & { id: number })[]
}

function scheduleRows(db: DB, loanId: number): ScheduleDbRow[] {
  return db
    .prepare(
      `SELECT s.*, v.number AS voucher_number, CASE WHEN v.id IS NOT NULL AND v.deleted_at IS NULL THEN 1 ELSE 0 END AS live
       FROM loan_schedules s LEFT JOIN vouchers v ON v.id = s.voucher_id
       WHERE s.loan_id = ? ORDER BY s.seq`
    )
    .all(loanId) as ScheduleDbRow[]
}

const mapSchedule = (r: ScheduleDbRow): LoanScheduleRow => ({
  id: r.id, loanId: r.loan_id, seq: r.seq, dueDate: r.due_date, kind: r.kind, opening: r.opening, payment: r.payment,
  interest: r.interest, principal: r.principal, closing: r.closing,
  voucherId: r.live ? r.voucher_id : null, voucherNumber: r.live ? r.voucher_number : null, posted: !!r.live
})

/** Regenerate the unposted part of a loan's schedule from its terms + prepayments. Posted rows
 *  must come out of the generator unchanged — otherwise the change is refused. */
function regenerate(db: DB, loan: LoanDbRow): LoanSchedule {
  const gen = generateSchedule(termsOf(loan), prepaymentsOf(db, loan.id))
  const existing = scheduleRows(db, loan.id)
  const posted = existing.filter((r) => r.live)
  for (const p of posted) {
    const g = gen.rows[p.seq - 1]
    if (!g || g.dueDate !== p.due_date || g.kind !== p.kind || g.payment !== p.payment || g.interest !== p.interest || g.principal !== p.principal) {
      throw new Error(`That change would alter instalment ${p.seq} (${p.due_date}), which is already posted — bin its voucher first`)
    }
  }
  const postedSeq = new Set(posted.map((p) => p.seq))
  db.prepare(
    `DELETE FROM loan_schedules WHERE loan_id = ? AND (voucher_id IS NULL OR voucher_id NOT IN (SELECT id FROM vouchers WHERE deleted_at IS NULL))`
  ).run(loan.id)
  const ins = db.prepare(
    `INSERT INTO loan_schedules (loan_id, seq, due_date, kind, opening, payment, interest, principal, closing)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  // Rows past the new schedule's end that were posted can't exist (checked above), so only
  // unposted seqs are (re)inserted.
  for (const r of gen.rows) {
    if (postedSeq.has(r.seq)) continue
    ins.run(loan.id, r.seq, r.dueDate, r.kind, r.opening, r.payment, r.interest, r.principal, r.closing)
  }
  return gen
}

function summary(db: DB, loan: LoanDbRow, today: string, balances: Map<number, number>): LoanSummary {
  const rows = scheduleRows(db, loan.id).map(mapSchedule)
  const name = (id: number | null): string | null => (id == null ? null : ledgerInfo(db, id)?.name ?? null)
  const lastPosted = [...rows].reverse().find((r) => r.posted)
  const pending = rows.filter((r) => !r.posted)
  const next = pending.find((r) => r.payment > 0 || r.kind === 'moratorium') ?? null
  const fy = fyOf(today)
  const firstEmi = rows.find((r) => r.kind === 'emi')
  return {
    id: loan.id, name: loan.name, loanLedgerId: loan.loan_ledger_id, loanLedgerName: name(loan.loan_ledger_id) ?? '',
    bankLedgerId: loan.bank_ledger_id, bankLedgerName: name(loan.bank_ledger_id), interestLedgerId: loan.interest_ledger_id,
    interestLedgerName: name(loan.interest_ledger_id), principal: loan.principal, annualRateMilli: loan.annual_rate_milli,
    tenureMonths: loan.tenure_months, disbursedOn: loan.disbursed_on, firstDueDate: loan.first_due_date, method: loan.method,
    moratoriumMonths: loan.moratorium_months, moratoriumMode: loan.moratorium_mode, emiOverride: loan.emi_override,
    status: loan.status, notes: loan.notes,
    emi: firstEmi?.payment ?? 0,
    outstanding: lastPosted ? lastPosted.closing : loan.principal,
    ledgerBalance: -(balances.get(loan.loan_ledger_id) ?? 0),
    postedCount: rows.filter((r) => r.posted).length,
    pendingCount: pending.length,
    nextDue: next ? { scheduleId: next.id, dueDate: next.dueDate, payment: next.payment } : null,
    overdueCount: pending.filter((r) => r.dueDate <= today).length,
    interestThisFy: interestBetween(rows, fy.from, fy.to),
    totalInterest: rows.reduce((s, r) => s + r.interest, 0)
  }
}

export function listLoans(db: DB, today: string = todayISO()): LoanSummary[] {
  const balances = closingBalances(db, today)
  return (db.prepare('SELECT * FROM loans ORDER BY status, name').all() as LoanDbRow[]).map((l) => summary(db, l, today, balances))
}

export function getLoan(db: DB, id: number, today: string = todayISO()): LoanDetail {
  const loan = loanRow(db, id)
  return {
    loan: summary(db, loan, today, closingBalances(db, today)),
    schedule: scheduleRows(db, id).map(mapSchedule),
    prepayments: prepaymentsOf(db, id)
  }
}

/** Schedule preview for unsaved terms (the New loan form). */
export function previewSchedule(raw: LoanInput): LoanSchedule {
  const input = loanInputSchema.parse(raw)
  return generateSchedule({
    principal: input.principal, annualRateMilli: input.annualRateMilli, tenureMonths: input.tenureMonths, firstDueDate: input.firstDueDate,
    method: input.method, moratoriumMonths: input.moratoriumMonths, moratoriumMode: input.moratoriumMode, emiOverride: input.emiOverride
  })
}

function checkLedgers(db: DB, input: ReturnType<typeof loanInputSchema.parse>): void {
  const loanLedger = ledgerInfo(db, input.loanLedgerId)
  if (!loanLedger) throw new Error('Loan ledger not found')
  if (loanLedger.nature !== 'liability') throw new Error(`${loanLedger.name} is not a liability ledger — pick the loan account (e.g. under Secured Loans)`)
  if (isCashOrBankLedger(db, input.loanLedgerId)) throw new Error('The loan ledger cannot be a cash or bank account')
  if (input.bankLedgerId != null && !isCashOrBankLedger(db, input.bankLedgerId)) throw new Error('The EMI bank must be a cash or bank ledger')
  if (input.interestLedgerId != null) {
    const il = ledgerInfo(db, input.interestLedgerId)
    if (!il || il.nature !== 'expense') throw new Error('The interest ledger must be an expense ledger')
  }
}

export function saveLoan(db: DB, raw: LoanInput, id?: number): LoanDetail {
  const input = loanInputSchema.parse(raw)
  checkLedgers(db, input)
  const run = db.transaction((): number => {
    const before = id ? getLoan(db, id) : null
    const vals = [
      input.name, input.loanLedgerId, input.bankLedgerId, input.interestLedgerId, input.principal, input.annualRateMilli,
      input.tenureMonths, input.disbursedOn, input.firstDueDate, input.method, input.moratoriumMonths, input.moratoriumMode,
      input.emiOverride, input.notes
    ]
    let loanId: number
    if (id) {
      const stored = loanRow(db, id)
      // Ledgers are fixed once an instalment is posted (the vouchers already name them).
      if (before!.schedule.some((r) => r.posted)) {
        const interestAfter = input.interestLedgerId ?? stored.interest_ledger_id
        if (input.loanLedgerId !== stored.loan_ledger_id || input.bankLedgerId !== stored.bank_ledger_id || interestAfter !== stored.interest_ledger_id) {
          throw new Error('Instalments are posted — the loan, bank and interest ledgers can no longer change')
        }
        vals[3] = interestAfter
      }
      db.prepare(
        `UPDATE loans SET name = ?, loan_ledger_id = ?, bank_ledger_id = ?, interest_ledger_id = ?, principal = ?, annual_rate_milli = ?,
           tenure_months = ?, disbursed_on = ?, first_due_date = ?, method = ?, moratorium_months = ?, moratorium_mode = ?,
           emi_override = ?, notes = ? WHERE id = ?`
      ).run(...vals, id)
      loanId = id
    } else {
      loanId = Number(db.prepare(
        `INSERT INTO loans (name, loan_ledger_id, bank_ledger_id, interest_ledger_id, principal, annual_rate_milli, tenure_months,
           disbursed_on, first_due_date, method, moratorium_months, moratorium_mode, emi_override, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...vals).lastInsertRowid)
    }
    regenerate(db, loanRow(db, loanId))
    const after = getLoan(db, loanId)
    writeAudit(db, 'loan', loanId, id ? 'update' : 'create', before ? { ...before.loan, schedule: before.schedule.length } : null, { ...after.loan, schedule: after.schedule.length })
    return loanId
  })
  return getLoan(db, run())
}

export function setLoanStatus(db: DB, id: number, status: 'active' | 'closed'): LoanSummary {
  const before = getLoan(db, id).loan
  db.prepare('UPDATE loans SET status = ? WHERE id = ?').run(status, id)
  const after = getLoan(db, id).loan
  writeAudit(db, 'loan', id, 'update', before, after)
  return after
}

export function deleteLoan(db: DB, id: number): void {
  const detail = getLoan(db, id)
  if (detail.schedule.some((r) => r.posted)) throw new Error('This loan has posted instalments — bin their vouchers first, or mark the loan closed')
  // Binned instalment vouchers would otherwise be restorable against a loan that no longer exists.
  const binned = (db.prepare('SELECT COUNT(*) AS n FROM loan_vouchers WHERE loan_id = ?').get(id) as { n: number }).n
  if (binned > 0) throw new Error(`This loan still has ${binned} instalment voucher${binned === 1 ? '' : 's'} in the bin — purge them first`)
  db.prepare('DELETE FROM loans WHERE id = ?').run(id)
  writeAudit(db, 'loan', id, 'delete', { ...detail.loan, schedule: detail.schedule.length }, null)
}

export function addPrepayment(db: DB, raw: LoanPrepaymentInput): LoanDetail {
  const input = loanPrepaymentInputSchema.parse(raw)
  const run = db.transaction(() => {
    const loan = loanRow(db, input.loanId)
    if (loan.method === 'flat') throw new Error('Prepayments apply to reducing-balance loans only')
    if (input.date < loan.disbursed_on) throw new Error('A prepayment cannot come before the disbursement')
    const lastPosted = [...scheduleRows(db, loan.id)].reverse().find((r) => r.live)
    if (lastPosted && input.date <= lastPosted.due_date) throw new Error(`Instalments up to ${lastPosted.due_date} are posted — a prepayment must come after them`)
    const pid = Number(db.prepare('INSERT INTO loan_prepayments (loan_id, date, amount, effect) VALUES (?, ?, ?, ?)')
      .run(loan.id, input.date, input.amount, input.effect).lastInsertRowid)
    regenerate(db, loan)
    writeAudit(db, 'loan', loan.id, 'update', null, { prepayment: { id: pid, ...input } })
  })
  run()
  return getLoan(db, input.loanId)
}

export function deletePrepayment(db: DB, prepaymentId: number): LoanDetail {
  const row = db.prepare('SELECT * FROM loan_prepayments WHERE id = ?').get(prepaymentId) as { id: number; loan_id: number; date: string; amount: number; effect: string } | undefined
  if (!row) throw new Error('Prepayment not found')
  db.transaction(() => {
    const posted = scheduleRows(db, row.loan_id).find((r) => r.live && r.kind === 'prepayment' && r.due_date === row.date)
    if (posted) throw new Error('That prepayment is posted — bin its voucher first')
    db.prepare('DELETE FROM loan_prepayments WHERE id = ?').run(prepaymentId)
    regenerate(db, loanRow(db, row.loan_id))
    writeAudit(db, 'loan', row.loan_id, 'update', { prepayment: row }, { prepayment: null })
  })()
  return getLoan(db, row.loan_id)
}

/** Post one instalment: the payment voucher (or the capitalised-interest journal). */
export function postEmi(db: DB, raw: PostEmiInput): LoanScheduleRow {
  const input = postEmiSchema.parse(raw)
  const run = db.transaction((): number => {
    const row = db.prepare('SELECT * FROM loan_schedules WHERE id = ?').get(input.scheduleId) as ScheduleDbRow | undefined
    if (!row) throw new Error('Instalment not found')
    const loan = loanRow(db, row.loan_id)
    if (loan.status !== 'active') throw new Error('This loan is closed')
    const rows = scheduleRows(db, loan.id)
    const me = rows.find((r) => r.id === row.id)!
    if (me.live) throw new Error(`Instalment ${row.seq} is already posted (voucher ${me.voucher_number})`)
    const earlier = rows.find((r) => r.seq < row.seq && !r.live)
    if (earlier) throw new Error(`Post instalment ${earlier.seq} (${earlier.due_date}) first — instalments post in order`)
    const date = input.date ?? row.due_date
    const block = postingBlock(db, date)
    if (block) throw new Error(block)

    let interestLedgerId = loan.interest_ledger_id
    if (row.interest > 0 && interestLedgerId == null) {
      interestLedgerId = findOrCreateLedger(db, INTEREST_LEDGER, INTEREST_GROUP)
      db.prepare('UPDATE loans SET interest_ledger_id = ? WHERE id = ?').run(interestLedgerId, loan.id)
    }
    const capitalised = row.kind === 'moratorium' && row.payment === 0
    const total = rows.filter((r) => r.kind === 'emi').length
    const emiNo = rows.filter((r) => r.kind === 'emi' && r.seq <= row.seq).length
    const what = row.kind === 'emi' ? `EMI ${emiNo}/${total}` : row.kind === 'prepayment' ? 'Prepayment' : 'Moratorium interest'
    const narration = `${what} — ${loan.name} (principal ${formatPaise(Math.max(0, row.principal), { symbol: true })}, interest ${formatPaise(row.interest, { symbol: true })})`
    const lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations: [] }[] = []
    let kind: 'payment' | 'journal'
    if (capitalised) {
      if (row.interest === 0) throw new Error('Nothing to post for this month')
      kind = 'journal'
      lines.push({ ledgerId: interestLedgerId!, drCr: 'dr', amount: row.interest, costAllocations: [] })
      lines.push({ ledgerId: loan.loan_ledger_id, drCr: 'cr', amount: row.interest, costAllocations: [] })
    } else {
      const bank = input.bankLedgerId ?? loan.bank_ledger_id
      if (bank == null) throw new Error('Pick the bank the instalment is paid from')
      if (!isCashOrBankLedger(db, bank)) throw new Error('The EMI bank must be a cash or bank ledger')
      kind = 'payment'
      if (row.principal > 0) lines.push({ ledgerId: loan.loan_ledger_id, drCr: 'dr', amount: row.principal, costAllocations: [] })
      if (row.interest > 0) lines.push({ ledgerId: interestLedgerId!, drCr: 'dr', amount: row.interest, costAllocations: [] })
      lines.push({ ledgerId: bank, drCr: 'cr', amount: row.payment, costAllocations: [] })
    }
    const voucher = saveVoucher(db, {
      voucherTypeId: systemVoucherTypeId(db, kind),
      date,
      partyLedgerId: null,
      narration,
      reference: `${loan.name} #${row.seq}`.slice(0, 60),
      lines,
      inventory: [],
      billRefs: [],
      tds: null
    })
    db.prepare("UPDATE loan_schedules SET voucher_id = ?, posted_at = datetime('now') WHERE id = ?").run(voucher.id, row.id)
    db.prepare('INSERT INTO loan_vouchers (voucher_id, loan_id, seq, kind) VALUES (?, ?, ?, ?)').run(voucher.id, loan.id, row.seq, row.kind)
    writeAudit(db, 'loan', loan.id, 'update',
      { scheduleId: row.id, posted: false, interestLedgerId: loan.interest_ledger_id },
      { scheduleId: row.id, seq: row.seq, posted: true, voucherId: voucher.id, interestLedgerId })
    return row.id
  })
  const id = run()
  const row = db.prepare('SELECT loan_id FROM loan_schedules WHERE id = ?').get(id) as { loan_id: number }
  return scheduleRows(db, row.loan_id).map(mapSchedule).find((r) => r.id === id)!
}

/** Unposted instalments due within `days` of today (or overdue) on active loans — the dashboard
 *  compliance card's reminder and the forecast's EMI outflows (with a wider window). */
export function emiReminders(db: DB, today: string, days = 7): EmiReminder[] {
  return dueInstalments(db, '0000-01-01', addDays(today, days)).map((r) => ({ ...r, overdue: r.dueDate < today }))
}

export function dueInstalments(db: DB, from: string, to: string): Omit<EmiReminder, 'overdue'>[] {
  return (db
    .prepare(
      `SELECT l.id AS loanId, l.name AS loanName, s.id AS scheduleId, s.due_date AS dueDate, s.payment
       FROM loan_schedules s JOIN loans l ON l.id = s.loan_id
       LEFT JOIN vouchers v ON v.id = s.voucher_id AND v.deleted_at IS NULL
       WHERE l.status = 'active' AND v.id IS NULL AND s.payment > 0 AND s.due_date BETWEEN ? AND ?
       ORDER BY s.due_date, l.name`
    )
    .all(from, to) as Omit<EmiReminder, 'overdue'>[])
}

/** Unposted instalments of a financial year (year-end warning). */
export function unpostedForYear(db: DB, from: string, to: string): { loanId: number; loanName: string; count: number; amount: number }[] {
  return db
    .prepare(
      `SELECT l.id AS loanId, l.name AS loanName, COUNT(*) AS count, SUM(s.payment + CASE WHEN s.payment = 0 THEN s.interest ELSE 0 END) AS amount
       FROM loan_schedules s JOIN loans l ON l.id = s.loan_id
       LEFT JOIN vouchers v ON v.id = s.voucher_id AND v.deleted_at IS NULL
       WHERE l.status = 'active' AND v.id IS NULL AND s.due_date BETWEEN ? AND ?
       GROUP BY l.id ORDER BY l.name`
    )
    .all(from, to) as { loanId: number; loanName: string; count: number; amount: number }[]
}
