// WP 4.3 — payables: migration 034, supplier MSME fields on the ledger, payment planning (totals
// equal Outstandings), payment runs (balanced vouchers, bill-wise allocation, TDS on payment,
// audited, all-or-nothing), the MSME report (s.15 / s.16 / s.43B(h) / Form 1), the year-end
// warning and supplier reconciliation.
import { describe, it, expect } from 'vitest'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { freshPartialDb, seededDb, TEST_INFO } from '../db/testdb'
import { seedCompany } from '../db/seed'
import { createLedger, getLedger, updateLedger } from './masters'
import { saveVoucher, getVoucher, deleteVoucher } from './vouchers'
import { outstandings, openBills } from './analysis'
import {
  createPaymentRun, deleteBankRate, getPaymentRun, listBankRates, listPaymentRuns, msmeDueSummary, msmeForm1Csv, msmeReport,
  msmeYearEndWarning, payablesPlan, paymentRunCsv, previewPaymentRun, saveBankRate, supplierRecon, supplierStatement
} from './payables'
import { closePreview } from './yearEnd'

type DB = ReturnType<typeof seededDb>

const M034 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE msme_bank_rates'))

const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const vt = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id

function setup(): { db: DB; micro: number; medium: number; plain: number; bank: number; expense: number } {
  const db = seededDb()
  const creditors = groupId(db, 'Sundry Creditors')
  const micro = createLedger(db, {
    name: 'Micro Castings', groupId: creditors, pan: 'AAAPM1234C', creditDays: 60,
    msmeRegistered: true, msmeCategory: 'micro', udyamNo: 'udyam-mh-33-0012345', agreedCreditDays: null
  }).id
  const medium = createLedger(db, { name: 'Medium Mills', groupId: creditors, creditDays: 30, msmeRegistered: true, msmeCategory: 'medium', udyamNo: 'UDYAM-GJ-01-0000007' }).id
  const plain = createLedger(db, {
    name: 'Plain Supplies', groupId: creditors, creditDays: 10, earlyPaymentDiscountBp: 200, earlyPaymentDiscountDays: 10
  }).id
  const bank = createLedger(db, { name: 'HDFC Current', groupId: groupId(db, 'Bank Accounts'), openingBalance: 100_000_000 }).id
  const expense = createLedger(db, { name: 'Raw Material Purchases', groupId: groupId(db, 'Purchase Accounts') }).id
  return { db, micro, medium, plain, bank, expense }
}

function bill(db: DB, party: number, expense: number, date: string, name: string, amount: number, ref: string | null = null): number {
  return saveVoucher(db, {
    voucherTypeId: vt(db, 'purchase'), date, partyLedgerId: party, reference: ref,
    lines: [{ ledgerId: expense, drCr: 'dr', amount }, { ledgerId: party, drCr: 'cr', amount }],
    billRefs: [{ kind: 'new', name, amount, dueDate: null }]
  }).id
}

function pay(db: DB, party: number, bank: number, date: string, amount: number, against?: string): number {
  return saveVoucher(db, {
    voucherTypeId: vt(db, 'payment'), date, partyLedgerId: party,
    lines: [{ ledgerId: party, drCr: 'dr', amount }, { ledgerId: bank, drCr: 'cr', amount }],
    billRefs: against ? [{ kind: 'against', name: against, amount, dueDate: null }] : []
  }).id
}

const balanced = (id: number, db: DB): boolean => {
  const v = getVoucher(db, id)!
  const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  return dr === cr && dr > 0
}

describe('migration 034 — payables', () => {
  it('appends after 031 (number 034 once 032 / 033 land)', () => {
    expect(M034).toBeGreaterThanOrEqual(31)
    expect(M034).toBe(MIGRATIONS.length - 1 - MIGRATIONS.slice(M034 + 1).length)
  })
  it('adds the supplier columns with defaults that keep existing ledgers as they were', () => {
    const db = freshPartialDb(M034)
    seedCompany(db, TEST_INFO)
    const id = Number(db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('Old Supplier', ?)").run(groupId(db, 'Sundry Creditors')).lastInsertRowid)
    migrate(db)
    expect(db.prepare('SELECT msme_registered, udyam_no, msme_category, agreed_credit_days, early_payment_discount_bp, early_payment_discount_days FROM ledgers WHERE id = ?').get(id)).toEqual({
      msme_registered: 0, udyam_no: null, msme_category: null, agreed_credit_days: null, early_payment_discount_bp: null, early_payment_discount_days: null
    })
    expect(() => db.prepare("UPDATE ledgers SET msme_category = 'large' WHERE id = ?").run(id)).toThrow(/CHECK/)
    expect(() => db.prepare('UPDATE ledgers SET agreed_credit_days = 400 WHERE id = ?').run(id)).toThrow(/CHECK/)
  })
  it('seeds the RBI bank rate table, each row with its source (unverified rows say so)', () => {
    const db = seededDb()
    const rates = listBankRates(db)
    expect(rates.at(-1)).toMatchObject({ fromDate: '2026-10-07', rateBp: 575 })
    expect(rates.find((r) => r.fromDate === '2025-12-05')?.rateBp).toBe(550)
    for (const r of rates) expect(r.source.length).toBeGreaterThan(10)
    expect(rates.filter((r) => /UNVERIFIED/.test(r.source)).length).toBeGreaterThan(0)
  })
  it('creates the payment-run tables', () => {
    const db = seededDb()
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['payment_runs', 'payment_run_vouchers', 'msme_bank_rates']))
  })
})

describe('supplier MSME fields on the ledger', () => {
  it('round-trip, normalise the Udyam number, and are kept when an update leaves them out', () => {
    const { db, micro } = setup()
    expect(getLedger(db, micro)).toMatchObject({ msmeRegistered: true, msmeCategory: 'micro', udyamNo: 'UDYAM-MH-33-0012345', agreedCreditDays: null })
    const l = getLedger(db, micro)!
    updateLedger(db, micro, { name: l.name, groupId: l.groupId, creditDays: 60 })
    expect(getLedger(db, micro)).toMatchObject({ msmeRegistered: true, msmeCategory: 'micro', udyamNo: 'UDYAM-MH-33-0012345' })
    updateLedger(db, micro, { name: l.name, groupId: l.groupId, agreedCreditDays: 30 })
    expect(getLedger(db, micro)!.agreedCreditDays).toBe(30)
    const audit = db.prepare("SELECT after_json FROM audit_log WHERE entity = 'ledger' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(micro) as { after_json: string }
    expect(JSON.parse(audit.after_json)).toMatchObject({ agreedCreditDays: 30, msmeCategory: 'micro' })
  })
  it('rejects a malformed Udyam number', () => {
    const { db } = setup()
    expect(() => createLedger(db, { name: 'Bad Udyam', groupId: groupId(db, 'Sundry Creditors'), udyamNo: 'UDYAM-1' })).toThrow(/Udyam/)
  })
})

describe('payment planning', () => {
  it('lists every open payable bill; the total equals Outstandings payables', () => {
    const { db, micro, medium, plain, expense } = setup()
    bill(db, micro, expense, '2026-09-01', 'MC-1', 1_000_000)
    bill(db, micro, expense, '2026-10-01', 'MC-2', 500_000)
    bill(db, medium, expense, '2026-09-20', 'MM-1', 300_000)
    bill(db, plain, expense, '2026-10-02', 'PS-1', 200_000)
    const plan = payablesPlan(db, '2026-10-07')
    const out = outstandings(db, 'payable', '2026-10-07')
    expect(plan.totals.pending).toBe(out.reduce((s, p) => s + p.pending, 0))
    expect(plan.rows).toHaveLength(4)
    expect(plan.totals.overdue + plan.totals.this_week + plan.totals.next_week + plan.totals.later).toBe(plan.totals.pending)
  })
  it('a micro supplier with no written agreement must be paid within 15 days, even on 60-day terms', () => {
    const { db, micro, medium, plain, expense } = setup()
    bill(db, micro, expense, '2026-09-01', 'MC-1', 1_000_000)
    bill(db, micro, expense, '2026-10-01', 'MC-2', 500_000)
    bill(db, medium, expense, '2026-09-20', 'MM-1', 300_000)
    bill(db, plain, expense, '2026-10-02', 'PS-1', 200_000)
    const rows = payablesPlan(db, '2026-10-07').rows
    const mc1 = rows.find((r) => r.number === 'MC-1')!
    expect(mc1).toMatchObject({ dueDate: '2026-10-31', s15: { payBy: '2026-09-16', basis: 'no_agreement' }, payBy: '2026-09-16', bucket: 'overdue' })
    expect(mc1.interestIndicative).toBeGreaterThan(0)
    expect(rows.find((r) => r.number === 'MC-2')).toMatchObject({ payBy: '2026-10-16', bucket: 'next_week', interestIndicative: 0 })
    // Medium enterprise: recorded, but no s.15 deadline — its own 30-day terms apply.
    expect(rows.find((r) => r.number === 'MM-1')).toMatchObject({ s15: null, payBy: '2026-10-20', bucket: 'later', msme: { category: 'medium', covered: false } })
    // Early-payment discount: 2 % within 10 days.
    expect(rows.find((r) => r.number === 'PS-1')!.discount).toEqual({ by: '2026-10-12', bp: 200, paise: 4_000, available: true })
    expect(payablesPlan(db, '2026-10-07').totals.msmeOverdue).toBe(1_000_000)
  })
  it('shows the cash and bank available', () => {
    const { db, bank } = setup()
    const plan = payablesPlan(db, '2026-10-07')
    expect(plan.cash.ledgers.find((l) => l.ledgerId === bank)).toMatchObject({ kind: 'bank', balance: 100_000_000 })
  })
  it('dashboard: MSME due this week / past the period', () => {
    const { db, micro, expense } = setup()
    bill(db, micro, expense, '2026-09-01', 'MC-1', 1_000_000) // s.15 16 Sep — late
    bill(db, micro, expense, '2026-09-24', 'MC-3', 70_000) // s.15 9 Oct — this week (Wed 7 → Sun 11)
    expect(msmeDueSummary(db, '2026-10-07')).toEqual({ asOn: '2026-10-07', dueThisWeek: 70_000, dueThisWeekBills: 1, overdue: 1_000_000, overdueBills: 1 })
  })
})

describe('payment runs', () => {
  it('one balanced payment voucher per supplier, bill-wise, audited, under one run number', () => {
    const { db, micro, plain, bank, expense } = setup()
    bill(db, micro, expense, '2026-09-01', 'MC-1', 1_000_000)
    bill(db, micro, expense, '2026-10-01', 'MC-2', 500_000)
    bill(db, plain, expense, '2026-10-02', 'PS-1', 200_000)
    const before = (db.prepare('SELECT MAX(id) AS m FROM audit_log').get() as { m: number }).m
    const run = createPaymentRun(db, {
      date: '2026-10-07', kind: 'plan',
      items: [
        { partyLedgerId: micro, bankLedgerId: bank, amount: 1_500_000, bills: [{ name: 'MC-1', amount: 1_000_000 }, { name: 'MC-2', amount: 500_000 }] },
        { partyLedgerId: plain, bankLedgerId: bank, amount: 200_000, bills: [{ name: 'PS-1', amount: 200_000 }], instrumentNo: '000123' }
      ]
    })
    expect(run).toMatchObject({ runNo: 'PR-0001', kind: 'plan', vouchers: 2, amount: 1_700_000 })
    for (const l of run.lines) expect(balanced(l.voucherId!, db)).toBe(true)
    const v2 = getVoucher(db, run.lines[1]!.voucherId!)!
    expect(v2.billRefs).toEqual([{ kind: 'against', name: 'PS-1', amount: 200_000, dueDate: null }])
    expect(v2.instrumentNo).toBe('000123')
    // The bills are settled.
    expect(openBills(db, micro, '2026-10-07')).toEqual([])
    expect(payablesPlan(db, '2026-10-07').totals.pending).toBe(0)
    const audit = db.prepare('SELECT entity, action FROM audit_log WHERE id > ?').all(before) as { entity: string; action: string }[]
    expect(audit).toContainEqual({ entity: 'payment_run', action: 'create' })
    expect(audit.filter((a) => a.entity === 'voucher' && a.action === 'create')).toHaveLength(2)
    expect(listPaymentRuns(db).map((r) => r.runNo)).toEqual(['PR-0001'])
    expect(paymentRunCsv(db, run.id).csv).toContain('Plain Supplies')
  })

  it('deducts TDS on payment where WP 3.2 says it is due (a 194C bill booked without TDS)', () => {
    const { db, bank, expense } = setup()
    const s194c = db.prepare("SELECT id FROM tds_sections WHERE code = '194C'").get() as { id: number }
    const contractor = createLedger(db, { name: 'Site Builders Pvt Ltd', groupId: groupId(db, 'Sundry Creditors'), tdsSectionId: s194c.id, pan: 'AABCS1234F' }).id
    bill(db, contractor, expense, '2026-09-10', 'SB-9', 5_000_000)
    const input = { date: '2026-10-07', kind: 'batch' as const, items: [{ partyLedgerId: contractor, bankLedgerId: bank, amount: 5_000_000, bills: [{ name: 'SB-9', amount: 5_000_000 }] }] }
    const preview = previewPaymentRun(db, input)
    expect(preview.ok).toBe(true)
    expect(preview.lines[0]!.tds).toMatchObject({ code: '194C', base: 5_000_000, amount: 100_000 })
    expect(preview.totals).toEqual({ amount: 5_000_000, tds: 100_000, bank: 4_900_000, vouchers: 1 })
    const run = createPaymentRun(db, input)
    const v = getVoucher(db, run.lines[0]!.voucherId!)!
    expect(balanced(v.id, db)).toBe(true)
    expect(v.tds).toMatchObject({ sectionId: s194c.id, baseAmount: 5_000_000, tdsAmount: 100_000 })
    expect(v.lines.find((l) => l.ledgerId === bank)).toMatchObject({ drCr: 'cr', amount: 4_900_000 })
    expect(v.lines.find((l) => l.ledgerId === contractor)).toMatchObject({ drCr: 'dr', amount: 5_000_000 })
    expect(run.lines[0]!.tds).toMatchObject({ amount: 100_000 })
    // Without TDS when asked not to.
    bill(db, contractor, expense, '2026-09-11', 'SB-10', 5_000_000)
    const noTds = previewPaymentRun(db, { ...input, applyTds: false, items: [{ ...input.items[0]!, bills: [{ name: 'SB-10', amount: 5_000_000 }] }] })
    expect(noTds.lines[0]!.tds).toBeNull()
  })

  it('is all-or-nothing: one bad line posts nothing', () => {
    const { db, micro, plain, bank, expense } = setup()
    bill(db, micro, expense, '2026-09-01', 'MC-1', 1_000_000)
    bill(db, plain, expense, '2026-10-02', 'PS-1', 200_000)
    const vouchersBefore = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    const input = {
      date: '2026-10-07', kind: 'batch' as const,
      items: [
        { partyLedgerId: micro, bankLedgerId: bank, amount: 1_000_000, bills: [{ name: 'MC-1', amount: 1_000_000 }] },
        { partyLedgerId: plain, bankLedgerId: bank, amount: 300_000, bills: [{ name: 'PS-1', amount: 300_000 }] }
      ]
    }
    const preview = previewPaymentRun(db, input)
    expect(preview.ok).toBe(false)
    expect(preview.lines[1]!.errors.join()).toMatch(/only .* is pending/)
    expect(() => createPaymentRun(db, input)).toThrow(/Plain Supplies: Bill PS-1/)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(vouchersBefore)
    expect(db.prepare('SELECT COUNT(*) AS n FROM payment_runs').get()).toEqual({ n: 0 })
    // Bills picked must equal the amount (pick none to pay oldest first / on account).
    const partial = previewPaymentRun(db, { ...input, items: [{ partyLedgerId: micro, bankLedgerId: bank, amount: 1_200_000, bills: [{ name: 'MC-1', amount: 1_000_000 }] }] })
    expect(partial.lines[0]!.errors.join()).toMatch(/pick no bills/)
    // A bank that is not a bank, and an unknown bill.
    const bad = previewPaymentRun(db, { ...input, items: [{ partyLedgerId: micro, bankLedgerId: plain, amount: 100, bills: [{ name: 'NOPE', amount: 100 }] }] })
    expect(bad.lines[0]!.errors).toEqual(expect.arrayContaining(['Plain Supplies is not a cash or bank ledger', 'Bill NOPE is not open on 2026-10-07']))
  })

  it('a payment with no bills settles the oldest first; a binned payment drops out of its run', () => {
    const { db, micro, bank, expense } = setup()
    bill(db, micro, expense, '2026-09-01', 'MC-1', 1_000_000)
    bill(db, micro, expense, '2026-10-01', 'MC-2', 500_000)
    const run = createPaymentRun(db, { date: '2026-10-07', kind: 'batch', items: [{ partyLedgerId: micro, bankLedgerId: bank, amount: 1_200_000 }] })
    expect(getVoucher(db, run.lines[0]!.voucherId!)!.billRefs).toEqual([])
    expect(openBills(db, micro, '2026-10-07').map((b) => [b.number, b.pending])).toEqual([['MC-2', 300_000]])
    deleteVoucher(db, run.lines[0]!.voucherId!)
    expect(getPaymentRun(db, run.id)).toMatchObject({ vouchers: 0, amount: 0 })
  })
})

describe('MSME report', () => {
  function msmeBooks(): ReturnType<typeof setup> & { small: number } {
    const f = setup()
    const { db, micro, medium, bank, expense } = f
    const small = createLedger(db, {
      name: 'Small Forge', groupId: groupId(db, 'Sundry Creditors'), pan: 'AAAPS9876K', msmeRegistered: true, msmeCategory: 'small',
      udyamNo: 'UDYAM-KA-03-0000456', agreedCreditDays: 30
    }).id
    // FY 2025-26: a micro bill unpaid at 31 Mar, past its 15 days (disallowed) …
    bill(db, micro, expense, '2026-02-01', 'MC-A', 400_000)
    // … one booked 25 Mar (period ends 9 Apr) paid on 5 Apr (in time — allowed) …
    bill(db, micro, expense, '2026-03-25', 'MC-B', 300_000)
    pay(db, micro, bank, '2026-04-05', 300_000, 'MC-B')
    // … and one booked 28 Mar, paid 30 Apr (late: disallowed for 2025-26).
    bill(db, small, expense, '2026-03-28', 'SF-1', 200_000)
    pay(db, small, bank, '2026-04-30', 200_000, 'SF-1')
    // A medium supplier's dues never count.
    bill(db, medium, expense, '2026-02-01', 'MM-A', 999_000)
    // Current half-year: a small-supplier bill outstanding > 45 days at 30 Sep.
    bill(db, small, expense, '2026-07-01', 'SF-2', 150_000)
    return Object.assign(f, { small })
  }

  it('ages micro / small dues against the s.15 deadline with indicative s.16 interest', () => {
    const { db } = msmeBooks()
    const r = msmeReport(db, { asOn: '2026-10-07', today: '2026-10-07' })
    expect(r.rows.map((x) => x.number).sort()).toEqual(['MC-A', 'SF-2'])
    const a = r.rows.find((x) => x.number === 'MC-A')!
    expect(a).toMatchObject({ category: 'micro', s15: { payBy: '2026-02-16', basis: 'no_agreement' }, bucket: 'late_61_plus' })
    expect(a.interest.paise).toBeGreaterThan(0)
    const sf2 = r.rows.find((x) => x.number === 'SF-2')!
    expect(sf2.s15).toMatchObject({ payBy: '2026-07-31', basis: 'agreed' })
    expect(r.totalPending).toBe(550_000)
    expect(r.s16RateBp).toBe(1725)
  })

  it('works out the s.43B(h) figure for FY 2025-26 bill by bill', () => {
    const { db } = msmeBooks()
    const d = msmeReport(db, { asOn: '2026-10-07', fyStartYear: 2025, today: '2026-10-07' }).disallowance
    expect(d.fyEnd).toBe('2026-03-31')
    const by = (n: string) => d.bills.find((b) => b.number === n)!
    expect(by('MC-A')).toMatchObject({ status: 'disallowed', disallowed: 400_000 })
    expect(by('MC-B')).toMatchObject({ status: 'allowed', disallowed: 0 })
    expect(by('SF-1')).toMatchObject({ status: 'disallowed', disallowed: 200_000, payBy: '2026-04-27' })
    expect(d.disallowed).toBe(600_000)
    expect(d.bills.some((b) => b.number === 'MM-A')).toBe(false)
  })

  it('gives MSME Form 1 data for the half-year: per supplier, paid within / after 45 days, outstanding ≤ / > 45 days', () => {
    const { db, micro, small } = msmeBooks()
    const f = msmeReport(db, { asOn: '2026-10-07', today: '2026-10-07' }).form1
    expect(f.period).toMatchObject({ from: '2026-04-01', to: '2026-09-30', dueDate: '2026-10-31' })
    expect(f.mustFile).toBe(true)
    const m = f.suppliers.find((s) => s.ledgerId === micro)!
    expect(m).toMatchObject({ paidWithin45: { count: 1, amount: 300_000 }, paidAfter45: { count: 0, amount: 0 }, outstandingOver45: 400_000, pan: 'AAAPM1234C' })
    const s = f.suppliers.find((x) => x.ledgerId === small)!
    // SF-1 was late under its 30-day agreement (s.15) but paid on day 33 — within the Form's 45 days.
    expect(s).toMatchObject({ paidWithin45: { count: 1, amount: 200_000 }, paidAfter45: { count: 0, amount: 0 }, outstandingOver45: 150_000 })
    expect(f.rows.map((r) => r.number).sort()).toEqual(['MC-A', 'SF-2'])
    const csv = msmeForm1Csv(db, { asOn: '2026-10-07' }).csv
    expect(csv).toContain('Name of MSE supplier')
    expect(csv).toContain('Small Forge')
  })

  it('flags data gaps and lets the owner edit the bank rate table (audited)', () => {
    const { db } = msmeBooks()
    createLedger(db, { name: 'Unclassified MSME', groupId: groupId(db, 'Sundry Creditors'), msmeRegistered: true })
    const gaps = msmeReport(db, { asOn: '2026-10-07' }).gaps
    expect(gaps.filter((g) => g.name === 'Unclassified MSME').map((g) => g.issue).join()).toMatch(/no category.*Udyam/i)
    const saved = saveBankRate(db, { fromDate: '2026-12-05', rateBp: 600, source: 'test: RBI press release' })
    expect(listBankRates(db).at(-1)).toMatchObject({ fromDate: '2026-12-05', rateBp: 600 })
    expect(() => saveBankRate(db, { fromDate: '2026-12-05', rateBp: 600, source: 'dup row' })).toThrow(/already exists/)
    deleteBankRate(db, saved.id!)
    const audit = db.prepare("SELECT action FROM audit_log WHERE entity = 'msme_bank_rate' ORDER BY id").all()
    expect(audit).toEqual([{ action: 'create' }, { action: 'delete' }])
  })

  it('warns at year end when MSME dues are past the period', () => {
    const { db } = msmeBooks()
    const w = msmeYearEndWarning(db, 2025, '2026-10-07')
    expect(w).toMatchObject({ asOn: '2026-03-31', overdue: 400_000, bills: 1, parties: 1, disallowed: 600_000 })
    expect(closePreview(db, 2025).msme).toMatchObject({ overdue: 400_000 })
  })
})

describe('supplier statement and reconciliation', () => {
  it('matches the supplier\'s ledger CSV against ours and lists the differences', () => {
    const { db, plain, bank, expense } = setup()
    bill(db, plain, expense, '2026-04-05', 'PS-1', 1_180_000, 'INV-101')
    bill(db, plain, expense, '2026-04-12', 'PS-2', 590_000, 'INV-102')
    pay(db, plain, bank, '2026-04-20', 1_180_000, 'PS-1')
    const st = supplierStatement(db, plain, '2026-04-01', '2026-04-30')
    expect(st.rows.map((r) => [r.supplierRef, r.credit, r.debit])).toEqual([['INV-101', 1_180_000, 0], ['INV-102', 590_000, 0], [null, 0, 1_180_000]])
    expect(st.closing).toBe(590_000)
    const csv = [
      'Date,Invoice No,Particulars,Debit,Credit',
      '05/04/2026,INV-101,Sales,11800.00,',
      '12/04/2026,INV/26-27/102,Sales,5950.00,',
      '19/04/2026,RCPT-7,Payment received,,11800.00',
      '28/04/2026,INV-103,Sales,3000.00,'
    ].join('\n')
    const r = supplierRecon(db, { ledgerId: plain, from: '2026-04-01', to: '2026-04-30', csvText: csv, amountPaise: 100, dateDays: 7 })
    expect(r.parseError).toBeNull()
    expect(r.counts).toEqual({ matched: 2, amount_diff: 1, only_supplier: 1, only_books: 0 })
    expect(r.pairs.find((p) => p.status === 'amount_diff')).toMatchObject({ amountDiff: 5_000, book: { supplierRef: 'INV-102' } })
    expect(r.supplierBalance).toBe(595_000 + 300_000)
    expect(r.bookBalance).toBe(590_000)
    expect(r.difference).toBe(590_000 - 895_000)
  })
})
