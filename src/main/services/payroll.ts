import type { DB } from '../db/connection'
import type { CompanyInfo, Employee, PayrollHeadAmount, PayrollLine, PayrollRun } from '@shared/domain'
import type { PayrollTrendPoint } from '@shared/reports'
import { buildTransferFile, type TransferFile } from '@shared/salaryTransfer'
import type { EmployeeInput, EmployeeHeadsSetInput, PayHeadInput } from '@shared/schemas'
import {
  buildEcr, buildEsiCsv, buildPtCsv, computeMonthlyPay, daysInMonth, ecrUploadable, validateEcr,
  type EcrInput, type EcrProblem, type PayHeadSpec
} from '@shared/payroll'
import { ratesForMonth } from '@shared/statutory'
import { dueRecoveries, outstandingByEmployee, payableDaysFor, recordRecoveries } from './attendance'
import { fullAndFinal, type FnfResult } from '@shared/fnf'
import { whatsappNumber } from '@shared/outstanding'
import { serviceLength } from '@shared/gratuity'
import { fyOf } from '@shared/dates'
import {
  computeAnnualTax, fyStartYearOf, monthlyTds, monthsLeftInFy, type Regime, type TaxComputation
} from '@shared/incomeTax'
import { amountInWords, formatPaise } from '@shared/money'
import { deleteVoucher, getLockDate, saveVoucher } from './vouchers'
import { findOrCreateLedger } from './masters'
import { writeAudit } from './audit'
import { writeExportPdf } from './pdf'

// ---------- employees ----------

interface EmployeeRow {
  id: number; name: string; code: string | null; designation: string | null; joined: string | null
  pan: string | null; uan: string | null; esic_no: string | null
  basic: number; hra: number; special: number
  pf_enabled: number; esi_enabled: number; pt_enabled: number; pt_state: string; active: number
  bank_account: string | null; ifsc: string | null
  email: string | null; phone: string | null
  tax_regime: string | null; declared_deductions: number | null; opening_tds: number | null
}

const mapEmployee = (r: EmployeeRow): Employee => ({
  id: r.id, name: r.name, code: r.code, designation: r.designation, joined: r.joined,
  pan: r.pan, uan: r.uan, esicNo: r.esic_no,
  basic: r.basic, hra: r.hra, special: r.special,
  pfEnabled: !!r.pf_enabled, esiEnabled: !!r.esi_enabled, ptEnabled: !!r.pt_enabled,
  ptState: r.pt_state, bankAccount: r.bank_account, ifsc: r.ifsc, active: !!r.active,
  email: r.email, phone: r.phone,
  // The new regime is the default in law, so a NULL here is 'new' rather than "not chosen".
  taxRegime: r.tax_regime === 'old' ? 'old' : 'new',
  declaredDeductions: r.declared_deductions, openingTds: r.opening_tds
})

export function listEmployees(db: DB): Employee[] {
  return (db.prepare('SELECT * FROM employees ORDER BY name').all() as EmployeeRow[]).map(mapEmployee)
}

/** Keeps the three seeded heads (Basic/HRA/Special Allowance) in lockstep with the legacy salary
 *  columns, so head-based and column-based views of an employee can never drift apart. */
function syncSeededHeads(db: DB, employeeId: number, input: EmployeeInput): void {
  const upsert = db.prepare(
    `INSERT INTO employee_pay_heads (employee_id, pay_head_id, override_value)
     SELECT ?, id, ? FROM pay_heads WHERE name = ?
     ON CONFLICT(employee_id, pay_head_id) DO UPDATE SET override_value = excluded.override_value`
  )
  upsert.run(employeeId, input.basic, 'Basic')
  upsert.run(employeeId, input.hra, 'HRA')
  upsert.run(employeeId, input.special, 'Special Allowance')
}

export function saveEmployee(db: DB, input: EmployeeInput, id?: number): Employee {
  const before = id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as EmployeeRow | undefined : undefined
  if (id) {
    db.prepare(
      `UPDATE employees SET name = ?, code = ?, designation = ?, joined = ?, pan = ?, uan = ?, esic_no = ?,
       basic = ?, hra = ?, special = ?, pf_enabled = ?, esi_enabled = ?, pt_enabled = ?, pt_state = ?,
       bank_account = ?, ifsc = ?, email = ?, phone = ?, tax_regime = ?, declared_deductions = ?,
       opening_tds = ?, active = ? WHERE id = ?`
    ).run(input.name, input.code, input.designation, input.joined, input.pan, input.uan, input.esicNo,
      input.basic, input.hra, input.special, +input.pfEnabled, +input.esiEnabled, +input.ptEnabled, input.ptState,
      input.bankAccount ?? null, input.ifsc ?? null, input.email ?? null, input.phone ?? null,
      input.taxRegime ?? null, input.declaredDeductions ?? null, input.openingTds ?? null, +input.active, id)
  } else {
    const res = db.prepare(
      `INSERT INTO employees (name, code, designation, joined, pan, uan, esic_no, basic, hra, special,
        pf_enabled, esi_enabled, pt_enabled, pt_state, bank_account, ifsc, email, phone,
        tax_regime, declared_deductions, opening_tds, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(input.name, input.code, input.designation, input.joined, input.pan, input.uan, input.esicNo,
      input.basic, input.hra, input.special, +input.pfEnabled, +input.esiEnabled, +input.ptEnabled, input.ptState,
      input.bankAccount ?? null, input.ifsc ?? null, input.email ?? null, input.phone ?? null,
      input.taxRegime ?? null, input.declaredDeductions ?? null, input.openingTds ?? null, +input.active)
    id = Number(res.lastInsertRowid)
  }
  syncSeededHeads(db, id, input)
  const saved = mapEmployee(db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as EmployeeRow)
  writeAudit(db, 'employee', id, before ? 'update' : 'create', before ? mapEmployee(before) : null, saved)
  return saved
}

export function deleteEmployee(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as EmployeeRow | undefined
  if (!existing) throw new Error('Employee not found')
  const used = db.prepare('SELECT COUNT(*) AS n FROM payroll_lines WHERE employee_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('Employee has payroll history; mark them inactive instead')
  db.prepare('DELETE FROM employees WHERE id = ?').run(id)
  writeAudit(db, 'employee', id, 'delete', mapEmployee(existing), null)
}

// ---------- pay heads ----------

export interface PayHead {
  id: number
  name: string
  kind: 'earning' | 'deduction'
  calc: 'flat' | 'percent_of_basic'
  value: number
  active: boolean
}

interface PayHeadRow { id: number; name: string; kind: 'earning' | 'deduction'; calc: 'flat' | 'percent_of_basic'; value: number; active: number }

const mapHead = (r: PayHeadRow): PayHead => ({ id: r.id, name: r.name, kind: r.kind, calc: r.calc, value: r.value, active: !!r.active })

export function listPayHeads(db: DB): PayHead[] {
  return (db.prepare('SELECT * FROM pay_heads ORDER BY id').all() as PayHeadRow[]).map(mapHead)
}

export function savePayHead(db: DB, input: PayHeadInput, id?: number): PayHead {
  if (id != null) {
    const before = db.prepare('SELECT * FROM pay_heads WHERE id = ?').get(id) as PayHeadRow | undefined
    if (!before) throw new Error('Pay head not found')
    db.prepare('UPDATE pay_heads SET name = ?, kind = ?, calc = ?, value = ?, active = ? WHERE id = ?')
      .run(input.name, input.kind, input.calc, input.value, input.active ? 1 : 0, id)
    writeAudit(db, 'pay_head', id, 'update', mapHead(before), input)
  } else {
    const res = db.prepare('INSERT INTO pay_heads (name, kind, calc, value, active) VALUES (?, ?, ?, ?, ?)')
      .run(input.name, input.kind, input.calc, input.value, input.active ? 1 : 0)
    id = Number(res.lastInsertRowid)
    writeAudit(db, 'pay_head', id, 'create', null, input)
  }
  return mapHead(db.prepare('SELECT * FROM pay_heads WHERE id = ?').get(id) as PayHeadRow)
}

export function deletePayHead(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM pay_heads WHERE id = ?').get(id) as PayHeadRow | undefined
  if (!before) throw new Error('Pay head not found')
  const used = db.prepare('SELECT COUNT(*) AS n FROM employee_pay_heads WHERE pay_head_id = ?').get(id) as { n: number }
  if (used.n > 0) throw new Error('Pay head is assigned to employees; remove it from them first')
  db.prepare('DELETE FROM pay_heads WHERE id = ?').run(id)
  writeAudit(db, 'pay_head', id, 'delete', mapHead(before), null)
}

export interface EmployeeHeadRow {
  payHeadId: number
  name: string
  kind: 'earning' | 'deduction'
  calc: 'flat' | 'percent_of_basic'
  /** The head's default value. */
  value: number
  /** Per-employee override (null = use the default). */
  overrideValue: number | null
}

export function getEmployeeHeads(db: DB, employeeId: number): EmployeeHeadRow[] {
  return db
    .prepare(
      `SELECT eph.pay_head_id AS payHeadId, ph.name, ph.kind, ph.calc, ph.value, eph.override_value AS overrideValue
       FROM employee_pay_heads eph JOIN pay_heads ph ON ph.id = eph.pay_head_id
       WHERE eph.employee_id = ? ORDER BY ph.id`
    )
    .all(employeeId) as EmployeeHeadRow[]
}

/** Replaces the employee's full head assignment list. Also mirrors the seeded Basic/HRA/Special
 *  values back onto the legacy salary columns so both views stay in lockstep. */
export function setEmployeeHeads(db: DB, input: EmployeeHeadsSetInput): EmployeeHeadRow[] {
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(input.employeeId)
  if (!emp) throw new Error('Employee not found')
  const before = getEmployeeHeads(db, input.employeeId)
  const run = db.transaction(() => {
    db.prepare('DELETE FROM employee_pay_heads WHERE employee_id = ?').run(input.employeeId)
    const insert = db.prepare('INSERT INTO employee_pay_heads (employee_id, pay_head_id, override_value) VALUES (?, ?, ?)')
    for (const h of input.heads) insert.run(input.employeeId, h.payHeadId, h.overrideValue)

    const seeded = db.prepare("SELECT id, name FROM pay_heads WHERE name IN ('Basic', 'HRA', 'Special Allowance')").all() as { id: number; name: string }[]
    const byName = new Map(seeded.map((s) => [s.name, s.id]))
    const valueOf = (name: string): number => {
      const headId = byName.get(name)
      const assigned = headId == null ? undefined : input.heads.find((h) => h.payHeadId === headId)
      return assigned?.overrideValue ?? 0
    }
    db.prepare('UPDATE employees SET basic = ?, hra = ?, special = ? WHERE id = ?')
      .run(valueOf('Basic'), valueOf('HRA'), valueOf('Special Allowance'), input.employeeId)
  })
  run()
  const after = getEmployeeHeads(db, input.employeeId)
  writeAudit(db, 'employee', input.employeeId, 'update', { payHeads: before }, { payHeads: after })
  return after
}

/** Active head list per employee, override-resolved, in PayHeadSpec shape for computeMonthlyPay. */
function loadEmployeeHeadSpecs(db: DB): Map<number, PayHeadSpec[]> {
  const rows = db
    .prepare(
      `SELECT eph.employee_id AS employeeId, ph.name, ph.kind, ph.calc,
              COALESCE(eph.override_value, ph.value) AS value
       FROM employee_pay_heads eph JOIN pay_heads ph ON ph.id = eph.pay_head_id
       WHERE ph.active = 1 ORDER BY ph.id`
    )
    .all() as { employeeId: number; name: string; kind: 'earning' | 'deduction'; calc: 'flat' | 'percent_of_basic'; value: number }[]
  const map = new Map<number, PayHeadSpec[]>()
  for (const r of rows) {
    const list = map.get(r.employeeId) ?? []
    list.push({ name: r.name, kind: r.kind, calc: r.calc, value: r.value })
    map.set(r.employeeId, list)
  }
  return map
}

// ---------- pay runs ----------

export interface RunPreviewLine extends Omit<PayrollLine, 'id'> {}

/**
 * Preview a month's pay.
 *
 * `days` overrides attendance for the employees it names; everyone else takes what the attendance
 * register says, and an employee with no register entry is a full month. That ordering matters:
 * the register is the record, and the argument is the correction being tried out on the screen.
 */
export function previewRun(db: DB, month: string, days: { employeeId: number; payableDays: number }[]): RunPreviewLine[] {
  const monthDays = daysInMonth(month)
  const rates = ratesForMonth(month)
  const byId = new Map(days.map((d) => [d.employeeId, d.payableDays]))
  const fromRegister = new Map(payableDaysFor(db, month).map((a) => [a.employeeId, a.payableDays]))
  const recoveries = new Map(dueRecoveries(db, month).map((r) => [r.employeeId, r]))
  const tdsByEmployee = tdsForMonth(db, month)
  const headsByEmployee = loadEmployeeHeadSpecs(db)
  return listEmployees(db)
    .filter((e) => e.active)
    .map((e) => {
      const payableDays = byId.get(e.id) ?? fromRegister.get(e.id) ?? monthDays
      const heads = headsByEmployee.get(e.id)
      const advanceRecovery = recoveries.get(e.id)?.amount ?? 0
      const tds = tdsByEmployee.get(e.id)?.thisMonth ?? 0
      // The rates in force for THIS month, not today's. A run recomputed after a rate change
      // must still answer what it answered when it was posted and filed.
      const pay = computeMonthlyPay({ ...e, heads, advanceRecovery, tds }, payableDays, monthDays, { rates })
      return { employeeId: e.id, employeeName: e.name, payableDays, monthDays, ...pay }
    })
}

/** Post the month's payroll: stores the run + lines and books one balanced Journal voucher — all
 *  inside ONE transaction (saveVoucher's inner db.transaction nests as a savepoint), so a failure
 *  while writing run rows can never leave an orphaned salary voucher behind. */
export function commitRun(db: DB, month: string, days: { employeeId: number; payableDays: number }[]): PayrollRun {
  const existing = db.prepare('SELECT id FROM payroll_runs WHERE month = ?').get(month) as { id: number } | undefined
  if (existing) throw new Error(`Payroll for ${month} is already posted`)
  const lines = previewRun(db, month, days)
  if (lines.length === 0) throw new Error('No active employees')

  const sum = (f: (l: RunPreviewLine) => number): number => lines.reduce((s, l) => s + f(l), 0)
  const gross = sum((l) => l.gross)
  const pfEmp = sum((l) => l.pfEmp)
  const pfEr = sum((l) => l.pfEr)
  const pfAdmin = sum((l) => l.pfAdmin)
  const edli = sum((l) => l.edli)
  const esiEmp = sum((l) => l.esiEmp)
  const esiEr = sum((l) => l.esiEr)
  const pt = sum((l) => l.pt)
  const otherDeductions = sum((l) => l.otherDeductions)
  const advanceRecovery = sum((l) => l.advanceRecovery)
  const tds = sum((l) => l.tds)
  const net = sum((l) => l.net)

  // Salary expense split by whichever cost centre carries each employee (roadmap #180). Employees
  // with no cost centre contribute nothing, so a company that has never used them posts exactly
  // the voucher it posted before — an unallocated single line.
  const centreByEmployee = new Map(
    (db.prepare('SELECT id, cost_centre_id FROM employees WHERE cost_centre_id IS NOT NULL').all() as {
      id: number; cost_centre_id: number
    }[]).map((r) => [r.id, r.cost_centre_id])
  )
  const salaryAllocations = new Map<number, number>()
  for (const l of lines) {
    const centre = centreByEmployee.get(l.employeeId)
    if (centre === undefined) continue
    salaryAllocations.set(centre, (salaryAllocations.get(centre) ?? 0) + l.gross)
  }

  const journal = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' AND is_system = 1").get() as { id: number }

  const voucherLines: {
    ledgerId: number; drCr: 'dr' | 'cr'; amount: number
    costAllocations: { costCentreId: number; amount: number }[]
  }[] = []
  const push = (
    name: string,
    group: string,
    drCr: 'dr' | 'cr',
    amount: number,
    costAllocations: { costCentreId: number; amount: number }[] = []
  ): void => {
    if (amount > 0) voucherLines.push({ ledgerId: findOrCreateLedger(db, name, group), drCr, amount, costAllocations })
  }
  push(
    'Salaries',
    'Indirect Expenses',
    'dr',
    gross,
    [...salaryAllocations.entries()].map(([costCentreId, amount]) => ({ costCentreId, amount }))
  )
  push('Employer PF Contribution', 'Indirect Expenses', 'dr', pfEr)
  push('PF Admin & EDLI Charges', 'Indirect Expenses', 'dr', pfAdmin + edli)
  push('Employer ESI Contribution', 'Indirect Expenses', 'dr', esiEr)
  push('PF Payable', 'Provisions', 'cr', pfEmp + pfEr + pfAdmin + edli)
  push('ESI Payable', 'Provisions', 'cr', esiEmp + esiEr)
  push('Professional Tax Payable', 'Duties & Taxes', 'cr', pt)
  push('TDS on Salary Payable', 'Duties & Taxes', 'cr', tds)
  push('Employee Deductions Payable', 'Provisions', 'cr', otherDeductions)
  // Recovering an advance settles an asset rather than paying anybody: the credit reduces the
  // Salary Advances balance, and the net going to Salaries Payable is already short by it.
  push('Salary Advances', 'Loans & Advances (Asset)', 'cr', advanceRecovery)
  push('Salaries Payable', 'Provisions', 'cr', net)

  const recoveryLoanIds = new Map(dueRecoveries(db, month).map((r) => [r.employeeId, r.loanId]))
  const lastDay = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`
  const commit = db.transaction((): number => {
    const voucher = saveVoucher(db, {
      voucherTypeId: journal.id,
      date: lastDay,
      number: undefined,
      partyLedgerId: null,
      narration: `Salary for ${month} — ${lines.length} employee${lines.length > 1 ? 's' : ''}`,
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines: voucherLines,
      inventory: [],
      billRefs: [],
      tds: null
    })

    const res = db.prepare('INSERT INTO payroll_runs (month, voucher_id) VALUES (?, ?)').run(month, voucher.id)
    const runId = Number(res.lastInsertRowid)
    const insert = db.prepare(
      `INSERT INTO payroll_lines (run_id, employee_id, payable_days, month_days, basic, hra, special, gross,
        pf_emp, pf_er, esi_emp, esi_er, pt, net,
        other_earnings, other_deductions, eps_er, pf_admin, edli, advance_recovery, tds, heads_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const l of lines) {
      insert.run(runId, l.employeeId, l.payableDays, l.monthDays, l.basic, l.hra, l.special, l.gross,
        l.pfEmp, l.pfEr, l.esiEmp, l.esiEr, l.pt, l.net,
        l.otherEarnings, l.otherDeductions, l.epsEr, l.pfAdmin, l.edli, l.advanceRecovery, l.tds,
        l.headAmounts.length ? JSON.stringify(l.headAmounts) : null)
    }
    // Inside the run's transaction: a payslip that shows a recovery and a loan balance that does
    // not know about it are the two halves of the same fact, and they commit together or not at all.
    recordRecoveries(
      db,
      runId,
      month,
      lines.filter((l) => l.advanceRecovery > 0).map((l) => ({ loanId: recoveryLoanIds.get(l.employeeId)!, amount: l.advanceRecovery }))
    )
    return runId
  })
  const runId = commit()
  const created = getRun(db, runId)!
  writeAudit(db, 'payroll_run', runId, 'create', null, created)
  return created
}

interface RunRow { id: number; month: string; voucher_id: number | null; created_at: string }
interface LineRow {
  id: number; employee_id: number; employeeName: string; payable_days: number; month_days: number
  basic: number; hra: number; special: number; gross: number
  pf_emp: number; pf_er: number; esi_emp: number; esi_er: number; pt: number; net: number
  other_earnings: number; other_deductions: number; eps_er: number; pf_admin: number; edli: number
  advance_recovery: number; tds: number
  heads_json: string | null
}

export function getRun(db: DB, id: number): PayrollRun | null {
  const r = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id) as RunRow | undefined
  if (!r) return null
  const lines = db
    .prepare(
      `SELECT pl.*, e.name AS employeeName FROM payroll_lines pl
       JOIN employees e ON e.id = pl.employee_id WHERE pl.run_id = ? ORDER BY e.name`
    )
    .all(id) as LineRow[]
  return {
    id: r.id,
    month: r.month,
    voucherId: r.voucher_id,
    createdAt: r.created_at,
    lines: lines.map((l) => ({
      id: l.id, employeeId: l.employee_id, employeeName: l.employeeName,
      payableDays: l.payable_days, monthDays: l.month_days,
      basic: l.basic, hra: l.hra, special: l.special,
      otherEarnings: l.other_earnings, otherDeductions: l.other_deductions,
      advanceRecovery: l.advance_recovery, tds: l.tds, gross: l.gross,
      pfEmp: l.pf_emp, pfEr: l.pf_er, epsEr: l.eps_er, pfAdmin: l.pf_admin, edli: l.edli,
      esiEmp: l.esi_emp, esiEr: l.esi_er, pt: l.pt, net: l.net,
      headAmounts: l.heads_json ? (JSON.parse(l.heads_json) as PayrollHeadAmount[]) : []
    }))
  }
}

export function listRuns(db: DB): PayrollRun[] {
  const rows = db.prepare('SELECT id FROM payroll_runs ORDER BY month DESC').all() as { id: number }[]
  return rows.map((r) => getRun(db, r.id)!).filter(Boolean)
}

export function deleteRun(db: DB, id: number): void {
  const run = getRun(db, id)
  if (!run) throw new Error('Pay run not found')
  const lock = getLockDate(db)
  const lastDay = `${run.month}-${String(daysInMonth(run.month)).padStart(2, '0')}`
  if (lock && lastDay <= lock) {
    throw new Error(
      `Payroll for ${run.month} falls in a locked period (books are locked up to ${lock}) — move the lock date first`
    )
  }
  const del = db.transaction(() => {
    db.prepare('DELETE FROM payroll_runs WHERE id = ?').run(id)
    if (run.voucherId) deleteVoucher(db, run.voucherId)
  })
  del()
  writeAudit(db, 'payroll_run', id, 'delete', run, null)
}

// ---------- statutory exports (PF ECR / ESI upload / PT summary) ----------

/** EPFO ECR 2.0 text for a posted run — one #~# line per PF member with a UAN. */
interface EcrCandidate {
  row: EcrInput
  /** Set when the member cannot go in the file at all. */
  skipReason: string | null
}

/** Every PF member in the run, whether or not they can be filed for — the validator needs both. */
function ecrCandidates(db: DB, runId: number): { month: string; candidates: EcrCandidate[] } {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const employees = new Map(listEmployees(db).map((e) => [e.id, e]))
  const candidates = run.lines
    .filter((l) => employees.get(l.employeeId)?.pfEnabled)
    .map((l) => {
      const e = employees.get(l.employeeId)!
      return {
        row: {
          uan: e.uan ?? '',
          name: l.employeeName,
          gross: l.gross,
          basic: l.basic,
          pfEmp: l.pfEmp,
          pfEr: l.pfEr,
          epsEr: l.epsEr,
          payableDays: l.payableDays,
          monthDays: l.monthDays
        },
        skipReason: !e.uan ? 'No UAN on the employee record' : l.pfEmp <= 0 ? 'No PF contribution this month' : null
      }
    })
  return { month: run.month, candidates }
}

export interface EcrCheck {
  month: string
  problems: EcrProblem[]
  uploadable: boolean
  /** PF members left out of the file, and why. */
  skipped: { name: string; reason: string }[]
  memberCount: number
}

/**
 * Check the ECR before EPFO does (roadmap #172).
 *
 * Runs over every PF member in the run, including the ones the file itself cannot carry — a
 * member with no UAN used to be filtered out in silence, which produced a valid-looking file that
 * was short a person, and the person only found out when their passbook did not update.
 */
export function ecrCheck(db: DB, runId: number): EcrCheck {
  const { month, candidates } = ecrCandidates(db, runId)
  const filed = candidates.filter((c) => c.skipReason === null)
  return {
    month,
    problems: validateEcr(filed.map((c) => c.row)),
    uploadable: ecrUploadable(validateEcr(filed.map((c) => c.row))) && filed.length > 0,
    skipped: candidates
      .filter((c) => c.skipReason !== null)
      .map((c) => ({ name: c.row.name, reason: c.skipReason as string })),
    memberCount: filed.length
  }
}

export function ecrForRun(db: DB, runId: number): { filename: string; text: string; skipped: EcrCheck['skipped'] } {
  const { month, candidates } = ecrCandidates(db, runId)
  const rows = candidates.filter((c) => c.skipReason === null).map((c) => c.row)
  if (rows.length === 0) throw new Error('No PF members with a UAN in this run — add UANs on the employee records first')
  const problems = validateEcr(rows)
  if (!ecrUploadable(problems)) {
    // Refuse rather than write a file EPFO will reject: the round trip to the portal is slow and
    // the error it returns is a line number, not a name.
    throw new Error(`ECR has ${problems.filter((p) => p.severity === 'error').length} problem(s) EPFO will reject — check the pre-flight`)
  }
  return {
    filename: `pf-ecr-${month}.txt`,
    text: buildEcr(rows),
    skipped: candidates.filter((c) => c.skipReason !== null).map((c) => ({ name: c.row.name, reason: c.skipReason as string }))
  }
}

export function esiForRun(db: DB, runId: number): { filename: string; text: string } {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const employees = new Map(listEmployees(db).map((e) => [e.id, e]))
  const rows = run.lines
    .filter((l) => {
      const e = employees.get(l.employeeId)
      return l.esiEmp > 0 && !!e?.esicNo
    })
    .map((l) => ({
      esicNo: employees.get(l.employeeId)!.esicNo!,
      name: l.employeeName,
      payableDays: l.payableDays,
      gross: l.gross
    }))
  if (rows.length === 0) throw new Error('No ESI contributions with an ESIC number in this run')
  return { filename: `esi-upload-${run.month}.csv`, text: buildEsiCsv(rows) }
}

export interface PtSummaryRow {
  state: string
  employees: number
  gross: number
  pt: number
}

/** Professional tax collected per state for a posted run (drives the state-wise PT challans). */
export function ptSummaryForRun(db: DB, runId: number): PtSummaryRow[] {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const stateById = new Map(listEmployees(db).map((e) => [e.id, e.ptState]))
  const byState = new Map<string, PtSummaryRow>()
  for (const l of run.lines) {
    const state = stateById.get(l.employeeId) ?? 'MH'
    const row = byState.get(state) ?? { state, employees: 0, gross: 0, pt: 0 }
    row.employees += 1
    row.gross += l.gross
    row.pt += l.pt
    byState.set(state, row)
  }
  return [...byState.values()].sort((a, b) => a.state.localeCompare(b.state))
}

/** State-wise PT return CSV for a posted run (the file the state challan is filled from). */
export function ptCsvForRun(db: DB, runId: number): { filename: string; text: string } {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const rows = ptSummaryForRun(db, runId).filter((r) => r.pt > 0)
  if (rows.length === 0) throw new Error('No professional tax in this run')
  return { filename: `pt-return-${run.month}.csv`, text: buildPtCsv(rows) }
}

// ---------- payslip PDF ----------

const esc = (s: string | null): string => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const SEEDED_HEAD_NAMES = new Set(['basic', 'hra', 'special allowance', 'special'])

export async function payslipPdf(db: DB, company: CompanyInfo, slug: string, runId: number, employeeId: number): Promise<string> {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const line = run.lines.find((l) => l.employeeId === employeeId)
  if (!line) throw new Error('Employee not in this run')
  const emp = listEmployees(db).find((e) => e.id === employeeId)

  const money = (p: number): string => formatPaise(p)
  const row = (label: string, amount: number): string =>
    amount > 0 ? `<tr><td>${esc(label)}</td><td class="r num">${money(amount)}</td></tr>` : ''

  const customHeads = line.headAmounts.filter((h) => !SEEDED_HEAD_NAMES.has(h.name.trim().toLowerCase()))
  const customEarningRows = customHeads.filter((h) => h.kind === 'earning').map((h) => row(h.name, h.amount)).join('')
  const customDeductionRows = customHeads.filter((h) => h.kind === 'deduction').map((h) => row(h.name, h.amount)).join('')
  const otherEarningsFallback = customEarningRows === '' ? row('Other allowances', line.otherEarnings) : ''
  const otherDeductionsFallback = customDeductionRows === '' ? row('Other deductions', line.otherDeductions) : ''
  // Every deduction the net was actually reduced by. The advance recovery used to be missing
  // here, so a payslip that deducted it showed a "total deductions" that did not reconcile to
  // the net printed six lines below it.
  const totalDeductions = line.pfEmp + line.esiEmp + line.pt + line.otherDeductions + line.advanceRecovery + line.tds

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.5 'Helvetica Neue', Arial, sans-serif; color: #16181f; padding: 32px; }
    .num { font-variant-numeric: tabular-nums; font-family: Menlo, monospace; font-size: 11.5px; }
    .sheet { border: 1.5px solid #16181f; padding: 0; }
    .head { border-bottom: 1.5px solid #16181f; padding: 14px 18px; display: flex; justify-content: space-between; }
    h1 { font-size: 18px; } .sub { color: #555; font-size: 11px; }
    .meta { padding: 10px 18px; border-bottom: 1px solid #16181f; display: flex; gap: 40px; }
    .cols { display: flex; }
    .cols > div { flex: 1; padding: 12px 18px; }
    .cols > div + div { border-left: 1px solid #16181f; }
    h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 4px 0; } .r { text-align: right; }
    .net { border-top: 1.5px solid #16181f; padding: 12px 18px; display: flex; justify-content: space-between; font-weight: 700; }
    .words { padding: 0 18px 14px; font-style: italic; color: #444; }
  </style></head><body><div class="sheet">
    <div class="head">
      <div><h1>${esc(company.name)}</h1><div class="sub">${esc(company.address)}</div></div>
      <div style="text-align:right"><b>PAYSLIP</b><div class="sub">${esc(run.month)}</div></div>
    </div>
    <div class="meta">
      <div><b>${esc(line.employeeName)}</b><div class="sub">${esc(emp?.designation ?? '')}${emp?.code ? ' · ' + esc(emp.code) : ''}</div></div>
      <div class="sub">Days paid: <span class="num">${line.payableDays}/${line.monthDays}</span></div>
      ${emp?.uan ? `<div class="sub">UAN: <span class="num">${esc(emp.uan)}</span></div>` : ''}
      ${emp?.pan ? `<div class="sub">PAN: <span class="num">${esc(emp.pan)}</span></div>` : ''}
    </div>
    <div class="cols">
      <div><h3>Earnings</h3><table>
        ${row('Basic', line.basic)}${row('HRA', line.hra)}${row('Special allowance', line.special)}
        ${customEarningRows}${otherEarningsFallback}
        <tr><td><b>Gross</b></td><td class="r num"><b>${money(line.gross)}</b></td></tr>
      </table></div>
      <div><h3>Deductions</h3><table>
        ${row('Provident fund', line.pfEmp)}${row('ESI', line.esiEmp)}${row('Professional tax', line.pt)}
        ${row('Income tax (TDS)', line.tds)}${row('Salary advance', line.advanceRecovery)}
        ${customDeductionRows}${otherDeductionsFallback}
        <tr><td><b>Total deductions</b></td><td class="r num"><b>${money(totalDeductions)}</b></td></tr>
      </table></div>
    </div>
    <div class="net"><span>Net pay</span><span class="num">₹ ${money(line.net)}</span></div>
    <div class="words">${esc(amountInWords(line.net))}</div>
  </div></body></html>`

  const safeName = line.employeeName.replace(/[^a-zA-Z0-9-_]/g, '_')
  return writeExportPdf(slug, `payslip-${run.month}-${safeName}.pdf`, html, { pageSize: 'A4' })
}

/**
 * Payroll over time: what it cost, and how many people it covered.
 *
 * Payroll is usually the largest single expense a small business has and the one it looks at
 * least — the run is committed, the payslips go out, and nobody asks what it did over the year.
 * Headcount beside cost is what makes the question answerable: a cost that rose because two
 * people joined is a different fact from the same rise on the same headcount.
 *
 * Employer cost is gross plus the employer's own PF and ESI, which is what actually left the
 * business. Reporting gross alone understates it by roughly a seventh, and that gap is precisely
 * what someone budgeting a hire needs to see.
 */
export function payrollTrend(db: DB, months = 24): PayrollTrendPoint[] {
  const runs = listRuns(db)
    .slice()
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-months)

  return runs.map((run) => {
    const lines = getRun(db, run.id)?.lines ?? []
    const sum = (pick: (l: (typeof lines)[number]) => number): number => lines.reduce((t, l) => t + pick(l), 0)

    const gross = sum((l) => l.gross)
    const employerContributions = sum((l) => l.pfEr + l.pfAdmin + l.edli + l.esiEr)
    const employeeDeductions = sum((l) => l.pfEmp + l.esiEmp + l.pt + l.otherDeductions)
    const employerCost = gross + employerContributions
    const headcount = lines.length

    const [y, m] = run.month.split('-')
    return {
      month: run.month,
      label: `${MONTH_LABELS[Number(m) - 1] ?? m} ${y}`,
      headcount,
      gross,
      employerCost,
      net: sum((l) => l.net),
      employeeDeductions,
      employerContributions,
      costPerHead: headcount === 0 ? 0 : Math.round(employerCost / headcount)
    }
  })
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]

/**
 * The month's salary transfer file, ready to upload to a banking portal.
 *
 * Reads net pay from the committed run rather than recomputing it: the file has to move exactly
 * what the payslips said, and a second computation is a second chance to disagree with them.
 */
export function salaryTransferFile(db: DB, runId: number): TransferFile {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')

  const employees = new Map(listEmployees(db).map((e) => [e.id, e]))
  return buildTransferFile(
    run.lines.map((l) => {
      const emp = employees.get(l.employeeId)
      return {
        employeeName: l.employeeName,
        bankAccount: emp?.bankAccount ?? null,
        ifsc: emp?.ifsc ?? null,
        netPaise: l.net
      }
    }),
    `Salary ${run.month}`
  )
}


// ---------- full and final settlement (roadmap #178) ----------

export interface SettlementInput {
  employeeId: number
  lastDay: string
  leaveBalanceDays: number
  noticeShortfallDays?: number
  /** Days actually payable in the final month; defaults to the days up to lastDay. */
  finalMonthDays?: number
  payBonus?: boolean
  bonusPercent?: number
  waiveGratuityMinimum?: boolean
}

export interface Settlement {
  employeeId: string | number
  result: FnfResult
  /** A journal the human reads and saves. Nothing here posts. */
  draft: {
    date: string
    narration: string
    lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  } | null
}

/**
 * What is owed when somebody leaves.
 *
 * Every figure is pulled from what the books already know — the contracted salary from the
 * employee master, the outstanding advance from the advance register, service length from the
 * joining date — so the only things asked for are the ones only a person can answer: the last
 * day, the leave balance, and whether notice was served.
 */
export function settlement(db: DB, input: SettlementInput): Settlement {
  const employee = listEmployees(db).find((e) => e.id === input.employeeId)
  if (!employee) throw new Error('Employee not found')
  if (!employee.joined) throw new Error(`${employee.name} has no joining date — gratuity cannot be computed without one`)

  const month = input.lastDay.slice(0, 7)
  const monthDays = daysInMonth(month)
  const finalMonthDays = input.finalMonthDays ?? Number(input.lastDay.slice(8, 10))

  const heads = loadEmployeeHeadSpecs(db).get(employee.id)
  const rates = ratesForMonth(month)
  const finalPay = computeMonthlyPay({ ...employee, heads }, finalMonthDays, monthDays, { rates })
  const fullMonth = computeMonthlyPay({ ...employee, heads }, monthDays, monthDays, { rates })

  const loanOutstanding = outstandingByEmployee(db).get(employee.id) ?? 0
  const service = employee.joined <= input.lastDay ? employee.joined : input.lastDay
  // Months of the bonus year worked: the Act's accounting year runs April to March, and a
  // mid-year leaver is entitled for the months they were there.
  const fyStart = fyOf(input.lastDay).from
  const startedThisYear = service > fyStart ? service : fyStart
  const bonusMonths = Math.max(
    0,
    Math.min(12, serviceLength(startedThisYear, input.lastDay).years * 12 + serviceLength(startedThisYear, input.lastDay).months)
  )

  const result = fullAndFinal({
    employeeName: employee.name,
    joined: service,
    lastDay: input.lastDay,
    // Gratuity and encashment are computed on the full contracted basic, never the prorated one:
    // "last drawn wages" means the rate of pay, not what the final part-month happened to be.
    monthlyBasic: fullMonth.basic,
    monthlyGross: fullMonth.gross,
    finalMonthDays,
    finalMonthTotalDays: monthDays,
    leaveBalanceDays: input.leaveBalanceDays,
    noticeShortfallDays: input.noticeShortfallDays,
    loanOutstanding,
    statutoryDeductions: finalPay.pfEmp + finalPay.esiEmp + finalPay.pt,
    waiveGratuityMinimum: input.waiveGratuityMinimum,
    ...(input.payBonus
      ? { bonus: { daysWorked: finalMonthDays + 30 * bonusMonths, monthsPayable: bonusMonths, percent: input.bonusPercent } }
      : {})
  })

  const lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[] = []
  const add = (ledgerName: string, group: string, drCr: 'dr' | 'cr', amount: number): void => {
    if (amount > 0) lines.push({ ledgerName, group, drCr, amount })
  }
  for (const l of result.lines) {
    if (l.kind !== 'payable') continue
    if (l.label === 'Gratuity') add('Gratuity Expense', 'Indirect Expenses', 'dr', l.amount)
    else if (l.label === 'Statutory bonus') add('Bonus Expense', 'Indirect Expenses', 'dr', l.amount)
    else add('Salaries', 'Indirect Expenses', 'dr', l.amount)
  }
  add('PF Payable', 'Provisions', 'cr', finalPay.pfEmp)
  add('ESI Payable', 'Provisions', 'cr', finalPay.esiEmp)
  add('Professional Tax Payable', 'Duties & Taxes', 'cr', finalPay.pt)
  add('Salary Advances', 'Loans & Advances (Asset)', 'cr', loanOutstanding)
  // A notice-period recovery is not an expense reversal: the employee is paying the company for
  // notice they did not serve, which is income.
  const notice = result.lines.find((l) => l.label === 'Notice period shortfall')
  add('Notice Pay Recovered', 'Indirect Incomes', 'cr', notice?.amount ?? 0)
  if (result.net >= 0) {
    add('Salaries Payable', 'Provisions', 'cr', result.net)
  } else {
    // Recoveries outran what was payable: the leaver owes the company, so the balancing figure is
    // a receivable rather than a negative payable. Booking it as a negative credit would leave the
    // journal unbalanced and the debt invisible.
    add('Employee Recoverable', 'Loans & Advances (Asset)', 'dr', -result.net)
  }

  return {
    employeeId: employee.id,
    result,
    draft:
      lines.length > 0
        ? {
            date: input.lastDay,
            narration: `Full and final settlement — ${employee.name}, ${employee.joined} to ${input.lastDay}`,
            lines
          }
        : null
  }
}


// ---------- income tax on salary (roadmap #171) ----------

export interface EmployeeTax {
  employeeId: number
  employeeName: string
  regime: Regime
  /** Estimated salary for the whole financial year, paise. */
  annualGross: number
  computation: TaxComputation
  /** TDS already taken this financial year, including any opening figure carried in. */
  deductedSoFar: number
  monthsRemaining: number
  /** What this month should deduct. */
  thisMonth: number
}

/**
 * What each employee's TDS should be for a month.
 *
 * Section 192 works on an estimate: the employer projects the year's salary, computes the tax on
 * it, and deducts the balance over the months that are left. Projecting from the *contracted*
 * salary rather than from the months already run means a mid-year joiner is not taxed as though
 * they earned a full year, and a revision corrects itself over the remaining months instead of
 * leaving a lump in March.
 *
 * Professional tax is projected the same way, because under the old regime it is deductible.
 */
export function tdsForMonth(db: DB, month: string): Map<number, EmployeeTax> {
  const fyStartYear = fyStartYearOf(month)
  const fyFrom = `${fyStartYear}-04-01`
  const fyTo = `${fyStartYear + 1}-03-31`
  const monthsRemaining = monthsLeftInFy(month)

  // What has already come off this financial year, from runs that are posted.
  const deducted = new Map(
    (
      db
        .prepare(
          `SELECT pl.employee_id AS employeeId, COALESCE(SUM(pl.tds), 0) AS tds, COALESCE(SUM(pl.pt), 0) AS pt
           FROM payroll_lines pl JOIN payroll_runs pr ON pr.id = pl.run_id
           WHERE pr.month >= ? AND pr.month <= ? AND pr.month < ?
           GROUP BY pl.employee_id`
        )
        .all(fyFrom.slice(0, 7), fyTo.slice(0, 7), month) as { employeeId: number; tds: number; pt: number }[]
    ).map((r) => [r.employeeId, r])
  )

  const rates = ratesForMonth(month)
  const headsByEmployee = loadEmployeeHeadSpecs(db)
  const out = new Map<number, EmployeeTax>()

  for (const e of listEmployees(db)) {
    if (!e.active) continue
    const monthDays = daysInMonth(month)
    const full = computeMonthlyPay({ ...e, heads: headsByEmployee.get(e.id) }, monthDays, monthDays, { rates })
    // Months this employee will be paid for in this financial year, joining date respected.
    const monthsPaid = e.joined && e.joined > fyFrom ? Math.max(1, monthsLeftInFy(e.joined.slice(0, 7))) : 12
    const annualGross = full.gross * monthsPaid
    const annualPt = full.pt * monthsPaid

    const computation = computeAnnualTax({
      grossSalary: annualGross,
      declaredDeductions: e.declaredDeductions ?? 0,
      professionalTax: annualPt,
      regime: e.taxRegime,
      fyStartYear
    })

    const soFar = (deducted.get(e.id)?.tds ?? 0) + (e.openingTds ?? 0)
    out.set(e.id, {
      employeeId: e.id,
      employeeName: e.name,
      regime: e.taxRegime,
      annualGross,
      computation,
      deductedSoFar: soFar,
      monthsRemaining,
      thisMonth: monthlyTds(computation.totalTax, soFar, monthsRemaining)
    })
  }
  return out
}


// ---------- Form 16 Part B (roadmap #171) ----------

export interface Form16Row {
  label: string
  amount: number
  /** Nested under the line above it on the certificate. */
  indent?: boolean
}

export interface Form16 {
  employeeId: number
  employeeName: string
  pan: string | null
  designation: string | null
  fyStartYear: number
  /** 'FY 2025-26'. */
  fyLabel: string
  /** 'AY 2026-27'. */
  ayLabel: string
  regime: Regime
  /** Salary actually paid across the year's posted runs, not the projection. */
  grossSalary: number
  rows: Form16Row[]
  computation: TaxComputation
  /** TDS actually deducted across the year's runs. */
  tdsDeducted: number
  /** Positive when more is still to be deducted; negative when too much was taken. */
  shortfall: number
  monthsPaid: number
  /** Runs that make up this certificate, so the figures can be traced. */
  months: { month: string; gross: number; tds: number }[]
}

/**
 * Part B of Form 16: what was paid, what was deducted from it, and the arithmetic in between.
 *
 * Built from the runs that were actually posted, not from the projection the monthly TDS used —
 * a certificate is a statement of fact about the year that happened. Where the two differ (a
 * mid-year revision, a late declaration), the shortfall is stated rather than smoothed away,
 * because the employee has to know about it before they file.
 *
 * Part A comes from TRACES and is not something an employer can generate; this is Part B only,
 * and the document says so.
 */
export function form16(db: DB, employeeId: number, fyStartYear: number): Form16 {
  const employee = listEmployees(db).find((e) => e.id === employeeId)
  if (!employee) throw new Error('Employee not found')

  const fromMonth = `${fyStartYear}-04`
  const toMonth = `${fyStartYear + 1}-03`
  const months = (
    db
      .prepare(
        `SELECT pr.month, pl.gross, pl.tds, pl.pt
         FROM payroll_lines pl JOIN payroll_runs pr ON pr.id = pl.run_id
         WHERE pl.employee_id = ? AND pr.month >= ? AND pr.month <= ?
         ORDER BY pr.month`
      )
      .all(employeeId, fromMonth, toMonth) as { month: string; gross: number; tds: number; pt: number }[]
  )
  if (months.length === 0) throw new Error(`No pay runs for ${employee.name} in FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`)

  const grossSalary = months.reduce((s, m) => s + m.gross, 0)
  const professionalTax = months.reduce((s, m) => s + m.pt, 0)
  const tdsDeducted = months.reduce((s, m) => s + m.tds, 0) + (employee.openingTds ?? 0)

  const computation = computeAnnualTax({
    grossSalary,
    declaredDeductions: employee.declaredDeductions ?? 0,
    professionalTax,
    regime: employee.taxRegime,
    fyStartYear
  })

  const rows: Form16Row[] = [
    { label: 'Gross salary under section 17(1)', amount: grossSalary },
    { label: 'Less: standard deduction under section 16(ia)', amount: computation.standardDeduction, indent: true }
  ]
  if (computation.professionalTaxAllowed > 0) {
    rows.push({ label: 'Less: tax on employment under section 16(iii)', amount: computation.professionalTaxAllowed, indent: true })
  }
  if (computation.chapterVIA > 0) {
    rows.push({ label: 'Less: deductions under Chapter VI-A', amount: computation.chapterVIA, indent: true })
  }
  rows.push({ label: 'Total taxable income', amount: computation.taxableIncome })
  rows.push({ label: 'Tax on total income', amount: computation.taxBeforeRebate })
  if (computation.rebate > 0) rows.push({ label: 'Less: rebate under section 87A', amount: computation.rebate, indent: true })
  if (computation.surcharge > 0) rows.push({ label: 'Add: surcharge', amount: computation.surcharge, indent: true })
  rows.push({ label: 'Add: health and education cess', amount: computation.cess, indent: true })
  rows.push({ label: 'Total tax payable', amount: computation.totalTax })
  rows.push({ label: 'Less: tax deducted at source', amount: tdsDeducted, indent: true })

  const shortfall = computation.totalTax - tdsDeducted
  rows.push({ label: shortfall >= 0 ? 'Balance tax payable' : 'Excess tax deducted', amount: Math.abs(shortfall) })

  return {
    employeeId,
    employeeName: employee.name,
    pan: employee.pan,
    designation: employee.designation,
    fyStartYear,
    fyLabel: `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`,
    ayLabel: `AY ${fyStartYear + 1}-${String(fyStartYear + 2).slice(2)}`,
    regime: employee.taxRegime,
    grossSalary,
    rows,
    computation,
    tdsDeducted,
    shortfall,
    monthsPaid: months.length,
    months: months.map((m) => ({ month: m.month, gross: m.gross, tds: m.tds }))
  }
}

export async function form16Pdf(
  db: DB,
  company: CompanyInfo,
  slug: string,
  employeeId: number,
  fyStartYear: number
): Promise<string> {
  const f = form16(db, employeeId, fyStartYear)
  const money = (p: number): string => formatPaise(p)

  const rows = f.rows
    .map(
      (r) =>
        `<tr class="${r.indent ? 'sub' : 'main'}"><td${r.indent ? ' style="padding-left:24px"' : ''}>${esc(r.label)}</td>` +
        `<td class="r num">${money(r.amount)}</td></tr>`
    )
    .join('')

  const monthRows = f.months
    .map((m) => `<tr><td class="num">${esc(m.month)}</td><td class="r num">${money(m.gross)}</td><td class="r num">${money(m.tds)}</td></tr>`)
    .join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Form 16 Part B</title><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.5 'Helvetica Neue', Arial, sans-serif; color: #16181f; padding: 30px; }
    .num { font-variant-numeric: tabular-nums; font-family: Menlo, monospace; font-size: 11.5px; }
    .head { border-bottom: 1.5px solid #16181f; padding-bottom: 12px; display: flex; justify-content: space-between; }
    h1 { font-size: 17px; } .sub { color: #555; font-size: 11px; }
    .tag { text-align: right; } .tag b { font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; }
    .parties { display: flex; gap: 40px; padding: 14px 0; border-bottom: 1px solid #16181f; }
    .parties h3, h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; text-align: left; border-bottom: 1.5px solid #16181f; padding: 6px 0; }
    td { padding: 5px 0; border-bottom: 1px dotted #bbb; }
    tr.main td { font-weight: 600; }
    tr.sub td { color: #555; }
    .r { text-align: right; }
    .note { margin-top: 16px; font-size: 10.5px; color: #555; border-top: 1px dotted #999; padding-top: 8px; }
    .sign { margin-top: 34px; display: flex; justify-content: space-between; font-size: 11px; }
  </style></head><body>
    <div class="head">
      <div><h1>${esc(company.name)}</h1><div class="sub">${esc(company.address)}</div></div>
      <div class="tag"><b>Form 16 — Part B</b><div class="sub">${esc(f.fyLabel)} · ${esc(f.ayLabel)}</div></div>
    </div>

    <div class="parties">
      <div><h3>Employee</h3><b>${esc(f.employeeName)}</b>
        <div class="sub">${esc(f.designation ?? '')}${f.pan ? ' · PAN ' + esc(f.pan) : ' · PAN not on record'}</div></div>
      <div><h3>Regime</h3>${f.regime === 'new' ? 'New (section 115BAC)' : 'Old'}
        <div class="sub">${esc(f.computation.rates.note)}</div></div>
      <div><h3>Months paid</h3><span class="num">${f.monthsPaid}</span></div>
    </div>

    <h3 style="margin-top:14px">Details of salary paid and tax deducted</h3>
    <table><tbody>${rows}</tbody></table>

    <h3 style="margin-top:18px">Month by month</h3>
    <table>
      <thead><tr><th>Month</th><th class="r">Gross</th><th class="r">TDS</th></tr></thead>
      <tbody>${monthRows}</tbody>
    </table>

    <div class="note">
      This is Part B only. Part A, carrying the TAN, the challan details and the TRACES
      verification, is downloaded from the TRACES portal and cannot be produced by an employer's
      books. Figures above are taken from the pay runs actually posted for ${esc(f.fyLabel)}.
      ${f.shortfall > 0 ? `<b>₹${money(f.shortfall)} of tax remains to be deducted or paid.</b>` : ''}
      ${f.shortfall < 0 ? `<b>₹${money(-f.shortfall)} more was deducted than the year's tax — claimable as a refund.</b>` : ''}
    </div>

    <div class="sign"><span>Place: ${esc(company.address.split(',').pop()?.trim() ?? '')}</span>
      <span>For <b>${esc(company.name)}</b><br><br><br>Authorised signatory</span></div>
  </body></html>`

  const safeName = f.employeeName.replace(/[^a-zA-Z0-9-_]/g, '_')
  return writeExportPdf(slug, `form16-${f.fyStartYear}-${safeName}.pdf`, html, { pageSize: 'A4', pageNumbers: true })
}

// ---------- payslip delivery and bulk export (roadmap #174, #176) ----------

export interface PayslipDelivery {
  employeeId: number
  employeeName: string
  path: string
  /** wa.me link with the covering message, or null when there is no usable number. */
  whatsapp: string | null
  /** mailto: draft, or null without an address. */
  mailto: string | null
  net: number
}

/**
 * Every payslip for a run, written to the exports folder, each with a way to send it.
 *
 * The PDF cannot ride inside a `wa.me` link or a `mailto:`, so the message carries the figure and
 * the person attaches the file — which is honest about what an offline app can do, and still
 * turns an afternoon of printing and handing out into one click and fifteen sends.
 */
export async function payslipsForRun(
  db: DB,
  company: CompanyInfo,
  slug: string,
  runId: number
): Promise<PayslipDelivery[]> {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const employees = new Map(listEmployees(db).map((e) => [e.id, e]))
  const out: PayslipDelivery[] = []

  for (const line of run.lines) {
    const path = await payslipPdf(db, company, slug, runId, line.employeeId)
    const e = employees.get(line.employeeId)
    const body = [
      `Dear ${line.employeeName},`,
      '',
      `Your payslip for ${run.month} is attached.`,
      `Net pay: ${formatPaise(line.net, { symbol: true })}`,
      '',
      'Regards,',
      company.name
    ].join('\n')
    const number = whatsappNumber(e?.phone ?? null)
    out.push({
      employeeId: line.employeeId,
      employeeName: line.employeeName,
      path,
      net: line.net,
      whatsapp: number ? `https://wa.me/${number}?text=${encodeURIComponent(body)}` : null,
      mailto: e?.email
        ? `mailto:${e.email}?subject=${encodeURIComponent(`Payslip for ${run.month}`)}&body=${encodeURIComponent(body)}`
        : null
    })
  }
  return out
}
