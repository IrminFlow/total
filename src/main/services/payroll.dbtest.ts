import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import type { EmployeeInput } from '@shared/schemas'
import { setLockDate } from './vouchers'
import {
  saveEmployee, listEmployees, listPayHeads, savePayHead, deletePayHead,
  getEmployeeHeads, setEmployeeHeads, previewRun, commitRun, getRun, deleteRun,
  ecrForRun, esiForRun, ptSummaryForRun
} from './payroll'
import { lockPayrollRun, payrollPreflight, payrollTieOut } from './payrollOperations'

const emp = (over: Partial<EmployeeInput> = {}): EmployeeInput => ({
  name: 'Asha Kumar', code: null, designation: null, joined: null,
  pan: null, uan: null, esicNo: null,
  bankAccount: null, bankIfsc: null, department: null, exitDate: null,
  basic: 20_000_00, hra: 8_000_00, special: 4_000_00,
  pfEnabled: true, esiEnabled: true, ptEnabled: true, ptState: 'MH', active: true,
  ...over
})

describe('pay heads', () => {
  it('migration seeds Basic/HRA/Special; saveEmployee syncs their per-employee overrides', () => {
    const db = seededDb()
    expect(listPayHeads(db).map((h) => h.name)).toEqual(['Basic', 'HRA', 'Special Allowance'])

    const e = saveEmployee(db, emp())
    const heads = getEmployeeHeads(db, e.id)
    expect(heads.map((h) => [h.name, h.overrideValue])).toEqual([
      ['Basic', 20_000_00], ['HRA', 8_000_00], ['Special Allowance', 4_000_00]
    ])

    // Editing the employee's salary keeps the head overrides in lockstep.
    saveEmployee(db, emp({ basic: 25_000_00 }), e.id)
    expect(getEmployeeHeads(db, e.id).find((h) => h.name === 'Basic')!.overrideValue).toBe(25_000_00)
  })

  it('savePayHead creates/updates, deletePayHead refuses while assigned', () => {
    const db = seededDb()
    const head = savePayHead(db, { name: 'Conveyance', kind: 'earning', calc: 'flat', value: 1_600_00, active: true })
    expect(head.value).toBe(1_600_00)

    const updated = savePayHead(db, { name: 'Conveyance', kind: 'earning', calc: 'flat', value: 2_000_00, active: true }, head.id)
    expect(updated.value).toBe(2_000_00)

    const e = saveEmployee(db, emp())
    const assigned = getEmployeeHeads(db, e.id).map((h) => ({ payHeadId: h.payHeadId, overrideValue: h.overrideValue }))
    setEmployeeHeads(db, { employeeId: e.id, heads: [...assigned, { payHeadId: head.id, overrideValue: null }] })

    expect(() => deletePayHead(db, head.id)).toThrow(/assigned/)
    setEmployeeHeads(db, { employeeId: e.id, heads: assigned })
    deletePayHead(db, head.id)
    expect(listPayHeads(db).find((h) => h.id === head.id)).toBeUndefined()
  })

  it('previewRun consumes custom heads and per-employee overrides', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ basic: 10_000_00, hra: 0, special: 0 }))
    const conveyance = savePayHead(db, { name: 'Conveyance', kind: 'earning', calc: 'flat', value: 1_600_00, active: true })
    const canteen = savePayHead(db, { name: 'Canteen', kind: 'deduction', calc: 'flat', value: 500_00, active: true })
    const assigned = getEmployeeHeads(db, e.id).map((h) => ({ payHeadId: h.payHeadId, overrideValue: h.overrideValue }))
    setEmployeeHeads(db, {
      employeeId: e.id,
      heads: [...assigned, { payHeadId: conveyance.id, overrideValue: null }, { payHeadId: canteen.id, overrideValue: 300_00 }]
    })

    const [line] = previewRun(db, '2026-07', [])
    expect(line!.otherEarnings).toBe(1_600_00)
    expect(line!.otherDeductions).toBe(300_00) // override wins over the head default
    expect(line!.gross).toBe(11_600_00)
    expect(line!.headAmounts.map((h) => h.name)).toEqual(['Basic', 'HRA', 'Special Allowance', 'Conveyance', 'Canteen'])
  })

  it('previewRun honors the employee PT state', () => {
    const db = seededDb()
    saveEmployee(db, emp({ name: 'KA Emp', basic: 15_000_00, hra: 5_000_00, special: 0, ptState: 'KA' }))
    const [line] = previewRun(db, '2026-07', [])
    expect(line!.pt).toBe(0) // 20,000 gross is below Karnataka's ₹25,000 threshold
  })
})

const voucherCount = (db: DB): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n

describe('commitRun', () => {
  it('books employer PF split charges and custom deductions in a balanced voucher', () => {
    const db = seededDb()
    saveEmployee(db, emp())
    const run = commitRun(db, '2026-07', [])
    expect(run.voucherId).not.toBeNull()

    const lines = db
      .prepare(
        `SELECT l.name, vl.dr_cr AS drCr, vl.amount FROM voucher_lines vl
         JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ? ORDER BY vl.line_order`
      )
      .all(run.voucherId) as { name: string; drCr: 'dr' | 'cr'; amount: number }[]

    const byName = new Map(lines.map((l) => [l.name, l]))
    expect(byName.get('Salaries')).toMatchObject({ drCr: 'dr', amount: 32_000_00 })
    expect(byName.get('Employer PF Contribution')).toMatchObject({ drCr: 'dr', amount: 1_800_00 })
    // admin 0.5% + EDLI 0.5% on the capped ₹15,000 wage = ₹75 + ₹75
    expect(byName.get('PF Admin & EDLI Charges')).toMatchObject({ drCr: 'dr', amount: 150_00 })
    expect(byName.get('PF Payable')).toMatchObject({ drCr: 'cr', amount: 1_800_00 + 1_800_00 + 150_00 })
    const dr = lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)

    // Stored line carries the statutory split + head breakdown
    const stored = getRun(db, run.id)!.lines[0]!
    expect(stored.epsEr).toBe(1_249_50)
    expect(stored.pfAdmin).toBe(75_00)
    expect(stored.edli).toBe(75_00)
    expect(stored.headAmounts.length).toBeGreaterThan(0)
  })

  it('is atomic: a failure while writing run rows also rolls back the salary voucher', () => {
    const db = seededDb()
    saveEmployee(db, emp())
    const before = voucherCount(db)
    db.exec(`CREATE TRIGGER fail_payroll_line BEFORE INSERT ON payroll_lines
             BEGIN SELECT RAISE(ABORT, 'boom'); END;`)
    expect(() => commitRun(db, '2026-07', [])).toThrow('boom')
    db.exec('DROP TRIGGER fail_payroll_line')

    expect(voucherCount(db)).toBe(before) // no orphaned voucher
    expect(db.prepare('SELECT COUNT(*) AS n FROM payroll_runs').get()).toEqual({ n: 0 })

    // and the month can still be posted afterwards
    const run = commitRun(db, '2026-07', [])
    expect(run.month).toBe('2026-07')
  })

  it('deleteRun in a locked period fails with a payroll-specific message and leaves the run intact', () => {
    const db = seededDb()
    saveEmployee(db, emp())
    const run = commitRun(db, '2026-07', [])
    setLockDate(db, '2026-08-31')
    expect(() => deleteRun(db, run.id)).toThrow(/Payroll for 2026-07 falls in a locked period/)
    expect(getRun(db, run.id)).not.toBeNull()
    setLockDate(db, null)
    deleteRun(db, run.id)
    expect(getRun(db, run.id)).toBeNull()
  })
})

describe('payroll controls', () => {
  it('preflight blocks unreviewed attendance and reports payment and statutory gaps', () => {
    const db = seededDb()
    const employee = saveEmployee(db, emp())

    const blocked = payrollPreflight(db, '2026-07', [])
    expect(blocked.canPost).toBe(false)
    expect(blocked.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ employeeId: employee.id, category: 'attendance', severity: 'error' }),
      expect.objectContaining({ employeeId: employee.id, category: 'bank', severity: 'warning' }),
      expect.objectContaining({ employeeId: employee.id, category: 'statutory', severity: 'warning' })
    ]))

    const reviewed = payrollPreflight(db, '2026-07', [{ employeeId: employee.id, payableDays: 31 }])
    expect(reviewed.canPost).toBe(true)
    expect(reviewed.netPay).toBeGreaterThan(0)
    expect(reviewed.issues.some((issue) => issue.category === 'attendance')).toBe(false)
  })

  it('preflight blocks employees without a salary structure', () => {
    const db = seededDb()
    const employee = saveEmployee(db, emp({ basic: 0, hra: 0, special: 0 }))
    db.prepare('DELETE FROM employee_pay_heads WHERE employee_id = ?').run(employee.id)

    const result = payrollPreflight(db, '2026-07', [{ employeeId: employee.id, payableDays: 31 }])
    expect(result.canPost).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      employeeId: employee.id,
      category: 'salary',
      severity: 'error'
    }))
  })

  it('ties every payroll control account to the posting voucher', () => {
    const db = seededDb()
    saveEmployee(db, emp())
    const run = commitRun(db, '2026-07', [])

    const tieOut = payrollTieOut(db, run.id)
    expect(tieOut.reconciled).toBe(true)
    expect(tieOut.totalDifference).toBe(0)
    expect(tieOut.rows.every((row) => row.expected === row.posted)).toBe(true)
  })

  it('locks a reconciled run and prevents deletion', () => {
    const db = seededDb()
    saveEmployee(db, emp())
    const run = commitRun(db, '2026-07', [])

    const locked = lockPayrollRun(db, run.id, 'Owner')
    expect(locked?.lockedAt).toBeTruthy()
    expect(locked?.lockedBy).toBe('Owner')
    expect(() => deleteRun(db, run.id)).toThrow(/locked/i)
    expect(getRun(db, run.id)).not.toBeNull()
  })
})

describe('statutory exports', () => {
  it('ecrForRun emits #~# lines for PF members with UANs and errors when there are none', () => {
    const db = seededDb()
    saveEmployee(db, emp({ uan: '100123456789' }))
    saveEmployee(db, emp({ name: 'No Uan', uan: null }))
    const run = commitRun(db, '2026-07', [])

    const { filename, text } = ecrForRun(db, run.id)
    expect(filename).toBe('pf-ecr-2026-07.txt')
    const lines = text.split('\n')
    expect(lines).toHaveLength(1) // only the UAN-carrying employee
    expect(lines[0]).toBe('100123456789#~#ASHA KUMAR#~#32000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0')

    const db2 = seededDb()
    saveEmployee(db2, emp({ uan: null }))
    const run2 = commitRun(db2, '2026-07', [])
    expect(() => ecrForRun(db2, run2.id)).toThrow(/UAN/)
  })

  it('esiForRun lists only contributing insured persons with ESIC numbers', () => {
    const db = seededDb()
    // Gross 18,000 ≤ 21,000 → ESI applies
    saveEmployee(db, emp({ basic: 12_000_00, hra: 4_000_00, special: 2_000_00, esicNo: '1234567890' }))
    // Gross above the limit → no contribution even with a number
    saveEmployee(db, emp({ name: 'High Earner', esicNo: '9999999999' }))
    const run = commitRun(db, '2026-07', [])

    const { filename, text } = esiForRun(db, run.id)
    expect(filename).toBe('esi-upload-2026-07.csv')
    const lines = text.split('\n')
    expect(lines[0]).toContain('IP Number')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('1234567890,Asha Kumar,31,18000,0,')
  })

  it('ptSummaryForRun groups PT by the employees\' states', () => {
    const db = seededDb()
    saveEmployee(db, emp({ name: 'MH One' }))
    saveEmployee(db, emp({ name: 'KA One', basic: 15_000_00, hra: 5_000_00, special: 0, ptState: 'KA' }))
    const run = commitRun(db, '2026-07', [])

    const rows = ptSummaryForRun(db, run.id)
    expect(rows).toEqual([
      { state: 'KA', employees: 1, gross: 20_000_00, pt: 0 },
      { state: 'MH', employees: 1, gross: 32_000_00, pt: 200_00 }
    ])
  })
})

describe('employees regression', () => {
  it('listEmployees surfaces ptState with the migration default', () => {
    const db = seededDb()
    db.prepare("INSERT INTO employees (name, basic) VALUES ('Raw Row', 1000000)").run()
    const e = listEmployees(db).find((x) => x.name === 'Raw Row')!
    expect(e.ptState).toBe('MH')
  })
})
