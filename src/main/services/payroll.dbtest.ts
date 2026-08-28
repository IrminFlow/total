import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import type { EmployeeInput } from '@shared/schemas'
import type { CyclePeriod } from '@shared/payCycle'
import { setLockDate } from './vouchers'
import { createLoan, listLoans, saveAttendance } from './attendance'
import {
  saveEmployee, listEmployees, listPayHeads, savePayHead, deletePayHead,
  getEmployeeHeads, setEmployeeHeads, previewRun, commitRun, getRun, deleteRun,
  ecrForRun, esiForRun, ptSummaryForRun, form16, payrollTrend, listRuns,
  previewPeriod, commitPeriod, cyclePeriods, periodFor, monthlyLines,
  cycleAnchor, setCycleAnchor, DEFAULT_CYCLE_ANCHOR, tdsForMonth
} from './payroll'

const emp = (over: Partial<EmployeeInput> = {}): EmployeeInput => ({
  name: 'Asha Kumar', code: null, designation: null, joined: null,
  pan: null, uan: null, esicNo: null,
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

// ---------- pay cycles (roadmap #179) ----------

/**
 * June 2026 is four clean pay weeks on the default Monday boundary — 1–7, 8–14, 15–21, 22–28 —
 * with 29–30 June belonging to July's first week, which is where they are actually paid.
 */
const JUNE = '2026-06'

const weeks = (db: DB): CyclePeriod[] => cyclePeriods(db, 'weekly', JUNE)

/** Every statutory deduction the month's runs actually took off one employee. */
const monthTotals = (db: DB, employeeId: number): Record<string, number> => {
  const l = monthlyLines(db, JUNE).find((x) => x.employeeId === employeeId)!
  return { gross: l.gross, pfEmp: l.pfEmp, pfEr: l.pfEr, epsEr: l.epsEr, esiEmp: l.esiEmp, esiEr: l.esiEr, pt: l.pt, tds: l.tds }
}

describe('pay cycles', () => {
  it('lays June out as four Monday weeks, and pays 29–30 June in July', () => {
    const db = seededDb()
    expect(cycleAnchor(db)).toBe(DEFAULT_CYCLE_ANCHOR)
    expect(weeks(db).map((w) => [w.from, w.to])).toEqual([
      ['2026-06-01', '2026-06-07'],
      ['2026-06-08', '2026-06-14'],
      ['2026-06-15', '2026-06-21'],
      ['2026-06-22', '2026-06-28']
    ])
    // The week that straddles the month end accrues to July — the month its last day is in, and
    // the month whose ECR it has to appear in.
    expect(periodFor(db, 'weekly', '2026-06-30').statutoryMonth).toBe('2026-07')
  })

  it('keeps the monthly employees out of the weekly run and the weekly employees out of the monthly one', () => {
    const db = seededDb()
    const office = saveEmployee(db, emp({ name: 'Office Monthly' }))
    const floor = saveEmployee(db, emp({ name: 'Floor Weekly', payCycle: 'weekly' }))

    expect(previewRun(db, JUNE, []).map((l) => l.employeeId)).toEqual([office.id])
    expect(previewPeriod(db, weeks(db)[0]!, []).map((l) => l.employeeId)).toEqual([floor.id])
  })

  it('refuses to move the pay-week boundary once weeks are posted against it', () => {
    const db = seededDb()
    saveEmployee(db, emp({ payCycle: 'weekly' }))
    expect(setCycleAnchor(db, '2024-01-06')).toBe('2024-01-06')
    commitPeriod(db, cyclePeriods(db, 'weekly', JUNE)[0]!, [])
    expect(() => setCycleAnchor(db, '2024-01-01')).toThrow(/already posted/)
    expect(cycleAnchor(db)).toBe('2024-01-06')
  })

  it('posts a week that pays exactly a quarter of the month, dated on the week it closes', () => {
    const db = seededDb()
    saveEmployee(db, emp({ payCycle: 'weekly' })) // 20,000 + 8,000 + 4,000 = 32,000 a month
    const run = commitPeriod(db, weeks(db)[0]!, [])

    expect(run).toMatchObject({ month: JUNE, cycle: 'weekly', periodStart: '2026-06-01', periodEnd: '2026-06-07' })
    expect(run.periodLabel).toBe('01 Jun – 07 Jun 2026')
    expect(run.lines[0]).toMatchObject({ payableDays: 7.5, monthDays: 30, gross: 8_000_00 })
    const voucher = db.prepare('SELECT date, narration FROM vouchers WHERE id = ?').get(run.voucherId) as {
      date: string; narration: string
    }
    expect(voucher.date).toBe('2026-06-07')
    expect(voucher.narration).toContain('01 Jun – 07 Jun 2026')
  })

  it('refuses to post the same week twice, and posts the next one happily', () => {
    const db = seededDb()
    saveEmployee(db, emp({ payCycle: 'weekly' }))
    commitPeriod(db, weeks(db)[0]!, [])
    expect(() => commitPeriod(db, weeks(db)[0]!, [])).toThrow(/already posted/)
    expect(commitPeriod(db, weeks(db)[1]!, []).periodStart).toBe('2026-06-08')
  })
})

describe('the statutory month is the unit, whatever the pay cycle', () => {
  /** The same two people, the same wages, one month — paid four times or once. */
  const staff = (payCycle: 'weekly' | 'monthly'): EmployeeInput[] => [
    // Gross 18,000 — inside ESI's ₹21,000 monthly limit, over MH's PT threshold.
    emp({ name: 'Insured', basic: 12_000_00, hra: 4_000_00, special: 2_000_00, esicNo: '1234567890', uan: '100123456789', payCycle }),
    // Gross 2,50,000 — no ESI, and enough salary that section 192 actually bites (a ₹12 lakh
    // year is inside the new regime's rebate and would leave nothing to compare).
    emp({ name: 'Taxed', basic: 150_000_00, hra: 50_000_00, special: 50_000_00, pan: 'ABCDE1234F', payCycle })
  ]

  it('deducts across four weekly runs EXACTLY what one monthly run would have deducted', () => {
    const weekly = seededDb()
    const ids = staff('weekly').map((e) => saveEmployee(weekly, e).id)
    for (const w of weeks(weekly)) commitPeriod(weekly, w, [])
    expect(weekly.prepare('SELECT COUNT(*) AS n FROM payroll_runs').get()).toEqual({ n: 4 })

    const monthly = seededDb()
    const monthlyIds = staff('monthly').map((e) => saveEmployee(monthly, e).id)
    commitRun(monthly, JUNE, [])

    for (let i = 0; i < ids.length; i++) {
      // PF, ESI, professional tax and TDS: to the paisa, not "about the same".
      expect(monthTotals(weekly, ids[i]!), `employee ${i}`).toEqual(monthTotals(monthly, monthlyIds[i]!))
    }
    // …including the ones the ₹15,000 PF ceiling and the ₹21,000 ESI limit decide, which are the
    // ones a week-by-week computation gets wrong.
    expect(monthTotals(weekly, ids[0]!).esiEmp).toBeGreaterThan(0)
    expect(monthTotals(weekly, ids[1]!).esiEmp).toBe(0)
    expect(monthTotals(weekly, ids[1]!).pfEmp).toBe(1_800_00) // capped wage, not 12% of 60,000
    expect(monthTotals(weekly, ids[1]!).tds).toBeGreaterThan(0)
    expect(monthTotals(weekly, ids[0]!).pt).toBe(200_00)
  })

  it('holds for a fortnightly cycle too, whatever the month’s fortnights happen to be', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ payCycle: 'fortnightly' }))
    const periods = cyclePeriods(db, 'fortnightly', JUNE)
    expect(periods.length).toBeGreaterThan(0)
    for (const p of periods) commitPeriod(db, p, [])

    const monthly = seededDb()
    const m = saveEmployee(monthly, emp())
    commitRun(monthly, JUNE, [])
    expect(monthTotals(db, e.id).pfEmp).toBe(monthTotals(monthly, m.id).pfEmp)
    expect(monthTotals(db, e.id).pt).toBe(monthTotals(monthly, m.id).pt)
  })

  it('spreads each month-defined deduction evenly and lands the remainder on the last week', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ payCycle: 'weekly' }))
    const runs = weeks(db).map((w) => commitPeriod(db, w, []))
    const pf = runs.map((r) => r.lines.find((l) => l.employeeId === e.id)!.pfEmp)
    expect(pf).toEqual([450_00, 450_00, 450_00, 450_00])
    expect(pf.reduce((s, p) => s + p, 0)).toBe(1_800_00)

    // The EPS split does not divide by four; the month still adds up to the paisa.
    const eps = runs.map((r) => r.lines.find((l) => l.employeeId === e.id)!.epsEr)
    expect(eps.reduce((s, p) => s + p, 0)).toBe(1_249_50)
  })

  it('trues up the rest of the month when a late attendance entry changes it', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ payCycle: 'weekly' }))
    const all = weeks(db)
    // Weeks 1 and 2 are paid believing the month is full.
    commitPeriod(db, all[0]!, [])
    commitPeriod(db, all[1]!, [])
    expect(monthTotals(db, e.id).pfEmp).toBe(900_00)

    // Then most of the month turns out to have been unpaid leave: five days, not thirty.
    saveAttendance(db, { employeeId: e.id, month: JUNE, presentDays: 5, paidLeaveDays: 0, lopDays: 25 })
    commitPeriod(db, all[2]!, [])
    commitPeriod(db, all[3]!, [])

    // 12% of five days of a ₹20,000 basic — the month lands on its real figure, to the paisa.
    expect(monthTotals(db, e.id).pfEmp).toBe(400_00)
    // What the first two weeks over-deducted comes back rather than standing: the true-up goes
    // negative, and that refund is what makes the month add up.
    const taken = listRuns(db).map((r) => r.lines.find((l) => l.employeeId === e.id)!.pfEmp)
    expect(Math.min(...taken)).toBeLessThan(0)
    expect(taken.reduce((s, p) => s + p, 0)).toBe(400_00)
  })
})

describe('a week somebody was not there for', () => {
  const joiner = (db: DB): { id: number } => saveEmployee(db, emp({ name: 'Mid Joiner', joined: '2026-06-10', payCycle: 'weekly' }))

  it('pays a mid-cycle joiner from the day they joined, not from the Monday', () => {
    const db = seededDb()
    const e = joiner(db)
    // Week 2 runs 8–14 June; they joined on the 10th, so five of its seven days are theirs.
    // June's four pay weeks cover 28 days, so a full week is worth 7.5 of the month's 30 days —
    // five sevenths of that is 5.5, not 5. (29–30 June are paid in July's first week.)
    const line = previewPeriod(db, weeks(db)[1]!, [])[0]!
    expect(line.employeeId).toBe(e.id)
    expect(line.payableDays).toBe(5.5)
    expect(line.gross).toBe(5_866_67)
  })

  it('pays ZERO for the week before they joined, and posts that run without a voucher', () => {
    const db = seededDb()
    joiner(db)
    const first = previewPeriod(db, weeks(db)[0]!, [])[0]!
    expect(first).toMatchObject({ payableDays: 0, gross: 0, pfEmp: 0, esiEmp: 0, pt: 0, net: 0 })

    // Nothing happened, so nothing is booked — an empty journal cannot balance and would claim
    // that it did.
    const run = commitPeriod(db, weeks(db)[0]!, [])
    expect(run.voucherId).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
    expect(getRun(db, run.id)!.lines).toHaveLength(1)
  })

  it('computes the month’s statutory on the days they were actually on the payroll', () => {
    const db = seededDb()
    const e = joiner(db)
    for (const w of weeks(db)) commitPeriod(db, w, [])
    // 0 + 5.5 + 7.5 + 7.5 = 20.5 days of a 30-day month, and the month's PF is 12% of that much
    // basic — computed once, on the month, and shared out over the weeks that paid wages.
    const totals = monthTotals(db, e.id)
    expect(totals.gross).toBe(21_866_67)
    expect(totals.pfEmp).toBe(1_640_00)
  })

  it('refuses a period that is not one of the month’s pay cycles', () => {
    const db = seededDb()
    saveEmployee(db, emp({ payCycle: 'weekly' }))
    const stray = periodFor(db, 'weekly', '2026-09-15')
    expect(() => previewPeriod(db, { ...stray, statutoryMonth: JUNE }, [])).toThrow(/pay periods/)
  })
})

describe('an employee who leaves during a pay period', () => {
  it('persists the last working day and rejects a date before joining', () => {
    const db = seededDb()
    const saved = saveEmployee(db, {
      ...emp({ joined: '2024-01-15' }),
      leftOn: '2026-06-10'
    } as EmployeeInput & { leftOn: string })
    expect((saved as typeof saved & { leftOn: string | null }).leftOn).toBe('2026-06-10')

    expect(() => saveEmployee(db, {
      ...emp({ joined: '2026-06-11' }),
      leftOn: '2026-06-10'
    } as EmployeeInput & { leftOn: string })).toThrow(/last working day.*joining date/i)
  })

  it('clips weekly earnings and statutory deductions to the last working day', () => {
    const db = seededDb()
    const e = saveEmployee(db, {
      ...emp({ payCycle: 'weekly' }),
      leftOn: '2026-06-10'
    } as EmployeeInput & { leftOn: string })

    const first = commitPeriod(db, weeks(db)[0]!, []).lines.find((l) => l.employeeId === e.id)!
    const final = commitPeriod(db, weeks(db)[1]!, []).lines.find((l) => l.employeeId === e.id)!
    expect(first.payableDays).toBe(7.5)
    // 8–10 June are three of the period's seven days: 3/7 of its 7.5-day month share, rounded
    // to the attendance register's half-day granularity.
    expect(final.payableDays).toBe(3)
    expect(final.gross).toBe(3_200_00)

    // The final paid cycle carries the complete month-to-date statutory amount. Later cycles no
    // longer contain this employee and therefore cannot withhold deductions after employment.
    expect(final.pfEmp).toBe(840_00 - first.pfEmp)
    expect(previewPeriod(db, weeks(db)[2]!, [])).toEqual([])
  })

  it('caps a monthly run at employment days without double-prorating attendance', () => {
    const db = seededDb()
    const e = saveEmployee(db, {
      ...emp(),
      leftOn: '2026-06-20'
    } as EmployeeInput & { leftOn: string })
    const fullAttendance = previewRun(db, JUNE, []).find((l) => l.employeeId === e.id)!
    expect(fullAttendance.payableDays).toBe(20)
    expect(fullAttendance.gross).toBe(21_333_33)

    // Fifteen payable attendance days are already below the twenty employed calendar days, so
    // the leaving-date cap must not multiply them by 20/30 a second time.
    const attendance = previewRun(db, JUNE, [{ employeeId: e.id, payableDays: 15 }]).find((l) => l.employeeId === e.id)!
    expect(attendance.payableDays).toBe(15)
    expect(attendance.gross).toBe(16_000_00)
  })

  it('still includes an inactive leaver in their final period, then excludes later periods', () => {
    const db = seededDb()
    const e = saveEmployee(db, {
      ...emp({ payCycle: 'weekly', active: false }),
      leftOn: '2026-06-10'
    } as EmployeeInput & { leftOn: string })
    expect(previewPeriod(db, weeks(db)[1]!, []).map((l) => l.employeeId)).toContain(e.id)
    expect(previewPeriod(db, weeks(db)[2]!, []).map((l) => l.employeeId)).not.toContain(e.id)
  })

  it('projects section 192 only through the leaving date and withholds it in the final period', () => {
    const db = seededDb()
    const e = saveEmployee(db, {
      ...emp({
        basic: 600_000_00, hra: 200_000_00, special: 200_000_00,
        payCycle: 'weekly', active: false
      }),
      leftOn: '2026-06-10'
    } as EmployeeInput & { leftOn: string })

    const tax = tdsForMonth(db, JUNE).get(e.id)!
    expect(tax.monthsRemaining).toBe(1)
    expect(tax.annualGross).toBeLessThan(1_000_000_00 * 3)
    expect(tax.thisMonth).toBeGreaterThan(0)
    expect(previewPeriod(db, weeks(db)[1]!, []).find((l) => l.employeeId === e.id)!.tds).toBe(tax.thisMonth)
    expect(tdsForMonth(db, '2026-07').has(e.id)).toBe(false)
  })
})

describe('monthly returns across a month’s cycles', () => {
  it('files ONE ECR line per member for the whole month, identical to the monthly run’s', () => {
    const db = seededDb()
    saveEmployee(db, emp({ uan: '100123456789', payCycle: 'weekly' }))
    const runs = weeks(db).map((w) => commitPeriod(db, w, []))

    const { filename, text } = ecrForRun(db, runs[3]!.id)
    expect(filename).toBe('pf-ecr-2026-06.txt')
    expect(text.split('\n')).toHaveLength(1)
    // Byte for byte what one monthly run for the same wages produces (see the monthly test above).
    expect(text).toBe('100123456789#~#ASHA KUMAR#~#32000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0')

    // Asked of the FIRST week it says the same thing: the return is the month's, not the run's.
    expect(ecrForRun(db, runs[0]!.id).text).toBe(text)
  })

  it('files the month’s ESI days and wages, not one week’s', () => {
    const db = seededDb()
    saveEmployee(db, emp({ basic: 12_000_00, hra: 4_000_00, special: 2_000_00, esicNo: '1234567890', payCycle: 'weekly' }))
    for (const w of weeks(db)) commitPeriod(db, w, [])
    const { text } = esiForRun(db, listRuns(db)[0]!.id)
    expect(text.split('\n')[1]).toBe('1234567890,Asha Kumar,30,18000,0,')
  })

  it('bills the month’s professional tax once, not once per week', () => {
    const db = seededDb()
    saveEmployee(db, emp({ payCycle: 'weekly' }))
    for (const w of weeks(db)) commitPeriod(db, w, [])
    expect(ptSummaryForRun(db, listRuns(db)[0]!.id)).toEqual([
      { state: 'MH', employees: 1, gross: 32_000_00, pt: 200_00 }
    ])
  })

  it('counts a weekly month as one month on the trend and one head, not four', () => {
    const db = seededDb()
    saveEmployee(db, emp({ payCycle: 'weekly' }))
    for (const w of weeks(db)) commitPeriod(db, w, [])
    const trend = payrollTrend(db)
    expect(trend.map((p) => p.month)).toEqual([JUNE])
    expect(trend[0]).toMatchObject({ headcount: 1, gross: 32_000_00 })
  })

  it('certifies a weekly year as twelve months on Form 16, not fifty-two', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ basic: 60_000_00, hra: 20_000_00, special: 20_000_00, payCycle: 'weekly' }))
    for (const w of weeks(db)) commitPeriod(db, w, [])
    const f = form16(db, e.id, 2026)
    expect(f.monthsPaid).toBe(1)
    expect(f.months.map((m) => m.month)).toEqual([JUNE])
    expect(f.grossSalary).toBe(monthTotals(db, e.id).gross)
    expect(f.tdsDeducted).toBe(monthTotals(db, e.id).tds)
  })
})

describe('an advance in a month that is paid weekly', () => {
  it('recovers one instalment, in the last week, exactly once', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ payCycle: 'weekly' }))
    createLoan(db, { employeeId: e.id, grantedOn: '2026-05-01', principal: 12_000_00, instalment: 3_000_00 })

    const runs = weeks(db).map((w) => commitPeriod(db, w, []))
    expect(runs.map((r) => r.lines[0]!.advanceRecovery)).toEqual([0, 0, 0, 3_000_00])

    // `loan_recoveries` is UNIQUE(loan_id, month); one row, against the run that took it.
    const rows = db.prepare('SELECT run_id, month, amount FROM loan_recoveries').all() as {
      run_id: number; month: string; amount: number
    }[]
    expect(rows).toEqual([{ run_id: runs[3]!.id, month: JUNE, amount: 3_000_00 }])
    expect(listLoans(db, { employeeId: e.id })[0]!.outstanding).toBe(9_000_00)
  })

  it('does not re-recover it when a later month’s weeks are paid', () => {
    const db = seededDb()
    const e = saveEmployee(db, emp({ payCycle: 'weekly' }))
    createLoan(db, { employeeId: e.id, grantedOn: '2026-05-01', principal: 12_000_00, instalment: 3_000_00 })
    for (const w of weeks(db)) commitPeriod(db, w, [])
    for (const w of cyclePeriods(db, 'weekly', '2026-07')) commitPeriod(db, w, [])

    const rows = db.prepare('SELECT month, amount FROM loan_recoveries ORDER BY month').all()
    expect(rows).toEqual([{ month: '2026-06', amount: 3_000_00 }, { month: '2026-07', amount: 3_000_00 }])
    expect(listLoans(db, { employeeId: e.id })[0]!.outstanding).toBe(6_000_00)
  })
})
