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
import {
  cycleContaining, cycleShare, cycleStatutory, cyclesInMonth, monthLabelOf, payableDaysInCycle,
  proratedPayableDays, type CyclePeriod, type CycleShare, type PayCycle
} from '@shared/payCycle'
import { dueRecoveries, outstandingByEmployee, payableDaysFor, recordRecoveries } from './attendance'
import { fullAndFinal, type FnfResult } from '@shared/fnf'
import { whatsappNumber } from '@shared/outstanding'
import { serviceLength } from '@shared/gratuity'
import { fyOf, isValidISODate } from '@shared/dates'
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
  pay_cycle: string | null
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
  declaredDeductions: r.declared_deductions, openingTds: r.opening_tds,
  // NULL cannot happen (the column is NOT NULL DEFAULT 'monthly'), but a row written by an older
  // build through a raw INSERT reads back as monthly rather than as undefined.
  payCycle: (r.pay_cycle === 'weekly' || r.pay_cycle === 'fortnightly' ? r.pay_cycle : 'monthly')
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
       opening_tds = ?, pay_cycle = ?, active = ? WHERE id = ?`
    ).run(input.name, input.code, input.designation, input.joined, input.pan, input.uan, input.esicNo,
      input.basic, input.hra, input.special, +input.pfEnabled, +input.esiEnabled, +input.ptEnabled, input.ptState,
      input.bankAccount ?? null, input.ifsc ?? null, input.email ?? null, input.phone ?? null,
      input.taxRegime ?? null, input.declaredDeductions ?? null, input.openingTds ?? null,
      input.payCycle ?? 'monthly', +input.active, id)
  } else {
    const res = db.prepare(
      `INSERT INTO employees (name, code, designation, joined, pan, uan, esic_no, basic, hra, special,
        pf_enabled, esi_enabled, pt_enabled, pt_state, bank_account, ifsc, email, phone,
        tax_regime, declared_deductions, opening_tds, pay_cycle, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(input.name, input.code, input.designation, input.joined, input.pan, input.uan, input.esicNo,
      input.basic, input.hra, input.special, +input.pfEnabled, +input.esiEnabled, +input.ptEnabled, input.ptState,
      input.bankAccount ?? null, input.ifsc ?? null, input.email ?? null, input.phone ?? null,
      input.taxRegime ?? null, input.declaredDeductions ?? null, input.openingTds ?? null,
      input.payCycle ?? 'monthly', +input.active)
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

// ---------- pay cycles (roadmap #179) ----------

/**
 * The company's pay-week boundary: the date some weekly or fortnightly period started.
 *
 * One anchor for the whole company rather than one per employee. A factory's pay week is a fact
 * about the factory — everybody's week ends on the same evening — and a per-employee boundary
 * would put two people on the same cycle in different statutory months.
 */
const CYCLE_ANCHOR_KEY = 'payroll_cycle_anchor'

/** 1 January 2024 was a Monday, so the default pay week runs Monday to Sunday. */
export const DEFAULT_CYCLE_ANCHOR = '2024-01-01'

export function cycleAnchor(db: DB): string {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(CYCLE_ANCHOR_KEY) as { value: string } | undefined
  return row && isValidISODate(row.value) ? row.value : DEFAULT_CYCLE_ANCHOR
}

/**
 * Move the pay-week boundary.
 *
 * Refused once anything is posted on a cycle that depends on it: the anchor decides which weeks
 * exist, so moving it under a posted run would leave that run belonging to a period the app no
 * longer believes in — and the month's true-up would then apportion against a different set of
 * cycles than the one the money was actually paid on.
 */
export function setCycleAnchor(db: DB, date: string): string {
  if (!isValidISODate(date)) throw new Error(`${date} is not a date`)
  const posted = db.prepare("SELECT COUNT(*) AS n FROM payroll_runs WHERE cycle <> 'monthly'").get() as { n: number }
  if (posted.n > 0 && date !== cycleAnchor(db)) {
    throw new Error('Pay weeks are already posted against the current boundary — delete those runs before moving it')
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CYCLE_ANCHOR_KEY, date)
  return date
}

/** The cycles of a statutory month, on the company's boundary. */
export function cyclePeriods(db: DB, cycle: PayCycle, month: string): CyclePeriod[] {
  return cyclesInMonth(cycle, month, cycleAnchor(db))
}

/** The period a date falls in — what "run this week's payroll" resolves to. `on` may be a month. */
export function periodFor(db: DB, cycle: PayCycle, on: string): CyclePeriod {
  return cycleContaining(cycle, on.length === 7 ? `${on}-01` : on, cycleAnchor(db))
}

/** 'June 2026', or '29 Jan – 04 Feb 2026' — the same shape CyclePeriod.label carries. */
function labelOfPeriod(cycle: PayCycle, from: string, to: string): string {
  if (cycle === 'monthly') return monthLabelOf(from.slice(0, 7))
  const day = (iso: string): string => `${iso.slice(8, 10)} ${MONTH_LABELS[Number(iso.slice(5, 7)) - 1]}`
  return `${day(from)} – ${day(to)} ${to.slice(0, 4)}`
}

/** The statutory figures a month's EARLIER cycles have already taken off an employee. */
interface Deducted {
  pfEmp: number; pfEr: number; epsEr: number; pfAdmin: number; edli: number
  esiEmp: number; esiEr: number; pt: number; tds: number
}
const NOTHING_DEDUCTED: Deducted = {
  pfEmp: 0, pfEr: 0, epsEr: 0, pfAdmin: 0, edli: 0, esiEmp: 0, esiEr: 0, pt: 0, tds: 0
}

function deductedEarlierInMonth(db: DB, month: string, before: string): Map<number, Deducted> {
  const rows = db
    .prepare(
      `SELECT pl.employee_id AS employeeId,
              COALESCE(SUM(pl.pf_emp), 0) AS pfEmp, COALESCE(SUM(pl.pf_er), 0) AS pfEr,
              COALESCE(SUM(pl.eps_er), 0) AS epsEr, COALESCE(SUM(pl.pf_admin), 0) AS pfAdmin,
              COALESCE(SUM(pl.edli), 0) AS edli, COALESCE(SUM(pl.esi_emp), 0) AS esiEmp,
              COALESCE(SUM(pl.esi_er), 0) AS esiEr, COALESCE(SUM(pl.pt), 0) AS pt,
              COALESCE(SUM(pl.tds), 0) AS tds
       FROM payroll_lines pl JOIN payroll_runs pr ON pr.id = pl.run_id
       WHERE pr.month = ? AND pr.period_start < ?
       GROUP BY pl.employee_id`
    )
    .all(month, before) as (Deducted & { employeeId: number })[]
  return new Map(rows.map((r) => [r.employeeId, r]))
}

/**
 * How a month's payable days split across its cycles.
 *
 * Each cycle takes the difference between its cumulative target and the previous one, exactly as
 * the statutory true-up does. Prorating each cycle independently would not work: 31 days over
 * four seven-day weeks is 7.75 days each, which the half-day rounding turns into 8 — and four
 * eights is 32 days of pay in a 31-day month.
 *
 * The result is then clipped to the days the employee was actually on the payroll, so a
 * mid-cycle joiner is paid from the day they joined rather than from the Monday the week opened.
 */
function cycleDayShares(periods: CyclePeriod[], monthPayableDays: number, joined: string | null): number[] {
  let previous = 0
  return periods.map((p) => {
    const share = cycleShare(periods, p.key)!
    const target = share.isLast ? monthPayableDays : proratedPayableDays(monthPayableDays, share, share.cumulativeDays)
    const raw = target - previous
    previous = target
    // Scaled by the fraction of the period the employee was on the payroll for, not capped at it:
    // a week is worth 7.5 days of a 30-day month once the month's own 28 covered days are shared
    // out, and capping at the week's seven calendar days would quietly pay everybody 28/30ths.
    // There is no leaving date on the employee record — someone who leaves is settled through
    // full-and-final and marked inactive — so only the joining side can clip a period today.
    const present = payableDaysInCycle(p, joined, null)
    if (present >= p.days) return raw
    // Half-day granularity, the same as the attendance register's.
    return Math.max(0, Math.round(((raw * present) / p.days) * 2) / 2)
  })
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
  return previewPeriod(db, periodFor(db, 'monthly', month), days)
}

/**
 * Preview one pay period — a month, a fortnight or a week (roadmap #179).
 *
 * Earnings are prorated to the period. Statutory deductions are NOT: PF's wage ceiling, ESI's
 * gross limit, every state's professional-tax slab and TDS under section 192 are defined per
 * MONTH, so each is computed on the whole statutory month and apportioned across that month's
 * cycles. What this period deducts is the difference between its cumulative share and what the
 * month's earlier cycles already took — a running true-up, so the month lands on exactly the
 * right total even though its attendance was not fully known when its first week was paid.
 *
 * Only employees on this period's cycle appear in it. An employee has one pay cycle, and the
 * office being monthly while the floor is weekly is the whole point of the feature.
 */
export function previewPeriod(
  db: DB,
  period: CyclePeriod,
  days: { employeeId: number; payableDays: number }[]
): RunPreviewLine[] {
  const month = period.statutoryMonth
  const monthDays = daysInMonth(month)
  const rates = ratesForMonth(month)
  const periods = cyclePeriods(db, period.cycle, month)
  const share = cycleShare(periods, period.key)
  if (!share) throw new Error(`${period.label} is not one of ${monthLabelOf(month)}'s pay periods`)

  const byId = new Map(days.map((d) => [d.employeeId, d.payableDays]))
  const fromRegister = new Map(payableDaysFor(db, month).map((a) => [a.employeeId, a.payableDays]))
  // An advance instalment is a monthly event, and `loan_recoveries` is UNIQUE(loan_id, month), so
  // it is recovered in the month's LAST cycle only. Splitting it across a month's weeks would
  // either collide on that constraint or record the whole month's recovery against one week.
  //
  // Grouped, not keyed: an employee can owe on two advances at once, and a Map keyed by employee
  // silently kept only the last one — deducting a single instalment and quietly stretching the
  // other loan by a month every month.
  const recoveries = new Map<number, number>()
  if (share.isLast) {
    for (const r of dueRecoveries(db, month)) {
      recoveries.set(r.employeeId, (recoveries.get(r.employeeId) ?? 0) + r.amount)
    }
  }
  const tdsByEmployee = tdsForMonth(db, month)
  const headsByEmployee = loadEmployeeHeadSpecs(db)
  const already = deductedEarlierInMonth(db, month, period.from)

  return listEmployees(db)
    .filter((e) => e.active && e.payCycle === period.cycle)
    .map((e) => {
      const monthPayableDays = byId.get(e.id) ?? fromRegister.get(e.id) ?? monthDays
      const heads = headsByEmployee.get(e.id)
      const advanceRecovery = recoveries.get(e.id) ?? 0
      const tds = tdsByEmployee.get(e.id)?.thisMonth ?? 0

      // A monthly run IS the month, so nothing is split and nothing is clipped: the register is
      // the record for a monthly employee, joining date included, exactly as it has always been.
      const shares = period.cycle === 'monthly' ? [monthPayableDays] : cycleDayShares(periods, monthPayableDays, e.joined)
      const payableDays = shares[share.index] ?? 0
      const monthEffectiveDays = shares.reduce((s, d) => s + d, 0)

      // The rates in force for THIS month, not today's. A run recomputed after a rate change
      // must still answer what it answered when it was posted and filed.
      const cyclePay = computeMonthlyPay({ ...e, heads }, payableDays, monthDays, { rates })
      // The month as a whole — the only unit PF, ESI, PT and TDS are defined on.
      const monthPay = computeMonthlyPay({ ...e, heads, advanceRecovery, tds }, monthEffectiveDays, monthDays, { rates })

      // Apportioned on the days this employee is actually PAID for in each cycle, not on the
      // month's bare calendar weeks. The two are the same for anyone there all month, which is
      // almost everybody; where they differ — a mid-month joiner, a fortnight of unpaid leave —
      // the deduction has to land in the weeks that carry the wages. Weighting a week somebody
      // was not employed for would hand them a payslip with a PF deduction and no pay.
      //
      // This is not prorating twice: the monthly figure is already fixed, and only the question
      // of which cycle carries which slice of it is being answered here.
      const paidShare: CycleShare = {
        ...share,
        cumulativeDays: shares.slice(0, share.index + 1).reduce((s, d) => s + d, 0),
        totalDays: monthEffectiveDays
      }
      const taken = already.get(e.id) ?? NOTHING_DEDUCTED
      const take = (monthly: number, sofar: number): number => cycleStatutory(monthly, paidShare, sofar)
      const pfEmp = take(monthPay.pfEmp, taken.pfEmp)
      const pfEr = take(monthPay.pfEr, taken.pfEr)
      const epsEr = take(monthPay.epsEr, taken.epsEr)
      const pfAdmin = take(monthPay.pfAdmin, taken.pfAdmin)
      const edli = take(monthPay.edli, taken.edli)
      const esiEmp = take(monthPay.esiEmp, taken.esiEmp)
      const esiEr = take(monthPay.esiEr, taken.esiEr)
      const pt = take(monthPay.pt, taken.pt)
      const thisTds = take(monthPay.tds, taken.tds)

      const afterStatutory = cyclePay.gross - pfEmp - esiEmp - pt - cyclePay.otherDeductions
      // Never recover more than this period can pay: an instalment that pushes the net negative
      // turns a deduction into a debt, which is not what the payslip says and not what the bank
      // file can carry. The remainder simply waits.
      const recovered = Math.max(0, Math.min(monthPay.advanceRecovery, afterStatutory - thisTds))

      return {
        employeeId: e.id,
        employeeName: e.name,
        payableDays,
        monthDays,
        basic: cyclePay.basic,
        hra: cyclePay.hra,
        special: cyclePay.special,
        otherEarnings: cyclePay.otherEarnings,
        otherDeductions: cyclePay.otherDeductions,
        advanceRecovery: recovered,
        tds: thisTds,
        gross: cyclePay.gross,
        pfEmp, pfEr, epsEr, pfAdmin, edli, esiEmp, esiEr, pt,
        net: afterStatutory - thisTds - recovered,
        headAmounts: cyclePay.headAmounts
      }
    })
}

/** Post a month's payroll — the monthly cycle's period for that month. */
export function commitRun(db: DB, month: string, days: { employeeId: number; payableDays: number }[]): PayrollRun {
  return commitPeriod(db, periodFor(db, 'monthly', month), days)
}

/** Post one pay period: stores the run + lines and books one balanced Journal voucher — all
 *  inside ONE transaction (saveVoucher's inner db.transaction nests as a savepoint), so a failure
 *  while writing run rows can never leave an orphaned salary voucher behind. */
export function commitPeriod(
  db: DB,
  period: CyclePeriod,
  days: { employeeId: number; payableDays: number }[]
): PayrollRun {
  const month = period.statutoryMonth
  const existing = db
    .prepare('SELECT id FROM payroll_runs WHERE cycle = ? AND period_start = ?')
    .get(period.cycle, period.from) as { id: number } | undefined
  if (existing) throw new Error(`Payroll for ${period.cycle === 'monthly' ? month : period.label} is already posted`)
  const lines = previewPeriod(db, period, days)
  if (lines.length === 0) {
    throw new Error(
      period.cycle === 'monthly' ? 'No active employees' : `No active employees on the ${period.cycle} pay cycle`
    )
  }

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
    if (amount === 0) return
    // A negative figure is a refund — a month whose statutory total fell after earlier cycles of
    // it had already deducted. It posts on the other side rather than being dropped: dropping it
    // would unbalance the journal, and clamping it would leave the employee permanently short.
    const side: 'dr' | 'cr' = amount > 0 ? drCr : drCr === 'dr' ? 'cr' : 'dr'
    voucherLines.push({
      ledgerId: findOrCreateLedger(db, name, group),
      drCr: side,
      amount: Math.abs(amount),
      costAllocations
    })
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

  // Only the month's last cycle recovers an advance, so only it has recoveries to record.
  const periods = cyclePeriods(db, period.cycle, month)
  const dueThisMonth = (cycleShare(periods, period.key)?.isLast ?? true) ? dueRecoveries(db, month) : []
  const commit = db.transaction((): number => {
    // A period in which nobody earned anything — a week entirely before the only employee joined
    // — posts the run with no voucher. There is nothing to book, and an empty journal is worse
    // than none: it cannot balance, and it claims something happened.
    const voucherId =
      voucherLines.length === 0
        ? null
        : saveVoucher(db, {
            voucherTypeId: journal.id,
            date: period.to,
            number: undefined,
            partyLedgerId: null,
            narration:
              `Salary for ${period.cycle === 'monthly' ? month : period.label}` +
              ` — ${lines.length} employee${lines.length > 1 ? 's' : ''}`,
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
          }).id

    const res = db
      .prepare('INSERT INTO payroll_runs (month, cycle, period_start, period_end, voucher_id) VALUES (?, ?, ?, ?, ?)')
      .run(month, period.cycle, period.from, period.to, voucherId)
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
    // Spread what was actually recovered back over that employee's open advances, oldest first.
    // The line carries one number because the payslip shows one; the register needs it split.
    //
    // Sorted here rather than trusted from the caller: dueRecoveries reads listLoans, which is
    // ordered newest-first for the screen, and inheriting that would quietly settle the newest
    // advance ahead of the oldest whenever the pay could not cover both.
    const recovered: { loanId: number; amount: number }[] = []
    const byAge = [...dueThisMonth].sort((a, b) => a.loanId - b.loanId)
    for (const l of lines.filter((x) => x.advanceRecovery > 0)) {
      let left = l.advanceRecovery
      for (const due of byAge.filter((d) => d.employeeId === l.employeeId)) {
        if (left <= 0) break
        const take = Math.min(left, due.amount)
        recovered.push({ loanId: due.loanId, amount: take })
        left -= take
      }
    }
    recordRecoveries(db, runId, month, recovered)
    return runId
  })
  const runId = commit()
  const created = getRun(db, runId)!
  writeAudit(db, 'payroll_run', runId, 'create', null, created)
  return created
}

interface RunRow {
  id: number; month: string; cycle: PayCycle; period_start: string; period_end: string
  voucher_id: number | null; created_at: string
}

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
    cycle: r.cycle,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodLabel: labelOfPeriod(r.cycle, r.period_start, r.period_end),
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
  // By period end, not by month: a month can now hold four or five runs, and ordering by month
  // alone left this week and last week in whatever order SQLite happened to return them.
  const rows = db
    .prepare('SELECT id FROM payroll_runs ORDER BY period_end DESC, id DESC')
    .all() as { id: number }[]
  return rows.map((r) => getRun(db, r.id)!).filter(Boolean)
}

export function deleteRun(db: DB, id: number): void {
  const run = getRun(db, id)
  if (!run) throw new Error('Pay run not found')
  const lock = getLockDate(db)
  // The period's own last day — the date its voucher was posted on — rather than the statutory
  // month's, which for a straddling week is days after the money moved.
  if (lock && run.periodEnd <= lock) {
    throw new Error(
      `Payroll for ${run.cycle === 'monthly' ? run.month : run.periodLabel} falls in a locked period` +
      ` (books are locked up to ${lock}) — move the lock date first`
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

/** One employee's whole statutory month, summed across every run that paid into it. */
export interface MonthlyLine {
  employeeId: number
  employeeName: string
  /** Days paid across the month's cycles — 31 for a full month, however many weeks it took. */
  payableDays: number
  monthDays: number
  basic: number
  gross: number
  pfEmp: number
  pfEr: number
  epsEr: number
  esiEmp: number
  esiEr: number
  pt: number
  tds: number
  net: number
  /** How many pay runs made up the month. */
  runs: number
}

/**
 * What a statutory month paid each employee, across ALL of its runs.
 *
 * Every monthly return — the ECR, the ESI upload, the state PT challan — is filed for a month,
 * and a month is now four or five runs for anybody paid weekly. Reading one run would file a
 * quarter of the wages and a quarter of the contributions, which EPFO accepts silently and the
 * employee discovers in their passbook.
 */
export function monthlyLines(db: DB, month: string): MonthlyLine[] {
  const monthDays = daysInMonth(month)
  const rows = db
    .prepare(
      `SELECT pl.employee_id AS employeeId, e.name AS employeeName,
              SUM(pl.payable_days) AS payableDays, SUM(pl.basic) AS basic, SUM(pl.gross) AS gross,
              SUM(pl.pf_emp) AS pfEmp, SUM(pl.pf_er) AS pfEr, SUM(pl.eps_er) AS epsEr,
              SUM(pl.esi_emp) AS esiEmp, SUM(pl.esi_er) AS esiEr, SUM(pl.pt) AS pt,
              SUM(pl.tds) AS tds, SUM(pl.net) AS net, COUNT(*) AS runs
       FROM payroll_lines pl
       JOIN payroll_runs pr ON pr.id = pl.run_id
       JOIN employees e ON e.id = pl.employee_id
       WHERE pr.month = ?
       GROUP BY pl.employee_id
       ORDER BY e.name`
    )
    .all(month) as Omit<MonthlyLine, 'monthDays'>[]
  return rows.map((r) => ({ ...r, monthDays }))
}

/** Every PF member in the run's MONTH, whether or not they can be filed for — the validator
 *  needs both. */
function ecrCandidates(db: DB, runId: number): { month: string; candidates: EcrCandidate[] } {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const employees = new Map(listEmployees(db).map((e) => [e.id, e]))
  const candidates = monthlyLines(db, run.month)
    .filter((l) => employees.get(l.employeeId)?.pfEnabled)
    .map((l) => {
      const e = employees.get(l.employeeId)!
      return {
        row: {
          uan: e.uan ?? '',
          name: l.employeeName,
          gross: l.gross,
          // The month's PF wage, not a week's: the ₹15,000 ceiling is monthly, and the ECR's
          // wage column is what the ceiling was applied to.
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

/** The ESI return for the run's contribution MONTH — every run that fed it, summed. */
export function esiForRun(db: DB, runId: number): { filename: string; text: string } {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const employees = new Map(listEmployees(db).map((e) => [e.id, e]))
  const rows = monthlyLines(db, run.month)
    .filter((l) => {
      const e = employees.get(l.employeeId)
      return l.esiEmp > 0 && !!e?.esicNo
    })
    .map((l) => ({
      esicNo: employees.get(l.employeeId)!.esicNo!,
      name: l.employeeName,
      // Whole days: the portal's column is a count of days wages were paid for, and a month
      // split into weeks can leave half a day on the arithmetic.
      payableDays: Math.round(l.payableDays),
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

/** Professional tax collected per state for the run's MONTH (drives the state-wise PT challans).
 *  PT is a monthly slab, so the challan is the month's — never one week's share of it. */
export function ptSummaryForRun(db: DB, runId: number): PtSummaryRow[] {
  const run = getRun(db, runId)
  if (!run) throw new Error('Pay run not found')
  const stateById = new Map(listEmployees(db).map((e) => [e.id, e.ptState]))
  const byState = new Map<string, PtSummaryRow>()
  for (const l of monthlyLines(db, run.month)) {
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
      <div style="text-align:right"><b>PAYSLIP</b><div class="sub">${esc(run.periodLabel)}</div></div>
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
  // Weekly payslips are named by the week they pay; four files called payslip-2026-07 would
  // overwrite each other in the exports folder.
  const period = run.cycle === 'monthly' ? run.month : run.periodStart
  return writeExportPdf(slug, `payslip-${period}-${safeName}.pdf`, html, { pageSize: 'A4' })
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
  // Grouped by statutory month rather than by run: a weekly payroll posts four or five runs into
  // one month, and a point per run would draw four Januaries — each a quarter of the real cost.
  const byMonth = new Map<string, PayrollLine[]>()
  for (const run of listRuns(db)) {
    byMonth.set(run.month, [...(byMonth.get(run.month) ?? []), ...run.lines])
  }

  return [...byMonth.keys()]
    .sort((a, b) => a.localeCompare(b))
    .slice(-months)
    .map((month) => {
    const lines = byMonth.get(month) ?? []
    const sum = (pick: (l: (typeof lines)[number]) => number): number => lines.reduce((t, l) => t + pick(l), 0)

    const gross = sum((l) => l.gross)
    const employerContributions = sum((l) => l.pfEr + l.pfAdmin + l.edli + l.esiEr)
    const employeeDeductions = sum((l) => l.pfEmp + l.esiEmp + l.pt + l.otherDeductions)
    const employerCost = gross + employerContributions
    // People, not payslips: someone paid weekly has four lines in the month and is one head.
    const headcount = new Set(lines.map((l) => l.employeeId)).size

    const [y, m] = month.split('-')
    return {
      month,
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
    // ASCII and unambiguous: this string lands in a bank portal's narration column.
    run.cycle === 'monthly' ? `Salary ${run.month}` : `Salary ${run.periodStart} to ${run.periodEnd}`
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
  // Grouped by month: the certificate states what a MONTH paid and what was deducted from it, and
  // a weekly payroll puts four or five runs inside each of those months. One row per run would
  // print fifty-two lines and count fifty-two "months paid".
  const months = (
    db
      .prepare(
        `SELECT pr.month AS month, SUM(pl.gross) AS gross, SUM(pl.tds) AS tds, SUM(pl.pt) AS pt
         FROM payroll_lines pl JOIN payroll_runs pr ON pr.id = pl.run_id
         WHERE pl.employee_id = ? AND pr.month >= ? AND pr.month <= ?
         GROUP BY pr.month
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
      `Your payslip for ${run.periodLabel} is attached.`,
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
        ? `mailto:${e.email}?subject=${encodeURIComponent(`Payslip for ${run.periodLabel}`)}&body=${encodeURIComponent(body)}`
        : null
    })
  }
  return out
}
