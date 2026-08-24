/**
 * Attendance, salary advances, and the two things they do to a pay run.
 *
 * Payable days used to be typed into the run and lost the moment it posted; an advance was a
 * deduction head somebody remembered to remove when it finished. Both are now records: attendance
 * is one row per employee per month, and an advance is a balance that runs down as the payslips
 * recover it.
 *
 * Nothing here posts a voucher. `payableDaysFor` and `dueRecoveries` feed the pay run, and the
 * run is still the only thing that writes to the books.
 */
import type { DB } from '../db/connection'
import { daysInMonth } from '@shared/payroll'
import { writeAudit } from './audit'

// ---------- attendance ----------

export interface AttendanceRow {
  id: number
  employeeId: number
  employeeName: string
  month: string
  presentDays: number
  paidLeaveDays: number
  lopDays: number
  note: string | null
  /** presentDays + paidLeaveDays, which is what the pay run pays for. */
  payableDays: number
  /** Calendar days in the month, for the proration denominator. */
  monthDays: number
}

interface Row {
  id: number
  employee_id: number
  employeeName: string
  month: string
  present_days: number
  paid_leave_days: number
  lop_days: number
  note: string | null
}

const map = (r: Row, monthDays: number): AttendanceRow => ({
  id: r.id,
  employeeId: r.employee_id,
  employeeName: r.employeeName,
  month: r.month,
  presentDays: r.present_days,
  paidLeaveDays: r.paid_leave_days,
  lopDays: r.lop_days,
  note: r.note,
  payableDays: r.present_days + r.paid_leave_days,
  monthDays
})

/**
 * The month's register: every active employee, with a row whether or not one was entered.
 *
 * An employee with no attendance row is shown as a full month rather than as zero days. That is
 * the right default — most months, for most people, nothing happened — and showing them as absent
 * would turn a blank register into a month of unpaid staff.
 */
export function attendanceForMonth(db: DB, month: string): AttendanceRow[] {
  const monthDays = daysInMonth(month)
  const saved = new Map(
    (
      db
        .prepare(
          `SELECT a.*, e.name AS employeeName FROM attendance a JOIN employees e ON e.id = a.employee_id
           WHERE a.month = ?`
        )
        .all(month) as Row[]
    ).map((r) => [r.employee_id, r])
  )
  const employees = db
    .prepare('SELECT id, name FROM employees WHERE active = 1 ORDER BY name')
    .all() as { id: number; name: string }[]

  return employees.map((e) => {
    const row = saved.get(e.id)
    if (row) return map(row, monthDays)
    return {
      id: 0,
      employeeId: e.id,
      employeeName: e.name,
      month,
      presentDays: monthDays,
      paidLeaveDays: 0,
      lopDays: 0,
      note: null,
      payableDays: monthDays,
      monthDays
    }
  })
}

export interface AttendanceInput {
  employeeId: number
  month: string
  presentDays: number
  paidLeaveDays: number
  lopDays: number
  note?: string | null
}

/**
 * Record one employee's month.
 *
 * Refuses a total beyond the calendar rather than clamping it: 32 payable days in a 31-day month
 * is a typo, and silently trimming it would produce a payslip nobody typed and nobody expects.
 */
export function saveAttendance(db: DB, input: AttendanceInput): AttendanceRow {
  const monthDays = daysInMonth(input.month)
  const total = input.presentDays + input.paidLeaveDays + input.lopDays
  if (input.presentDays < 0 || input.paidLeaveDays < 0 || input.lopDays < 0) {
    throw new Error('Days cannot be negative')
  }
  if (total > monthDays) {
    throw new Error(`${total} days recorded in a ${monthDays}-day month`)
  }
  const before = db
    .prepare('SELECT * FROM attendance WHERE employee_id = ? AND month = ?')
    .get(input.employeeId, input.month) as Row | undefined

  db.prepare(
    `INSERT INTO attendance (employee_id, month, present_days, paid_leave_days, lop_days, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, month) DO UPDATE SET
       present_days = excluded.present_days,
       paid_leave_days = excluded.paid_leave_days,
       lop_days = excluded.lop_days,
       note = excluded.note`
  ).run(input.employeeId, input.month, input.presentDays, input.paidLeaveDays, input.lopDays, input.note ?? null)

  const after = db
    .prepare(
      `SELECT a.*, e.name AS employeeName FROM attendance a JOIN employees e ON e.id = a.employee_id
       WHERE a.employee_id = ? AND a.month = ?`
    )
    .get(input.employeeId, input.month) as Row
  writeAudit(db, 'attendance', after.id, before ? 'update' : 'create', before ?? null, after)
  return map(after, monthDays)
}

/** Payable days per employee for a month, in the shape previewRun/commitRun take. */
export function payableDaysFor(db: DB, month: string): { employeeId: number; payableDays: number }[] {
  return attendanceForMonth(db, month).map((a) => ({ employeeId: a.employeeId, payableDays: a.payableDays }))
}

// ---------- salary advances ----------

export interface LoanRow {
  id: number
  employeeId: number
  employeeName: string
  grantedOn: string
  principal: number
  instalment: number
  note: string | null
  closedAt: string | null
  recovered: number
  /** principal − recovered; zero once it is paid off. */
  outstanding: number
  /** Whole instalments left, with the last one being whatever remains. */
  instalmentsLeft: number
}

const LOAN_SELECT = `
  SELECT l.*, e.name AS employeeName,
         COALESCE((SELECT SUM(r.amount) FROM loan_recoveries r WHERE r.loan_id = l.id), 0) AS recovered
  FROM employee_loans l JOIN employees e ON e.id = l.employee_id`

interface LoanDbRow {
  id: number
  employee_id: number
  employeeName: string
  granted_on: string
  principal: number
  instalment: number
  note: string | null
  closed_at: string | null
  recovered: number
}

function mapLoan(r: LoanDbRow): LoanRow {
  const outstanding = Math.max(0, r.principal - r.recovered)
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employeeName,
    grantedOn: r.granted_on,
    principal: r.principal,
    instalment: r.instalment,
    note: r.note,
    closedAt: r.closed_at,
    recovered: r.recovered,
    outstanding,
    instalmentsLeft: r.instalment > 0 ? Math.ceil(outstanding / r.instalment) : 0
  }
}

export function listLoans(db: DB, opts: { employeeId?: number; openOnly?: boolean } = {}): LoanRow[] {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.employeeId) {
    where.push('l.employee_id = ?')
    params.push(opts.employeeId)
  }
  const rows = (
    db.prepare(`${LOAN_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY l.granted_on DESC, l.id DESC`).all(...params) as LoanDbRow[]
  ).map(mapLoan)
  return opts.openOnly ? rows.filter((r) => r.closedAt === null && r.outstanding > 0) : rows
}

export interface LoanInput {
  employeeId: number
  grantedOn: string
  principal: number
  instalment: number
  note?: string | null
}

export function createLoan(db: DB, input: LoanInput): LoanRow {
  if (input.principal <= 0) throw new Error('An advance must be for something')
  if (input.instalment <= 0) throw new Error('Set an instalment, or it will never be recovered')
  if (input.instalment > input.principal) throw new Error('The instalment is more than the advance')
  const res = db
    .prepare('INSERT INTO employee_loans (employee_id, granted_on, principal, instalment, note) VALUES (?, ?, ?, ?, ?)')
    .run(input.employeeId, input.grantedOn, input.principal, input.instalment, input.note ?? null)
  const created = getLoan(db, Number(res.lastInsertRowid))!
  writeAudit(db, 'employee_loan', created.id, 'create', null, created)
  return created
}

export function getLoan(db: DB, id: number): LoanRow | null {
  const row = db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id) as LoanDbRow | undefined
  return row ? mapLoan(row) : null
}

/** Close an advance without recovering the rest — a write-off, or settlement outside payroll. */
export function closeLoan(db: DB, id: number, on: string): LoanRow {
  const before = getLoan(db, id)
  if (!before) throw new Error('Advance not found')
  db.prepare('UPDATE employee_loans SET closed_at = ? WHERE id = ?').run(on, id)
  const after = getLoan(db, id)!
  writeAudit(db, 'employee_loan', id, 'update', before, after)
  return after
}

export interface DueRecovery {
  loanId: number
  employeeId: number
  employeeName: string
  amount: number
  outstanding: number
  /** True when this instalment clears the advance. */
  final: boolean
}

/**
 * What each open advance would take out of a given month's pay.
 *
 * The last instalment is whatever is left rather than the full amount — recovering ₹5,000 against
 * a ₹1,200 balance is how an employee ends up owed money by the payroll that was meant to collect
 * from them. A month already recovered against is skipped, so re-previewing a run cannot
 * double-count.
 */
export function dueRecoveries(db: DB, month: string): DueRecovery[] {
  const already = new Set(
    (db.prepare('SELECT loan_id FROM loan_recoveries WHERE month = ?').all(month) as { loan_id: number }[]).map(
      (r) => r.loan_id
    )
  )
  return listLoans(db, { openOnly: true })
    .filter((l) => !already.has(l.id) && l.grantedOn <= `${month}-31`)
    .map((l) => {
      const amount = Math.min(l.instalment, l.outstanding)
      return {
        loanId: l.id,
        employeeId: l.employeeId,
        employeeName: l.employeeName,
        amount,
        outstanding: l.outstanding,
        final: amount >= l.outstanding
      }
    })
}

/** Write the recoveries a committed run actually deducted. Called inside the run's transaction. */
export function recordRecoveries(
  db: DB,
  runId: number,
  month: string,
  recoveries: { loanId: number; amount: number }[]
): void {
  const insert = db.prepare(
    'INSERT INTO loan_recoveries (loan_id, run_id, month, amount) VALUES (?, ?, ?, ?) ON CONFLICT(loan_id, month) DO NOTHING'
  )
  for (const r of recoveries) {
    if (r.amount > 0) insert.run(r.loanId, runId, month, r.amount)
  }
  // A fully recovered advance closes itself, so it stops appearing on next month's list.
  db.prepare(
    `UPDATE employee_loans SET closed_at = ?
     WHERE closed_at IS NULL
       AND principal <= COALESCE((SELECT SUM(amount) FROM loan_recoveries r WHERE r.loan_id = employee_loans.id), 0)`
  ).run(`${month}-01`)
}

/** Total still owed by each employee — the figure a full-and-final settlement recovers in one go. */
export function outstandingByEmployee(db: DB): Map<number, number> {
  const out = new Map<number, number>()
  for (const l of listLoans(db, { openOnly: true })) {
    out.set(l.employeeId, (out.get(l.employeeId) ?? 0) + l.outstanding)
  }
  return out
}
