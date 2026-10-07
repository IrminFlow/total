// WP 3.7 — payroll statutory against a real (in-memory) SQLite: migration 029, the sample run's
// postings (PF / ESI / PT / salary TDS, balanced), payables by tag, salary TDS on the TDS screen
// and in Form 24Q (not 26Q), dues and payments, ESI contribution-period stickiness, the
// September-2026 ceiling change, exports and Form 16 data.
import { describe, expect, it } from 'vitest'
import { freshPartialDb, seededDb, TEST_INFO } from '../db/testdb'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import type { DB } from '../db/connection'
import type { EmployeeInputPayload } from '@shared/schemas'
import { computePt } from '@shared/payrollStatutory'
import { commitRun, deleteRun, ecrForRun, esiForRun, getRun, previewRun, ptCsvForRun, saveEmployee, actualWorkings } from './payroll'
import {
  form16Data, form24qCsv, form24qData, getDeclarations, listStatutoryPayments, listStatutoryRates, recordStatutoryPayment, saveStatutoryRate,
  setDeclarations, statutoryDues, statutoryRatesForMonth, statutoryRatesOn
} from './payrollStatutory'
import { form26qData, tdsDeducted, tdsLedgerSummary } from './tdsWorkbench'
import { getVoucher, saveVoucher } from './vouchers'
import { voucherToPayload } from '@shared/voucherEdit'

const R = (rupees: number): number => Math.round(rupees * 100)

const emp = (over: Partial<EmployeeInputPayload> = {}): EmployeeInputPayload => ({
  name: 'Anil Mehta', code: 'E1', designation: 'Manager', joined: null, pan: 'ABCPM1234K', uan: '100100100100', esicNo: null,
  basic: R(75_000), hra: R(30_000), special: R(45_000),
  pfEnabled: true, esiEnabled: true, ptEnabled: true, ptState: 'MH', active: true,
  ...over
})
const lowPaid = (over: Partial<EmployeeInputPayload> = {}): EmployeeInputPayload => emp({
  name: 'Bina Rao', code: 'E2', designation: 'Clerk', pan: 'ABCPR5678L', uan: '100100100200', esicNo: '3100123456',
  basic: R(12_000), hra: R(4_000), special: R(2_000), ...over
})

const linesOf = (db: DB, voucherId: number): Map<string, { drCr: string; amount: number }> =>
  new Map((db.prepare(
    `SELECT l.name, vl.dr_cr AS drCr, vl.amount FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
  ).all(voucherId) as { name: string; drCr: string; amount: number }[]).map(({ name, ...l }) => [name, l]))

const balanceByTag = (db: DB, kind: string): number =>
  (db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'cr' THEN vl.amount ELSE -vl.amount END), 0) AS b
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id JOIN ledgers l ON l.id = vl.ledger_id
      WHERE l.statutory_kind = ? AND v.deleted_at IS NULL`
  ).get(kind) as { b: number }).b

function bank(db: DB): number {
  const g = db.prepare("SELECT id FROM groups WHERE name = 'Bank Accounts'").get() as { id: number }
  return Number(db.prepare("INSERT INTO ledgers (name, group_id, is_system) VALUES ('HDFC Current', ?, 0)").run(g.id).lastInsertRowid)
}

describe('migration 029', () => {
  it('is the 29th migration — appended after 027 (TCS) and 028 (GST expansion) — and the last', () => {
    const at = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE statutory_rates'))
    expect(at + 1).toBe(29)
    expect(at).toBeGreaterThan(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE gst_ims_actions')))
    expect(at).toBe(MIGRATIONS.length - 1)
  })

  it('seeds cited, effective-dated statutory rates, section 192 and the Code wage rule', () => {
    const db = seededDb()
    const rates = listStatutoryRates(db)
    expect(rates.every((r) => r.source.includes('accessed 2026-10-07'))).toBe(true)
    expect(new Set(rates.filter((r) => r.kind === 'pt').map((r) => r.state))).toEqual(new Set(['MH', 'KA', 'WB', 'TN', 'GJ', 'TS', 'AP', 'MP']))
    // PF ceiling ₹15,000 → ₹25,000 on 17-9-2026 (S.O. 5109(E)); Code wages from 21-11-2025.
    expect(statutoryRatesOn(db, '2026-09-16').pf.ceilingPaise).toBe(R(15_000))
    expect(statutoryRatesOn(db, '2026-09-17').pf.ceilingPaise).toBe(R(25_000))
    expect(statutoryRatesOn(db, '2025-10-31').ssWagesCapBp).toBeNull()
    expect(statutoryRatesOn(db, '2025-11-30').ssWagesCapBp).toBe(5000)
    expect(statutoryRatesForMonth(db, '2026-09').pf.ceilingPaise).toBe(R(19_667))
    const s192 = db.prepare("SELECT code, legacy_code AS l, new_reference AS n FROM tds_sections WHERE code = '192'").get()
    expect(s192).toEqual({ code: '192', l: '192', n: '392' })
    // West Bengal's slab changes on 1-10-2026.
    const wb = (d: string) => statutoryRatesOn(db, d).ptByState.get('WB')!
    expect(computePt(wb('2026-09-30'), R(18_000), '2026-09', null)).toBe(R(130))
    expect(computePt(wb('2026-10-31'), R(18_000), '2026-10', null)).toBe(0)
    // Seeded MH rows: the fractional-rupee gap between printed bounds falls in the higher slab.
    const mh = statutoryRatesOn(db, '2026-07-31').ptByState.get('MH')!
    expect(computePt(mh, R(7_500.5), '2026-07', 'male')).toBe(R(175))
    expect(computePt(mh, R(20_000), '2026-07', 'female')).toBe(0)
    expect(computePt(mh, R(30_000), '2027-02', null)).toBe(R(300))
  })

  it('backfills payroll lines and tags the payable ledgers the app always created', () => {
    const before029 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE statutory_rates'))
    const db = freshPartialDb(before029)
    const g = (name: string) => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number } | undefined)?.id
    // Seed just enough for the legacy rows: groups come from seedCompany normally — stage by SQL.
    db.exec(`INSERT INTO groups (name, nature, affects_gross_profit) VALUES ('Provisions', 'liability', 0)`)
    db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('PF Payable', ?)").run(g('Provisions'))
    db.prepare("INSERT INTO employees (name, basic, pt_state) VALUES ('Old Hand', 2000000, 'KA')").run()
    db.exec(`INSERT INTO payroll_runs (month) VALUES ('2025-06')`)
    db.exec(`INSERT INTO payroll_lines (run_id, employee_id, payable_days, month_days, basic, hra, special, gross, pf_emp, pf_er, esi_emp, esi_er, pt, net, eps_er, edli)
             VALUES (1, 1, 30, 30, 2000000, 0, 0, 2000000, 180000, 180000, 0, 0, 20000, 1800000, 124950, 7500)`)
    migrate(db)
    expect(db.prepare("SELECT statutory_kind AS k FROM ledgers WHERE name = 'PF Payable'").get()).toEqual({ k: 'pf' })
    expect(db.prepare('SELECT epf_wage, eps_wage, edli_wage, esi_covered, pt_state FROM payroll_lines').get())
      .toEqual({ epf_wage: 1500000, eps_wage: 1500000, edli_wage: 1500000, esi_covered: 0, pt_state: 'KA' })
  })
})

describe('a pay run with PF, ESI, PT and salary TDS', () => {
  function setup() {
    const db = seededDb()
    const a = saveEmployee(db, emp())
    const b = saveEmployee(db, lowPaid())
    const run = commitRun(db, '2026-07', [])
    return { db, a, b, run }
  }

  it('posts the sample run balanced, with employer shares and every payable credited by tag', () => {
    const { db, run } = setup()
    const l = linesOf(db, run.voucherId!)
    // Anil: Code wages 1,20,000 (HRA excluded, < 50%); PF capped at ₹15,000 → 1,800 / 1,800 (EPS 1,250),
    //   EDLI 75, admin 75; ESI not covered; PT MH 200; TDS: 9 months × 1.5 lakh − 75,000 = 12.75 lakh →
    //   ₹71,250 + cess 2,850 = 74,100 ÷ 9 months left = ₹8,233.
    // Bina: Code wages 14,000 → PF 1,680 / 1,680 (EPS 1,166), EDLI 70, admin 70; ESI 105 / 455; PT 200.
    // Admin 145 < the ₹500 minimum → top-up 355.
    expect(l.get('Salaries')).toEqual({ drCr: 'dr', amount: R(1_68_000) })
    expect(l.get('Employer PF Contribution')).toEqual({ drCr: 'dr', amount: R(3_480) })
    expect(l.get('PF Admin & EDLI Charges')).toEqual({ drCr: 'dr', amount: R(645) })
    expect(l.get('Employer ESI Contribution')).toEqual({ drCr: 'dr', amount: R(455) })
    expect(l.get('PF Payable')).toEqual({ drCr: 'cr', amount: R(7_605) })
    expect(l.get('ESI Payable')).toEqual({ drCr: 'cr', amount: R(560) })
    expect(l.get('Professional Tax Payable')).toEqual({ drCr: 'cr', amount: R(400) })
    expect(l.get('TDS Payable 192')).toEqual({ drCr: 'cr', amount: R(8_233) })
    expect(l.get('Salaries Payable')).toEqual({ drCr: 'cr', amount: R(1_55_782) })
    const dr = [...l.values()].filter((x) => x.drCr === 'dr').reduce((s, x) => s + x.amount, 0)
    const cr = [...l.values()].filter((x) => x.drCr === 'cr').reduce((s, x) => s + x.amount, 0)
    expect(dr).toBe(cr)
    expect(run.pfAdminTopUp).toBe(R(355))
    expect(balanceByTag(db, 'pf')).toBe(R(7_605))
    expect(balanceByTag(db, 'esi')).toBe(R(560))
    expect(balanceByTag(db, 'pt')).toBe(R(400))
    expect(balanceByTag(db, 'salary')).toBe(R(1_55_782))
    const anil = run.lines.find((x) => x.employeeName === 'Anil Mehta')!
    expect(anil).toMatchObject({ tds: R(8_233), epfWage: R(15_000), epsWage: R(15_000), esiCovered: false })
    expect(anil.tdsWorkings).toMatchObject({ regime: 'new', act: '2025', annualTax: R(74_100), monthsRemaining: 9 })
    const bina = run.lines.find((x) => x.employeeName === 'Bina Rao')!
    expect(bina).toMatchObject({ pfEmp: R(1_680), epsEr: R(1_166), esiEmp: R(105), esiEr: R(455), esiCovered: true, pt: R(200), tds: 0 })
  })

  it('records salary TDS in tds_entries under section 192: Deducted tab and 24Q, never 26Q', () => {
    const { db, a } = setup()
    const deducted = tdsDeducted(db, '2026-07-01', '2026-07-31')
    expect(deducted).toHaveLength(1)
    expect(deducted[0]).toMatchObject({ partyName: 'Anil Mehta', sectionCode: '192', pan: 'ABCPM1234K', tdsPaise: R(8_233), basePaise: R(1_50_000) })
    expect(form26qData(db, 2026, 2).deductees).toHaveLength(0)
    const q = form24qData(db, 2026, 2, (id) => actualWorkings(db, id, 2026))
    expect(q.layout).toBe('form138')
    expect(q.deductees[0]).toMatchObject({ employeeId: a.id, sectionCode: '1002', amountPaise: R(1_50_000), tdsPaise: R(8_233), challanSerial: null })
    expect(q.salaries).toHaveLength(0) // annexure II only in Q4
    const summary = tdsLedgerSummary(db, 2026, 2).find((r) => r.sectionCode === '192')!
    expect(summary).toMatchObject({ deductedPaise: R(8_233), entriesTdsPaise: R(8_233), deductees: 1 })
  })

  it('lists dues with due dates, and a payment (PF) / a challan payment (TDS) clears them', () => {
    const { db } = setup()
    const dues = statutoryDues(db, 2026, '2026-08-10')
    const by = (k: string) => dues.find((d) => d.key === k)!
    expect(by('pf:2026-07')).toMatchObject({ payablePaise: R(7_605), employeePaise: R(3_480), dueDate: '2026-08-15', status: 'unpaid' })
    expect(by('esi:2026-07')).toMatchObject({ payablePaise: R(560), dueDate: '2026-08-15' })
    expect(by('pt:2026-07:MH')).toMatchObject({ payablePaise: R(400), employees: 2 })
    expect(by('tds:2026-07')).toMatchObject({ payablePaise: R(8_233), dueDate: '2026-08-07', status: 'overdue' })
    const hdfc = bank(db)
    recordStatutoryPayment(db, { kind: 'pf', period: '2026-07', state: null, amountPaise: R(7_605), paidOn: '2026-08-12', bankLedgerId: hdfc, reference: 'TRRN 123', bsrCode: null, challanNo: null })
    const tds = recordStatutoryPayment(db, { kind: 'tds', period: '2026-07', state: null, amountPaise: R(8_233), paidOn: '2026-08-06', bankLedgerId: hdfc, reference: null, bsrCode: '0510308', challanNo: '00042' })
    expect(tds.tdsChallanId).not.toBeNull()
    const after = statutoryDues(db, 2026, '2026-08-20')
    expect(after.find((d) => d.key === 'pf:2026-07')).toMatchObject({ paidPaise: R(7_605), outstandingPaise: 0, status: 'paid' })
    expect(after.find((d) => d.key === 'tds:2026-07')!.status).toBe('paid')
    expect(after.find((d) => d.key === 'esi:2026-07')!.status).toBe('overdue')
    expect(balanceByTag(db, 'pf')).toBe(0)
    expect(listStatutoryPayments(db, 2026)).toHaveLength(2)
    // The TDS challan was auto-allocated: 24Q shows it.
    expect(form24qData(db, 2026, 2, () => null).deductees[0]).toMatchObject({ challanSerial: 1, bsrCode: '0510308', challanNo: '00042' })
  })

  it('refuses a TDS payment voucher to a non-bank ledger and mismatched challan details', () => {
    const { db } = setup()
    const salaries = (db.prepare("SELECT id FROM ledgers WHERE name = 'Salaries'").get() as { id: number }).id
    expect(() => recordStatutoryPayment(db, { kind: 'pf', period: '2026-07', state: null, amountPaise: 100, paidOn: '2026-08-12', bankLedgerId: salaries, reference: null, bsrCode: null, challanNo: null }))
      .toThrow(/bank or cash/)
    expect(() => recordStatutoryPayment(db, { kind: 'pt', period: '2026-07', state: null, amountPaise: 100, paidOn: '2026-08-12', bankLedgerId: bank(db), reference: null, bsrCode: null, challanNo: null }))
      .toThrow(/state/)
  })

  it('a pay run journal cannot be edited in the voucher editor; deleting the run drops its 24Q entries', () => {
    const { db, run } = setup()
    const v = getVoucher(db, run.voucherId!)!
    expect(() => saveVoucher(db, voucherToPayload(v), run.voucherId!)).toThrow(/pay run/)
    deleteRun(db, run.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM tds_entries').get()).toEqual({ n: 0 })
    expect(statutoryDues(db, 2026, '2026-08-10')).toHaveLength(0)
  })

  it('exports: ECR line per member, ESI upload, PT return per state', () => {
    const { db, run } = setup()
    const ecr = ecrForRun(db, run.id).text.split('\n')
    expect(ecr).toContain('100100100100#~#ANIL MEHTA#~#150000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0')
    expect(ecr).toContain('100100100200#~#BINA RAO#~#18000#~#14000#~#14000#~#14000#~#1680#~#1166#~#514#~#0#~#0')
    expect(esiForRun(db, run.id).text.split('\n')[1]).toBe('3100123456,Bina Rao,31,14000,0,')
    const pt = ptCsvForRun(db, run.id, 'MH')
    expect(pt.filename).toBe('pt-return-MH-2026-07.csv')
    expect(pt.text).toContain('Anil Mehta,150000,200')
    expect(pt.text).toContain('200,2,400')
  })
})

describe('ESI contribution-period stickiness', () => {
  it('stays covered to the end of Apr–Sep after crossing ₹21,000; out from October', () => {
    const db = seededDb()
    const b = saveEmployee(db, lowPaid())
    commitRun(db, '2026-07', [])
    saveEmployee(db, lowPaid({ basic: R(20_000), special: R(5_000) }), b.id) // Code wages 25,000
    const aug = commitRun(db, '2026-08', [])
    expect(aug.lines[0]).toMatchObject({ esiCovered: true, esiEmp: R(188), esiEr: R(813) }) // 0.75% / 3.25% of 25,000, rounded up
    commitRun(db, '2026-09', [])
    const oct = commitRun(db, '2026-10', [])
    expect(oct.lines[0]).toMatchObject({ esiCovered: false, esiEmp: 0, esiEr: 0 })
  })
})

describe('the September-2026 ceiling change', () => {
  it('day-weights the EPF / EPS / EDLI ceiling in September, ₹25,000 from October', () => {
    const db = seededDb()
    saveEmployee(db, emp())
    const sep = previewRun(db, '2026-09', [])[0]!
    expect(sep).toMatchObject({ epfWage: R(19_667), pfEmp: R(2_360), epsEr: R(1_638) })
    const oct = previewRun(db, '2026-10', [])[0]!
    expect(oct).toMatchObject({ epfWage: R(25_000), pfEmp: R(3_000), epsEr: R(2_083), edli: R(125) })
  })
})

describe('declarations, regimes and Form 16', () => {
  it('old-regime declarations cut the projected TDS; Form 16 / 130 data carries the actual workings', () => {
    const db = seededDb()
    const a = saveEmployee(db, emp({ taxRegime: 'old', metro: true }))
    const before = previewRun(db, '2026-04', [])[0]!.tds
    setDeclarations(db, { employeeId: a.id, fyStartYear: 2026, rows: [
      { section: '80C', amountPaise: R(1_50_000), proofReceived: true }, { section: 'RENT', amountPaise: R(4_80_000), proofReceived: false }
    ] })
    expect(getDeclarations(db, a.id, 2026).map((d) => d.section).sort()).toEqual(['80C', 'RENT'])
    const after = previewRun(db, '2026-04', [])[0]!
    expect(after.tds).toBeLessThan(before)
    expect(after.tdsWorkings).toMatchObject({ regime: 'old' })
    commitRun(db, '2026-04', [])
    const f16 = form16Data(db, TEST_INFO, 2026, (id) => actualWorkings(db, id, 2026))
    expect(f16).toMatchObject({ act: '2025', formName: 'Form No. 130', yearLabel: '2026-27' })
    expect(f16.employees[0]!.workings.hraExemption).toBeGreaterThan(0)
    expect(f16.employees[0]!.quarters[0]!.tdsPaise).toBe(after.tds)
    // Q4 of the year: annexure II rows for every employee paid in the year.
    const q4 = form24qData(db, 2026, 4, (id) => actualWorkings(db, id, 2026))
    expect(q4.salaries.map((s) => s.employeeName)).toEqual(['Anil Mehta'])
    expect(form24qCsv(q4)).toContain('Annexure II')
  })

  it('a user-edited rate row takes effect (rates are data)', () => {
    const db = seededDb()
    saveEmployee(db, emp())
    const epf = listStatutoryRates(db).find((r) => r.kind === 'epf' && r.effectiveTo == null)!
    saveStatutoryRate(db, { ...epf, rateBp: 1000 }, epf.id) // the 10% rate for notified establishments
    expect(previewRun(db, '2026-10', [])[0]!.pfEmp).toBe(R(2_500))
    expect(getRun(db, 1)).toBeNull()
  })
})
