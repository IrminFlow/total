import type { DB } from '../db/connection'
import type { CompanyInfo, Employee, PayrollHeadAmount, PayrollLine, PayrollRun } from '@shared/domain'
import type { EmployeeInput, EmployeeInputPayload, EmployeeHeadsSetInput, PayHeadInput } from '@shared/schemas'
import { employeeInputSchema } from '@shared/schemas'
import type { SalaryWorkingsSnapshot } from '@shared/domain'
import {
  buildEcr, buildEsiCsv, buildPtCsv, buildPtStateCsv, computeMonthlyPay, daysInMonth, withTds, type EmployeePayInput, type PayComputation, type PayContext, type PayHeadSpec
} from '@shared/payroll'
import {
  ageBand, esiContributionPeriod, fyStartOfMonth, monthlyTds, monthsRemainingInFy, pfAdminTopUp, salaryWorkings, type SalaryWorkings
} from '@shared/payrollStatutory'
import { fyFromStartYear } from '@shared/dates'
import { amountInWords, formatPaise } from '@shared/money'
import { deleteVoucher, getLockDate, IN_BOOKS, saveVoucher } from './vouchers'
import { findOrCreateLedger } from './masters'
import { writeAudit } from './audit'
import { writeExportPdf } from './pdf'
import {
  declarationsMap, ensureSalaryTdsPayable, ensureStatutoryLedger, salaryTdsSectionId, statutoryRatesForMonth, type Form24qSalaryRow
} from './payrollStatutory'

// ---------- employees ----------

interface EmployeeRow {
  id: number; name: string; code: string | null; designation: string | null; joined: string | null
  pan: string | null; uan: string | null; esic_no: string | null
  basic: number; hra: number; special: number
  pf_enabled: number; esi_enabled: number; pt_enabled: number; pt_state: string; active: number
  pf_number: string | null; gender: 'male' | 'female' | 'other' | null; dob: string | null; tax_regime: 'new' | 'old'
  vpf_rate_bp: number; pf_full_wage: number; eps_eligible: number; is_disabled: number; metro: number; tds_enabled: number
}

const mapEmployee = (r: EmployeeRow): Employee => ({
  id: r.id, name: r.name, code: r.code, designation: r.designation, joined: r.joined,
  pan: r.pan, uan: r.uan, esicNo: r.esic_no,
  basic: r.basic, hra: r.hra, special: r.special,
  pfEnabled: !!r.pf_enabled, esiEnabled: !!r.esi_enabled, ptEnabled: !!r.pt_enabled,
  ptState: r.pt_state, active: !!r.active,
  pfNumber: r.pf_number, gender: r.gender, dob: r.dob, taxRegime: r.tax_regime,
  vpfRateBp: r.vpf_rate_bp, pfOnFullWage: !!r.pf_full_wage, epsEligible: !!r.eps_eligible,
  disabled: !!r.is_disabled, metro: !!r.metro, tdsEnabled: !!r.tds_enabled
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

export function saveEmployee(db: DB, raw: EmployeeInputPayload, id?: number): Employee {
  const input: EmployeeInput = employeeInputSchema.parse(raw)
  const before = id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as EmployeeRow | undefined : undefined
  const profile = [
    input.pfNumber ?? null, input.gender ?? null, input.dob ?? null, input.taxRegime ?? 'new', input.vpfRateBp ?? 0,
    +(input.pfOnFullWage ?? false), +(input.epsEligible ?? true), +(input.disabled ?? false), +(input.metro ?? false), +(input.tdsEnabled ?? true)
  ]
  if (id) {
    db.prepare(
      `UPDATE employees SET name = ?, code = ?, designation = ?, joined = ?, pan = ?, uan = ?, esic_no = ?,
       basic = ?, hra = ?, special = ?, pf_enabled = ?, esi_enabled = ?, pt_enabled = ?, pt_state = ?, active = ?,
       pf_number = ?, gender = ?, dob = ?, tax_regime = ?, vpf_rate_bp = ?, pf_full_wage = ?, eps_eligible = ?,
       is_disabled = ?, metro = ?, tds_enabled = ? WHERE id = ?`
    ).run(input.name, input.code, input.designation, input.joined, input.pan, input.uan, input.esicNo,
      input.basic, input.hra, input.special, +input.pfEnabled, +input.esiEnabled, +input.ptEnabled, input.ptState, +input.active, ...profile, id)
  } else {
    const res = db.prepare(
      `INSERT INTO employees (name, code, designation, joined, pan, uan, esic_no, basic, hra, special,
        pf_enabled, esi_enabled, pt_enabled, pt_state, active,
        pf_number, gender, dob, tax_regime, vpf_rate_bp, pf_full_wage, eps_eligible, is_disabled, metro, tds_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(input.name, input.code, input.designation, input.joined, input.pan, input.uan, input.esicNo,
      input.basic, input.hra, input.special, +input.pfEnabled, +input.esiEnabled, +input.ptEnabled, input.ptState, +input.active, ...profile)
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
  /** "Wages" under CoSS s.2(88) (EPF / ESI base from 21-11-2025); false = excluded (HRA, conveyance …). */
  inWages: boolean
}

interface PayHeadRow { id: number; name: string; kind: 'earning' | 'deduction'; calc: 'flat' | 'percent_of_basic'; value: number; active: number; in_wages: number }

const mapHead = (r: PayHeadRow): PayHead => ({ id: r.id, name: r.name, kind: r.kind, calc: r.calc, value: r.value, active: !!r.active, inWages: !!r.in_wages })

export function listPayHeads(db: DB): PayHead[] {
  return (db.prepare('SELECT * FROM pay_heads ORDER BY id').all() as PayHeadRow[]).map(mapHead)
}

export function savePayHead(db: DB, input: Omit<PayHeadInput, 'inWages'> & { inWages?: boolean }, id?: number): PayHead {
  if (id != null) {
    const before = db.prepare('SELECT * FROM pay_heads WHERE id = ?').get(id) as PayHeadRow | undefined
    if (!before) throw new Error('Pay head not found')
    db.prepare('UPDATE pay_heads SET name = ?, kind = ?, calc = ?, value = ?, active = ?, in_wages = ? WHERE id = ?')
      .run(input.name, input.kind, input.calc, input.value, input.active ? 1 : 0, (input.inWages ?? true) ? 1 : 0, id)
    writeAudit(db, 'pay_head', id, 'update', mapHead(before), input)
  } else {
    const res = db.prepare('INSERT INTO pay_heads (name, kind, calc, value, active, in_wages) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.name, input.kind, input.calc, input.value, input.active ? 1 : 0, (input.inWages ?? true) ? 1 : 0)
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
      `SELECT eph.employee_id AS employeeId, ph.name, ph.kind, ph.calc, ph.in_wages AS inWages,
              COALESCE(eph.override_value, ph.value) AS value
       FROM employee_pay_heads eph JOIN pay_heads ph ON ph.id = eph.pay_head_id
       WHERE ph.active = 1 ORDER BY ph.id`
    )
    .all() as { employeeId: number; name: string; kind: 'earning' | 'deduction'; calc: 'flat' | 'percent_of_basic'; value: number; inWages: number }[]
  const map = new Map<number, PayHeadSpec[]>()
  for (const r of rows) {
    const list = map.get(r.employeeId) ?? []
    list.push({ name: r.name, kind: r.kind, calc: r.calc, value: r.value, inWages: !!r.inWages })
    map.set(r.employeeId, list)
  }
  return map
}

// ---------- pay runs ----------

export interface RunPreviewLine extends Omit<PayrollLine, 'id'> {
  /** PT state the line was taxed in. */
  ptState: string
  taxRegime: 'new' | 'old'
}

const lastDayOf = (month: string): string => `${month}-${String(daysInMonth(month)).padStart(2, '0')}`

interface YtdRow { gross: number; basic: number; hra: number; pt: number; pf: number; tds: number; months: number }

/** Year-to-date figures from posted runs of the month's financial year before `month` (runs whose
 *  voucher is in the books only). */
function yearToDate(db: DB, employeeId: number, month: string): YtdRow {
  const fy = fyFromStartYear(fyStartOfMonth(month))
  return db.prepare(
    `SELECT COALESCE(SUM(pl.gross), 0) AS gross, COALESCE(SUM(pl.basic), 0) AS basic, COALESCE(SUM(pl.hra), 0) AS hra,
            COALESCE(SUM(pl.pt), 0) AS pt, COALESCE(SUM(pl.pf_emp + pl.vpf), 0) AS pf, COALESCE(SUM(pl.tds), 0) AS tds,
            COUNT(*) AS months
       FROM payroll_lines pl JOIN payroll_runs r ON r.id = pl.run_id JOIN vouchers v ON v.id = r.voucher_id
      WHERE pl.employee_id = ? AND r.month >= ? AND r.month < ? AND ${IN_BOOKS}`
  ).get(employeeId, fy.from.slice(0, 7), month) as YtdRow
}

/** Covered by ESI in an earlier posted month of the same contribution period? */
function esiCoveredEarlier(db: DB, employeeId: number, month: string): boolean {
  const period = esiContributionPeriod(month)
  return !!db.prepare(
    `SELECT 1 FROM payroll_lines pl JOIN payroll_runs r ON r.id = pl.run_id JOIN vouchers v ON v.id = r.voucher_id
      WHERE pl.employee_id = ? AND r.month >= ? AND r.month < ? AND pl.esi_covered = 1 AND ${IN_BOOKS} LIMIT 1`
  ).get(employeeId, period.from, month)
}

const payInput = (e: Employee, heads: PayHeadSpec[] | undefined): EmployeePayInput => ({
  ...e, heads, vpfRateBp: e.vpfRateBp, pfOnFullWage: e.pfOnFullWage, epsEligible: e.epsEligible, disabled: e.disabled, gender: e.gender
})

/**
 * Salary TDS for the month: project the year (paid so far + this month + the contracted month ×
 * the months after this one), work out the year's tax under the employee's regime with their
 * declarations, and spread what is still due over the months left (payrollStatutory.monthlyTds).
 */
function projectTds(
  db: DB, e: Employee, month: string, pay: PayComputation, full: PayComputation
): { tds: number; snapshot: SalaryWorkingsSnapshot; workings: SalaryWorkings } {
  const fyStart = fyStartOfMonth(month)
  const ytd = yearToDate(db, e.id, month)
  const remaining = monthsRemainingInFy(month)
  const future = remaining - 1
  const workings = salaryWorkings({
    fyStartYear: fyStart, regime: e.taxRegime, age: ageBand(e.dob, fyStart), metro: e.metro,
    grossPaise: ytd.gross + pay.gross + full.gross * future,
    basicPaise: ytd.basic + pay.basic + full.basic * future,
    hraPaise: ytd.hra + pay.hra + full.hra * future,
    ptPaise: ytd.pt + pay.pt + full.pt * future,
    employeePfPaise: ytd.pf + pay.pfEmp + pay.vpf + (full.pfEmp + full.vpf) * future,
    declarations: declarationsMap(db, e.id, fyStart)
  })
  const tds = monthlyTds(workings.taxPayableByEmployer, ytd.tds, month)
  return {
    tds,
    workings,
    snapshot: {
      regime: workings.regime, act: workings.act, gross: workings.gross, hraExemption: workings.hraExemption,
      standardDeduction: workings.standardDeduction, professionalTax: workings.professionalTax, otherIncome: workings.otherIncome,
      housePropertyLoss: workings.housePropertyLoss, deductionsTotal: workings.deductionsTotal, totalIncome: workings.totalIncome,
      annualTax: workings.taxOnIncome.total, previousEmployerTds: workings.previousEmployerTds, deductedBefore: ytd.tds, monthsRemaining: remaining
    }
  }
}

export function previewRun(db: DB, month: string, days: { employeeId: number; payableDays: number }[]): RunPreviewLine[] {
  const monthDays = daysInMonth(month)
  const byId = new Map(days.map((d) => [d.employeeId, d.payableDays]))
  const headsByEmployee = loadEmployeeHeadSpecs(db)
  const rates = statutoryRatesForMonth(db, month)
  return listEmployees(db)
    .filter((e) => e.active)
    .map((e) => {
      const payableDays = byId.get(e.id) ?? monthDays
      const input = payInput(e, headsByEmployee.get(e.id))
      const ctx: PayContext = {
        month, pf: rates.pf, esi: rates.esi, ssWagesCapBp: rates.ssWagesCapBp,
        // A state with no slab rows in force levies no PT for the month.
        ptSlabs: rates.ptByState.get(e.ptState) ?? [],
        esiCoveredEarlier: esiCoveredEarlier(db, e.id, month)
      }
      let pay = computeMonthlyPay(input, payableDays, monthDays, ctx)
      let tdsWorkings: SalaryWorkingsSnapshot | null = null
      if (e.tdsEnabled) {
        const full = computeMonthlyPay(input, monthDays, monthDays, ctx)
        const t = projectTds(db, e, month, pay, full)
        pay = withTds(pay, t.tds)
        tdsWorkings = t.snapshot
      }
      return {
        employeeId: e.id, employeeName: e.name, payableDays, monthDays, ...pay,
        tdsWorkings, ptState: e.ptState, taxRegime: e.taxRegime
      }
    })
}

/**
 * The year's ACTUAL salary workings for an employee (no projection): every posted line of the
 * financial year plus the declarations — Form 16 Part B / 24Q annexure II.
 */
export function actualWorkings(db: DB, employeeId: number, fyStartYear: number): Form24qSalaryRow | null {
  const fy = fyFromStartYear(fyStartYear)
  const e = listEmployees(db).find((x) => x.id === employeeId)
  if (!e) return null
  const from = fy.from.slice(0, 7)
  const to = fy.to.slice(0, 7)
  const agg = db.prepare(
    `SELECT COALESCE(SUM(pl.gross), 0) AS gross, COALESCE(SUM(pl.basic), 0) AS basic, COALESCE(SUM(pl.hra), 0) AS hra,
            COALESCE(SUM(pl.pt), 0) AS pt, COALESCE(SUM(pl.pf_emp + pl.vpf), 0) AS pf, COALESCE(SUM(pl.tds), 0) AS tds,
            MIN(r.month) AS first, MAX(r.month) AS last, COUNT(*) AS n
       FROM payroll_lines pl JOIN payroll_runs r ON r.id = pl.run_id JOIN vouchers v ON v.id = r.voucher_id
      WHERE pl.employee_id = ? AND r.month BETWEEN ? AND ? AND ${IN_BOOKS}`
  ).get(employeeId, from, to) as
    { gross: number; basic: number; hra: number; pt: number; pf: number; tds: number; first: string | null; last: string | null; n: number }
  if (!agg.n) return null
  // The regime of the year's latest posted line (a regime is chosen once a year with the employer).
  const latest = db.prepare(
    `SELECT pl.tax_regime AS regime FROM payroll_lines pl JOIN payroll_runs r ON r.id = pl.run_id JOIN vouchers v ON v.id = r.voucher_id
      WHERE pl.employee_id = ? AND r.month BETWEEN ? AND ? AND ${IN_BOOKS} ORDER BY r.month DESC LIMIT 1`
  ).get(employeeId, from, to) as { regime: 'new' | 'old' | null } | undefined
  const regime = latest?.regime ?? e.taxRegime
  const workings = salaryWorkings({
    fyStartYear, regime, age: ageBand(e.dob, fyStartYear), metro: e.metro,
    grossPaise: agg.gross, basicPaise: agg.basic, hraPaise: agg.hra, ptPaise: agg.pt, employeePfPaise: agg.pf,
    declarations: declarationsMap(db, employeeId, fyStartYear)
  })
  return {
    employeeId, employeeName: e.name, pan: e.pan, regime,
    periodFrom: `${agg.first}-01`, periodTo: lastDayOf(agg.last!),
    workings, tdsDeductedPaise: agg.tds, shortfallPaise: workings.taxPayableByEmployer - agg.tds
  }
}

/** Post the month's payroll: stores the run + lines and books one balanced Journal voucher — all
 *  inside ONE transaction (saveVoucher's inner db.transaction nests as a savepoint), so a failure
 *  while writing run rows can never leave an orphaned salary voucher behind. Salary TDS is
 *  credited to the section 192 payable ledger and recorded as one tds_entries row per employee
 *  (employee_id set), so the TDS screen's Deducted / Challans / 24Q include it. */
export function commitRun(db: DB, month: string, days: { employeeId: number; payableDays: number }[]): PayrollRun {
  const existing = db.prepare('SELECT id FROM payroll_runs WHERE month = ?').get(month) as { id: number } | undefined
  if (existing) throw new Error(`Payroll for ${month} is already posted`)
  const lines = previewRun(db, month, days)
  if (lines.length === 0) throw new Error('No active employees')

  const sum = (f: (l: RunPreviewLine) => number): number => lines.reduce((s, l) => s + f(l), 0)
  const gross = sum((l) => l.gross)
  const pfEmp = sum((l) => l.pfEmp + l.vpf)
  const pfEr = sum((l) => l.pfEr)
  const pfAdmin = sum((l) => l.pfAdmin)
  const edli = sum((l) => l.edli)
  const rates = statutoryRatesForMonth(db, month)
  const adminTopUp = pfAdminTopUp(pfAdmin, lines.filter((l) => l.pfEr > 0).length, rates.pf)
  const esiEmp = sum((l) => l.esiEmp)
  const esiEr = sum((l) => l.esiEr)
  const pt = sum((l) => l.pt)
  const tds = sum((l) => l.tds)
  const otherDeductions = sum((l) => l.otherDeductions)
  const net = sum((l) => l.net)

  const journal = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal' AND is_system = 1").get() as { id: number }
  const employees = new Map(listEmployees(db).map((e) => [e.id, e]))

  const lastDay = lastDayOf(month)
  const commit = db.transaction((): number => {
    const voucherLines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations: never[] }[] = []
    const push = (ledgerId: () => number, drCr: 'dr' | 'cr', amount: number): void => {
      if (amount > 0) voucherLines.push({ ledgerId: ledgerId(), drCr, amount, costAllocations: [] })
    }
    const byName = (name: string, group: string) => (): number => findOrCreateLedger(db, name, group)
    push(byName('Salaries', 'Indirect Expenses'), 'dr', gross)
    push(byName('Employer PF Contribution', 'Indirect Expenses'), 'dr', pfEr)
    push(byName('PF Admin & EDLI Charges', 'Indirect Expenses'), 'dr', pfAdmin + edli + adminTopUp)
    push(byName('Employer ESI Contribution', 'Indirect Expenses'), 'dr', esiEr)
    push(() => ensureStatutoryLedger(db, 'pf'), 'cr', pfEmp + pfEr + pfAdmin + edli + adminTopUp)
    push(() => ensureStatutoryLedger(db, 'esi'), 'cr', esiEmp + esiEr)
    push(() => ensureStatutoryLedger(db, 'pt'), 'cr', pt)
    push(() => ensureSalaryTdsPayable(db), 'cr', tds)
    push(byName('Employee Deductions Payable', 'Provisions'), 'cr', otherDeductions)
    const salariesPayable = ensureStatutoryLedger(db, 'salary')
    push(() => salariesPayable, 'cr', net)

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

    const res = db.prepare('INSERT INTO payroll_runs (month, voucher_id, pf_admin_topup) VALUES (?, ?, ?)').run(month, voucher.id, adminTopUp)
    const runId = Number(res.lastInsertRowid)
    const insert = db.prepare(
      `INSERT INTO payroll_lines (run_id, employee_id, payable_days, month_days, basic, hra, special, gross,
        pf_emp, pf_er, esi_emp, esi_er, pt, net,
        other_earnings, other_deductions, eps_er, pf_admin, edli, heads_json,
        vpf, epf_wage, eps_wage, edli_wage, esi_covered, esi_wage, tds, pt_state, tax_regime, tds_workings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const sectionId = tds > 0 ? salaryTdsSectionId(db) : 0
    const tdsEntry = db.prepare(
      `INSERT INTO tds_entries (voucher_id, section_id, party_ledger_id, pan, base_amount, tds_amount, deductee_type_at, rate_bp_at, is_manual, employee_id)
       VALUES (?, ?, ?, ?, ?, ?, 'individual_huf', NULL, 0, ?)`
    )
    for (const l of lines) {
      insert.run(runId, l.employeeId, l.payableDays, l.monthDays, l.basic, l.hra, l.special, l.gross,
        l.pfEmp, l.pfEr, l.esiEmp, l.esiEr, l.pt, l.net,
        l.otherEarnings, l.otherDeductions, l.epsEr, l.pfAdmin, l.edli,
        l.headAmounts.length ? JSON.stringify(l.headAmounts) : null,
        l.vpf, l.epfWage, l.epsWage, l.edliWage, l.esiCovered ? 1 : 0, l.esiWage, l.tds, l.ptState, l.taxRegime,
        l.tdsWorkings ? JSON.stringify(l.tdsWorkings) : null)
      if (l.tds > 0) tdsEntry.run(voucher.id, sectionId, salariesPayable, employees.get(l.employeeId)?.pan ?? null, l.gross, l.tds, l.employeeId)
    }
    return runId
  })
  const runId = commit()
  const created = getRun(db, runId)!
  writeAudit(db, 'payroll_run', runId, 'create', null, created)
  return created
}

interface RunRow { id: number; month: string; voucher_id: number | null; created_at: string; pf_admin_topup: number }
interface LineRow {
  id: number; employee_id: number; employeeName: string; payable_days: number; month_days: number
  basic: number; hra: number; special: number; gross: number
  pf_emp: number; pf_er: number; esi_emp: number; esi_er: number; pt: number; net: number
  other_earnings: number; other_deductions: number; eps_er: number; pf_admin: number; edli: number
  heads_json: string | null
  vpf: number; epf_wage: number; eps_wage: number; edli_wage: number; esi_covered: number; esi_wage: number; tds: number
  tds_workings_json: string | null
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
    pfAdminTopUp: r.pf_admin_topup,
    lines: lines.map((l) => ({
      id: l.id, employeeId: l.employee_id, employeeName: l.employeeName,
      payableDays: l.payable_days, monthDays: l.month_days,
      basic: l.basic, hra: l.hra, special: l.special,
      otherEarnings: l.other_earnings, otherDeductions: l.other_deductions, gross: l.gross,
      pfEmp: l.pf_emp, pfEr: l.pf_er, epsEr: l.eps_er, pfAdmin: l.pf_admin, edli: l.edli,
      esiEmp: l.esi_emp, esiEr: l.esi_er, pt: l.pt, net: l.net,
      headAmounts: l.heads_json ? (JSON.parse(l.heads_json) as PayrollHeadAmount[]) : [],
      vpf: l.vpf, epfWage: l.epf_wage, epsWage: l.eps_wage, edliWage: l.edli_wage, esiCovered: !!l.esi_covered, esiWage: l.esi_wage, tds: l.tds,
      tdsWorkings: l.tds_workings_json ? (JSON.parse(l.tds_workings_json) as SalaryWorkingsSnapshot) : null
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
    if (run.voucherId) {
      // The run owns its salary TDS entries — a binned salary journal must not keep feeding 24Q.
      db.prepare('DELETE FROM tds_entries WHERE voucher_id = ? AND employee_id IS NOT NULL').run(run.voucherId)
      deleteVoucher(db, run.voucherId)
    }
  })
  del()
  writeAudit(db, 'payroll_run', id, 'delete', run, null)
}

// ---------- statutory exports (PF ECR / ESI upload / PT summary) ----------

/** EPFO ECR 2.0 text for a posted run — one #~# line per PF member with a UAN. */
export function ecrForRun(db: DB, runId: number): { filename: string; text: string } {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const employees = new Map(listEmployees(db).map((e) => [e.id, e]))
  const rows = run.lines
    .filter((l) => {
      const e = employees.get(l.employeeId)
      return !!e?.pfEnabled && !!e.uan && l.pfEmp > 0
    })
    .map((l) => ({
      uan: employees.get(l.employeeId)!.uan!,
      name: l.employeeName,
      gross: l.gross,
      basic: l.basic,
      pfEmp: l.pfEmp,
      pfEr: l.pfEr,
      epsEr: l.epsEr,
      payableDays: l.payableDays,
      monthDays: l.monthDays,
      epfWage: l.epfWage || undefined,
      epsWage: l.epfWage ? l.epsWage : undefined,
      edliWage: l.edliWage || undefined,
      vpf: l.vpf
    }))
  if (rows.length === 0) throw new Error('No PF members with a UAN in this run — add UANs on the employee records first')
  return { filename: `pf-ecr-${run.month}.txt`, text: buildEcr(rows) }
}

/** ESIC monthly-contribution upload CSV for a posted run. */
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
      // ESI wages as contributed (s.2(88) wages from 21-11-2025); gross for pre-029 lines.
      gross: l.esiWage || l.gross
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
  const byState = new Map<string, PtSummaryRow>()
  for (const l of ptLines(db, runId)) {
    const row = byState.get(l.state) ?? { state: l.state, employees: 0, gross: 0, pt: 0 }
    row.employees += 1
    row.gross += l.gross
    row.pt += l.pt
    byState.set(l.state, row)
  }
  return [...byState.values()].sort((a, b) => a.state.localeCompare(b.state))
}

/** A run's lines with the PT state they were taxed in (stored on the line since migration 029;
 *  the employee's current state for older lines). */
function ptLines(db: DB, runId: number): { employeeName: string; state: string; gross: number; pt: number }[] {
  return db.prepare(
    `SELECT e.name AS employeeName, COALESCE(pl.pt_state, e.pt_state, 'MH') AS state, pl.gross, pl.pt
       FROM payroll_lines pl JOIN employees e ON e.id = pl.employee_id WHERE pl.run_id = ? ORDER BY e.name`
  ).all(runId) as { employeeName: string; state: string; gross: number; pt: number }[]
}

/** State-wise PT return CSV for a posted run (the file the state challan is filled from); with
 *  `state`, that state's employee-wise return instead. */
export function ptCsvForRun(db: DB, runId: number, state?: string): { filename: string; text: string } {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  if (state) {
    const rows = ptLines(db, runId).filter((l) => l.state === state)
    if (rows.length === 0) throw new Error(`No employees taxed in ${state} in this run`)
    return { filename: `pt-return-${state}-${run.month}.csv`, text: buildPtStateCsv(state, run.month, rows) }
  }
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
  const totalDeductions = line.pfEmp + line.esiEmp + line.pt + line.otherDeductions

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
