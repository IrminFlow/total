import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { EmployeeInput } from '@shared/schemas'
import {
  attendanceForMonth,
  closeLoan,
  createLoan,
  dueRecoveries,
  listLoans,
  outstandingByEmployee,
  payableDaysFor,
  saveAttendance
} from './attendance'
import { commitRun, ecrCheck, ecrForRun, form16, getRun, previewRun, saveEmployee, settlement, tdsForMonth } from './payroll'

/**
 * Attendance, advances and what leaving costs.
 *
 * The properties that matter: an employee nobody entered attendance for is paid a full month
 * rather than nothing; an advance instalment is never prorated and never overshoots the balance;
 * recovering an advance settles an asset rather than paying somebody; and no function here posts
 * anything a human did not press save on.
 */
const emp = (over: Partial<EmployeeInput> = {}): EmployeeInput => ({
  name: 'Asha Kumar', code: null, designation: null, joined: '2018-04-01',
  pan: null, uan: null, esicNo: null,
  basic: 20_000_00, hra: 8_000_00, special: 4_000_00,
  pfEnabled: true, esiEnabled: true, ptEnabled: true, ptState: 'MH', active: true,
  ...over
})

describe('attendance register', () => {
  it('shows an employee nobody entered as a full month, not as absent', () => {
    const db = seededDb()
    saveEmployee(db, emp())
    const rows = attendanceForMonth(db, '2026-06')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ presentDays: 30, payableDays: 30, monthDays: 30, id: 0 })
  })

  it('pays for present days plus paid leave, but not loss of pay', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    const row = saveAttendance(db, { employeeId: e.id, month: '2026-06', presentDays: 20, paidLeaveDays: 4, lopDays: 6 })
    expect(row.payableDays).toBe(24)
    expect(payableDaysFor(db, '2026-06')).toEqual([{ employeeId: e.id, payableDays: 24 }])
  })

  it('refuses more days than the month has rather than trimming them', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    expect(() => saveAttendance(db, { employeeId: e.id, month: '2026-06', presentDays: 30, paidLeaveDays: 5, lopDays: 0 })).toThrow(
      '35 days recorded in a 30-day month'
    )
    expect(() => saveAttendance(db, { employeeId: e.id, month: '2026-06', presentDays: -1, paidLeaveDays: 0, lopDays: 0 })).toThrow(
      'negative'
    )
  })

  it('replaces a month rather than appending to it', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    saveAttendance(db, { employeeId: e.id, month: '2026-06', presentDays: 20, paidLeaveDays: 0, lopDays: 10 })
    saveAttendance(db, { employeeId: e.id, month: '2026-06', presentDays: 25, paidLeaveDays: 0, lopDays: 5 })
    const rows = attendanceForMonth(db, '2026-06')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.presentDays).toBe(25)
  })

  it('feeds the pay run, and an explicit override still wins', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    saveAttendance(db, { employeeId: e.id, month: '2026-06', presentDays: 15, paidLeaveDays: 0, lopDays: 15 })
    expect(previewRun(db, '2026-06', [])[0]!.payableDays).toBe(15)
    // The register is the record; the argument is the correction being tried on the screen.
    expect(previewRun(db, '2026-06', [{ employeeId: e.id, payableDays: 30 }])[0]!.payableDays).toBe(30)
  })
})

describe('salary advances', () => {
  it('refuses an advance that could never be recovered', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    expect(() => createLoan(db, { employeeId: e.id, grantedOn: '2026-06-01', principal: 0, instalment: 100 })).toThrow()
    expect(() => createLoan(db, { employeeId: e.id, grantedOn: '2026-06-01', principal: 10_000_00, instalment: 0 })).toThrow(
      'never be recovered'
    )
    expect(() =>
      createLoan(db, { employeeId: e.id, grantedOn: '2026-06-01', principal: 10_000_00, instalment: 20_000_00 })
    ).toThrow('more than the advance')
  })

  it('runs the balance down as pay runs recover it, and closes itself at zero', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    createLoan(db, { employeeId: e.id, grantedOn: '2026-05-01', principal: 10_000_00, instalment: 4_000_00 })

    commitRun(db, '2026-06', [])
    expect(listLoans(db)[0]!.outstanding).toBe(6_000_00)
    commitRun(db, '2026-07', [])
    expect(listLoans(db)[0]!.outstanding).toBe(2_000_00)

    // The last instalment is what is left, not the full amount.
    const last = dueRecoveries(db, '2026-08')
    expect(last[0]!.amount).toBe(2_000_00)
    expect(last[0]!.final).toBe(true)
    commitRun(db, '2026-08', [])
    expect(listLoans(db, { openOnly: true })).toEqual([])
    expect(listLoans(db)[0]!.closedAt).not.toBeNull()
  })

  it('deducts the instalment without prorating it for a part month', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    createLoan(db, { employeeId: e.id, grantedOn: '2026-05-01', principal: 10_000_00, instalment: 4_000_00 })
    saveAttendance(db, { employeeId: e.id, month: '2026-06', presentDays: 15, paidLeaveDays: 0, lopDays: 15 })
    const line = previewRun(db, '2026-06', [])[0]!
    expect(line.payableDays).toBe(15)
    expect(line.advanceRecovery).toBe(4_000_00)
  })

  it('never recovers more than is left to pay', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ basic: 5_000_00, hra: 0, special: 0, pfEnabled: false, esiEnabled: false, ptEnabled: false }))
    createLoan(db, { employeeId: e.id, grantedOn: '2026-05-01', principal: 50_000_00, instalment: 50_000_00 })
    const line = previewRun(db, '2026-06', [])[0]!
    expect(line.advanceRecovery).toBe(5_000_00)
    expect(line.net).toBe(0)
  })

  it('books the recovery against the advance rather than paying anybody', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    createLoan(db, { employeeId: e.id, grantedOn: '2026-05-01', principal: 10_000_00, instalment: 4_000_00 })
    const run = commitRun(db, '2026-06', [])
    const lines = db
      .prepare(
        `SELECT l.name, vl.dr_cr AS drCr, vl.amount FROM voucher_lines vl
         JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
      )
      .all(run.voucherId) as { name: string; drCr: string; amount: number }[]
    const advance = lines.find((l) => l.name === 'Salary Advances')!
    expect(advance).toMatchObject({ drCr: 'cr', amount: 4_000_00 })
    // Salaries Payable is short by exactly what the advance took.
    const payable = lines.find((l) => l.name === 'Salaries Payable')!
    expect(payable.amount).toBe(getRun(db, run.id)!.lines.reduce((s, l) => s + l.net, 0))
    const dr = lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
  })

  it('cannot double-recover a month, however often the run is previewed', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    createLoan(db, { employeeId: e.id, grantedOn: '2026-05-01', principal: 10_000_00, instalment: 4_000_00 })
    previewRun(db, '2026-06', [])
    previewRun(db, '2026-06', [])
    commitRun(db, '2026-06', [])
    expect(listLoans(db)[0]!.recovered).toBe(4_000_00)
    expect(dueRecoveries(db, '2026-06')).toEqual([])
  })

  it('stops recovering a written-off advance but keeps what was already taken', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    const loan = createLoan(db, { employeeId: e.id, grantedOn: '2026-05-01', principal: 10_000_00, instalment: 4_000_00 })
    commitRun(db, '2026-06', [])
    closeLoan(db, loan.id, '2026-07-01')
    expect(dueRecoveries(db, '2026-07')).toEqual([])
    expect(listLoans(db)[0]!.recovered).toBe(4_000_00)
    expect(outstandingByEmployee(db).get(e.id)).toBeUndefined()
  })
})

describe('cost-centre allocation of salary', () => {
  it('splits the salary expense by whoever carries the employee', () => {
    const db = seededDb()
    const sales = db.prepare("INSERT INTO cost_centres (name) VALUES ('Sales') RETURNING id").get() as { id: number }
    const a = saveEmployee(db, emp({ name: 'Allocated' }))
    saveEmployee(db, emp({ name: 'Unallocated' }))
    db.prepare('UPDATE employees SET cost_centre_id = ? WHERE id = ?').run(sales.id, a.id)

    const run = commitRun(db, '2026-06', [])
    const allocations = db
      .prepare(
        `SELECT ca.cost_centre_id AS centre, ca.amount FROM voucher_line_cost_allocations ca
         JOIN voucher_lines vl ON vl.id = ca.voucher_line_id WHERE vl.voucher_id = ?`
      )
      .all(run.voucherId) as { centre: number; amount: number }[]
    const allocatedLine = getRun(db, run.id)!.lines.find((l) => l.employeeName === 'Allocated')!
    expect(allocations).toEqual([{ centre: sales.id, amount: allocatedLine.gross }])
  })

  it('posts exactly what it always did when nobody uses cost centres', () => {
    const db = seededDb()
    saveEmployee(db, emp())
    const run = commitRun(db, '2026-06', [])
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM voucher_line_cost_allocations ca
         JOIN voucher_lines vl ON vl.id = ca.voucher_line_id WHERE vl.voucher_id = ?`
      )
      .get(run.voucherId) as { n: number }
    expect(n.n).toBe(0)
  })
})

describe('ECR pre-flight', () => {
  it('names the PF members the file cannot carry instead of dropping them in silence', () => {
    const db = seededDb()
    saveEmployee(db, emp({ name: 'Has UAN', uan: '100200300400' }))
    saveEmployee(db, emp({ name: 'No UAN' }))
    const run = commitRun(db, '2026-06', [])
    const check = ecrCheck(db, run.id)
    expect(check.memberCount).toBe(1)
    expect(check.skipped).toEqual([{ name: 'No UAN', reason: 'No UAN on the employee record' }])
    expect(check.uploadable).toBe(true)
    expect(ecrForRun(db, run.id).skipped).toEqual(check.skipped)
  })

  it('refuses to write a file EPFO would reject', () => {
    const db = seededDb()
    saveEmployee(db, emp({ name: 'Bad UAN', uan: '123' }))
    const run = commitRun(db, '2026-06', [])
    const check = ecrCheck(db, run.id)
    expect(check.uploadable).toBe(false)
    expect(() => ecrForRun(db, run.id)).toThrow('EPFO will reject')
  })
})

describe('full and final settlement', () => {
  it('computes on the contracted salary, not the final part-month', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ joined: '2018-04-01' }))
    const s = settlement(db, { employeeId: e.id, lastDay: '2026-06-20', leaveBalanceDays: 12 })
    expect(s.result.gratuity.eligible).toBe(true)
    expect(s.result.gratuity.countedYears).toBe(8)
    // 15/26 × full basic × 8, never 15/26 × twenty-days-of-basic × 8.
    expect(s.result.gratuity.amount).toBe(Math.floor((20_000_00 * 15 * 8) / 26))
  })

  it('recovers an outstanding advance in full', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    createLoan(db, { employeeId: e.id, grantedOn: '2026-01-01', principal: 10_000_00, instalment: 2_000_00 })
    const s = settlement(db, { employeeId: e.id, lastDay: '2026-06-20', leaveBalanceDays: 0 })
    const recovery = s.result.lines.find((l) => l.label === 'Loans and advances outstanding')!
    expect(recovery.amount).toBe(10_000_00)
  })

  it('produces a balanced draft and posts nothing', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp())
    const before = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    const s = settlement(db, { employeeId: e.id, lastDay: '2026-06-20', leaveBalanceDays: 12, noticeShortfallDays: 10 })
    const dr = s.draft!.lines.filter((l) => l.drCr === 'dr').reduce((sum, l) => sum + l.amount, 0)
    const cr = s.draft!.lines.filter((l) => l.drCr === 'cr').reduce((sum, l) => sum + l.amount, 0)
    expect(dr).toBe(cr)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(before)
  })

  it('balances even when the leaver ends up owing the company', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ joined: '2025-01-01' }))
    createLoan(db, { employeeId: e.id, grantedOn: '2026-01-01', principal: 5_00_000_00, instalment: 10_000_00 })
    const s = settlement(db, { employeeId: e.id, lastDay: '2026-06-20', leaveBalanceDays: 0 })
    expect(s.result.net).toBeLessThan(0)
    expect(s.result.notes.some((n) => n.includes('owes the company'))).toBe(true)
    const dr = s.draft!.lines.filter((l) => l.drCr === 'dr').reduce((sum, l) => sum + l.amount, 0)
    const cr = s.draft!.lines.filter((l) => l.drCr === 'cr').reduce((sum, l) => sum + l.amount, 0)
    expect(dr).toBe(cr)
    expect(s.draft!.lines.some((l) => l.ledgerName === 'Employee Recoverable' && l.drCr === 'dr')).toBe(true)
  })

  it('refuses an employee with no joining date rather than guessing one', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ joined: null }))
    expect(() => settlement(db, { employeeId: e.id, lastDay: '2026-06-20', leaveBalanceDays: 0 })).toThrow('no joining date')
  })
})

describe('TDS on salary and Form 16', () => {
  const taxed = (over: Partial<EmployeeInput> = {}): EmployeeInput =>
    emp({ basic: 1_00_000_00, hra: 40_000_00, special: 20_000_00, pfEnabled: false, esiEnabled: false, ...over })

  it('deducts nothing from a salary the rebate covers', () => {
    const db = seededDb()
    saveEmployee(db, emp({ basic: 20_000_00, hra: 8_000_00, special: 4_000_00 }))
    // ₹32,000 a month is ₹3,84,000 a year — well under the rebate.
    expect(previewRun(db, '2026-06', [])[0]!.tds).toBe(0)
  })

  it("spreads the year's tax over the months that are left", () => {
    const db = seededDb()
    const e = saveEmployee(db, taxed())
    const april = tdsForMonth(db, '2026-04').get(e.id)!
    expect(april.monthsRemaining).toBe(12)
    expect(april.annualGross).toBe(1_60_000_00 * 12)
    expect(april.thisMonth).toBe(Math.ceil(april.computation.totalTax / 12))
    // Later in the year, the same tax over fewer months is a bigger instalment.
    expect(tdsForMonth(db, '2027-01').get(e.id)!.monthsRemaining).toBe(3)
  })

  it('catches up after months where nothing was deducted', () => {
    const db = seededDb()
    const e = saveEmployee(db, taxed())
    const total = tdsForMonth(db, '2026-04').get(e.id)!.computation.totalTax
    // Six runs posted, then check what October has to carry.
    for (const m of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) commitRun(db, m, [])
    const oct = tdsForMonth(db, '2026-10').get(e.id)!
    expect(oct.deductedSoFar).toBeGreaterThan(0)
    expect(oct.thisMonth).toBe(Math.ceil((total - oct.deductedSoFar) / 6))
  })

  it('honours an opening TDS figure from a previous system', () => {
    const db = seededDb()
    const plain = saveEmployee(db, taxed())
    const carried = saveEmployee(db, taxed({ name: 'Carried Over', openingTds: 50_000_00 }))
    const rows = tdsForMonth(db, '2026-04')
    expect(rows.get(carried.id)!.deductedSoFar).toBe(50_000_00)
    expect(rows.get(carried.id)!.thisMonth).toBeLessThan(rows.get(plain.id)!.thisMonth)
  })

  it('taxes the old regime differently, and only there allows the declaration', () => {
    const db = seededDb()
    const newReg = saveEmployee(db, taxed({ name: 'New Regime', declaredDeductions: 1_50_000_00 }))
    const oldReg = saveEmployee(db, taxed({ name: 'Old Regime', taxRegime: 'old', declaredDeductions: 1_50_000_00 }))
    const rows = tdsForMonth(db, '2026-04')
    expect(rows.get(newReg.id)!.computation.chapterVIA).toBe(0)
    expect(rows.get(oldReg.id)!.computation.chapterVIA).toBe(1_50_000_00)
    expect(rows.get(newReg.id)!.regime).toBe('new')
  })

  it('books the deduction to a payable and keeps the journal balanced', () => {
    const db = seededDb()
    saveEmployee(db, taxed())
    const run = commitRun(db, '2026-06', [])
    const lines = db
      .prepare(
        `SELECT l.name, vl.dr_cr AS drCr, vl.amount FROM voucher_lines vl
         JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
      )
      .all(run.voucherId) as { name: string; drCr: string; amount: number }[]
    const tdsLine = lines.find((l) => l.name === 'TDS on Salary Payable')!
    expect(tdsLine.drCr).toBe('cr')
    expect(tdsLine.amount).toBe(getRun(db, run.id)!.lines[0]!.tds)
    const dr = lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
  })

  it('never lets TDS and an advance together push the net below zero', () => {
    const db = seededDb()
    const e = saveEmployee(db, taxed())
    createLoan(db, { employeeId: e.id, grantedOn: '2026-05-01', principal: 5_00_000_00, instalment: 5_00_000_00 })
    const line = previewRun(db, '2026-06', [])[0]!
    expect(line.net).toBeGreaterThanOrEqual(0)
    expect(line.gross - line.pfEmp - line.esiEmp - line.pt - line.otherDeductions - line.tds - line.advanceRecovery).toBe(line.net)
  })

  it('builds Form 16 from the runs actually posted, not from the projection', () => {
    const db = seededDb()
    const e = saveEmployee(db, taxed({ pan: 'ABCPK1234F' }))
    for (const m of ['2026-04', '2026-05', '2026-06']) commitRun(db, m, [])
    const f = form16(db, e.id, 2026)
    expect(f.monthsPaid).toBe(3)
    expect(f.fyLabel).toBe('FY 2026-27')
    expect(f.ayLabel).toBe('AY 2027-28')
    expect(f.grossSalary).toBe(1_60_000_00 * 3)
    expect(f.tdsDeducted).toBe(f.months.reduce((s, m) => s + m.tds, 0))
    // Three months of salary is a smaller year than the projection assumed, so the certificate
    // shows tax already over-deducted rather than pretending the projection was the year.
    expect(f.shortfall).toBe(f.computation.totalTax - f.tdsDeducted)
  })

  it('shows the working line by line, and always states the balance', () => {
    const db = seededDb()
    const e = saveEmployee(db, taxed())
    commitRun(db, '2026-04', [])
    const f = form16(db, e.id, 2026)
    const labels = f.rows.map((r) => r.label)
    expect(labels[0]).toBe('Gross salary under section 17(1)')
    expect(labels).toContain('Total taxable income')
    expect(labels).toContain('Total tax payable')
    expect(labels.some((l) => l.startsWith('Balance tax payable') || l.startsWith('Excess tax deducted'))).toBe(true)
  })

  it('refuses a year with no runs rather than issuing an empty certificate', () => {
    const db = seededDb()
    const e = saveEmployee(db, taxed())
    expect(() => form16(db, e.id, 2026)).toThrow('No pay runs')
  })
})
