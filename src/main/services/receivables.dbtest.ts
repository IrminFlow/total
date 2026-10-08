// WP 4.2 — receivables: statements equal the ledger statement and the outstandings; interest
// debit notes are balanced, carry GST per the option and never charge a period twice; a credit
// hold blocks a new invoice unless overridden (audited); follow-ups and promises; reminders and
// their cadence; collection reports.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./pdf', () => ({
  htmlToPdf: async (html: string) => Buffer.from(`%PDF-test ${html.length}`),
  writeExportPdf: async () => '/dev/null'
}))

import type { DB } from '../db/connection'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { CompanyInfo } from '@shared/domain'
import { computeGst } from '@shared/gst/calc'
import { simpleInterest } from '@shared/receivables/interest'
import { createLedger } from './masters'
import { saveVoucher, deleteVoucher, restoreVoucher, getVoucher, CREDIT_HOLD_PREFIX } from './vouchers'
import { ledgerStatement } from './reports'
import { outstandings } from './analysis'
import { extractOutwardDocs } from './gst'
import * as rx from './receivables'

const COMPANY: CompanyInfo = { ...TEST_INFO, gstin: '27AAACT1234K1Z5', gstRegistrationType: 'regular' }
const SLUG = 'rx-test'

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-rx-'))
})

const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const vtId = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id

interface Fx { db: DB; party: number; sales: number; cgst: number; sgst: number; bank: number }

function fixture(opts: { rateBp?: number | null; graceDays?: number; creditDays?: number } = {}): Fx {
  const db = seededDb()
  const party = createLedger(db, {
    name: 'Mehta Traders', groupId: groupId(db, 'Sundry Debtors'), stateCode: '27', creditDays: opts.creditDays ?? 30,
    email: 'accounts@mehta.example', interestRateBp: opts.rateBp === undefined ? 1800 : opts.rateBp, interestGraceDays: opts.graceDays ?? 5
  }).id
  const sales = createLedger(db, { name: 'Sales', groupId: groupId(db, 'Sales Accounts'), gstRate: 18 }).id
  const cgst = createLedger(db, { name: 'CGST', groupId: groupId(db, 'Duties & Taxes'), taxType: 'cgst' }).id
  const sgst = createLedger(db, { name: 'SGST', groupId: groupId(db, 'Duties & Taxes'), taxType: 'sgst' }).id
  const bank = createLedger(db, { name: 'HDFC Bank', groupId: groupId(db, 'Bank Accounts') }).id
  return { db, party, sales, cgst, sgst, bank }
}

function invoice(f: Fx, date: string, taxable: number, number?: string): number {
  const g = computeGst(taxable, 18, 'intra')
  return saveVoucher(f.db, {
    voucherTypeId: vtId(f.db, 'sales'), date, number, partyLedgerId: f.party,
    lines: [
      { ledgerId: f.party, drCr: 'dr', amount: taxable + g.cgst + g.sgst },
      { ledgerId: f.sales, drCr: 'cr', amount: taxable },
      { ledgerId: f.cgst, drCr: 'cr', amount: g.cgst },
      { ledgerId: f.sgst, drCr: 'cr', amount: g.sgst }
    ]
  }).id
}

function receipt(f: Fx, date: string, amount: number): number {
  return saveVoucher(f.db, {
    voucherTypeId: vtId(f.db, 'receipt'), date, partyLedgerId: f.party,
    lines: [{ ledgerId: f.bank, drCr: 'dr', amount }, { ledgerId: f.party, drCr: 'cr', amount }]
  }).id
}

const auditRows = (db: DB, entity: string): { entity_id: number; action: string; after_json: string | null }[] =>
  db.prepare('SELECT entity_id, action, after_json FROM audit_log WHERE entity = ? ORDER BY id').all(entity) as never

describe('statement of account', () => {
  it('equals the ledger statement and the outstandings', () => {
    const f = fixture()
    invoice(f, '2026-04-05', 100_000, 'INV-1')
    invoice(f, '2026-05-10', 50_000, 'INV-2')
    receipt(f, '2026-05-20', 80_000)
    const ls = ledgerStatement(f.db, f.party, '2026-04-01', '2026-06-30')
    const s = rx.statementData(f.db, COMPANY, f.party, '2026-04-01', '2026-06-30')
    expect(s.opening).toBe(ls.opening)
    expect(s.closing).toBe(ls.closing)
    expect(s.totalDebit).toBe(ls.totalDebit)
    expect(s.totalCredit).toBe(ls.totalCredit)
    expect(s.rows.map((r) => [r.voucherId, r.debit, r.credit, r.running])).toEqual(ls.rows.map((r) => [r.voucherId, r.debit, r.credit, r.running]))
    const os = outstandings(f.db, 'receivable', '2026-06-30').find((p) => p.ledgerId === f.party)!
    expect(s.openBills).toEqual(os.bills)
    expect(s.buckets).toEqual(os.buckets)
    expect(s.openBills.reduce((a, b) => a + b.pending, 0) - s.unapplied).toBe(s.closing)
    expect(s.rows.find((r) => r.credit > 0)?.allocation).toBe('Against the oldest open bills')
    expect(s.email.mailto.startsWith('mailto:accounts@mehta.example?subject=')).toBe(true)
    const { html } = rx.statementHtml(f.db, COMPANY, f.party, '2026-04-01', '2026-06-30')
    expect(html).toContain('STATEMENT OF ACCOUNT')
    expect(html).toContain('INV-2')
  })

  it('writes one PDF per party with a balance (bulk) and audits the export', async () => {
    const f = fixture()
    invoice(f, '2026-04-05', 100_000)
    createLedger(f.db, { name: 'Settled Co', groupId: groupId(f.db, 'Sundry Debtors') })
    const one = await rx.statementPdf(f.db, COMPANY, SLUG, f.party, '2026-04-01', '2026-06-30')
    expect(existsSync(one.path)).toBe(true)
    const bulk = await rx.statementsBulk(f.db, COMPANY, SLUG, '2026-04-01', '2026-06-30')
    expect(bulk.files.map((x) => x.name)).toEqual(['Mehta Traders'])
    expect(auditRows(f.db, 'export').length).toBe(2)
  })
})

describe('interest on overdue bills', () => {
  it('previews simple interest per bill from due date + grace to the as-on date', () => {
    const f = fixture()
    const inv = invoice(f, '2026-04-01', 100_000, 'INV-1') // ₹1,180 with GST; due 1 May; grace 5 → from 7 May
    const rows = rx.interestPreview(f.db, COMPANY, '2026-06-05')
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect([r.billVoucherId, r.billRef, r.dueDate, r.from, r.to, r.days]).toEqual([inv, 'INV-1', '2026-05-01', '2026-05-07', '2026-06-05', 30])
    expect(r.interestPaise).toBe(simpleInterest(118_000, 1800, 30))
    expect(r.gst).toEqual([{ rate: 18, interestPaise: r.interestPaise, ...pick(computeGst(r.interestPaise, 18, 'intra')) }])
  })

  it('posts a balanced debit note with the GST split, and never charges a period twice', () => {
    const f = fixture()
    invoice(f, '2026-04-01', 100_000, 'INV-1')
    const posted = rx.postInterest(f.db, COMPANY, { asOn: '2026-06-05', ledgerId: f.party })
    const v = getVoucher(f.db, posted.voucherId)!
    const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)
    const g = computeGst(posted.interestPaise, 18, 'intra')
    expect(posted.gstPaise).toBe(g.cgst + g.sgst)
    expect(v.lines.find((l) => l.ledgerId === f.cgst)?.amount).toBe(g.cgst)
    expect(v.lines.find((l) => l.ledgerId === f.sgst)?.amount).toBe(g.sgst)
    const income = f.db.prepare("SELECT id, gst_rate FROM ledgers WHERE name = 'Interest on Overdue Bills @ 18%'").get() as { id: number; gst_rate: number }
    expect(income.gst_rate).toBe(18)
    expect(v.lines.find((l) => l.ledgerId === income.id)?.amount).toBe(posted.interestPaise)
    // The GST returns read the note as an outward debit note at 18% with the same tax.
    const doc = extractOutwardDocs(f.db, COMPANY, '2026-06-01', '2026-06-30').find((d) => (d as { voucherId?: number }).voucherId === posted.voucherId || (d as { id?: number }).id === posted.voucherId)
    expect(doc).toBeTruthy()
    // Same as-on again: nothing left to charge; later: only the new days.
    expect(rx.interestPreview(f.db, COMPANY, '2026-06-05')).toEqual([])
    expect(() => rx.postInterest(f.db, COMPANY, { asOn: '2026-06-05', ledgerId: f.party })).toThrow(/No interest/)
    const later = rx.interestPreview(f.db, COMPANY, '2026-06-15')
    expect(later.map((r) => [r.billRef, r.from, r.days])).toEqual([['INV-1', '2026-06-06', 10]])
    // The interest note itself is a new bill — it never accrues interest.
    expect(later.some((r) => r.billVoucherId === posted.voucherId)).toBe(false)
    expect(auditRows(f.db, 'interest_charge').map((a) => a.entity_id)).toEqual([posted.voucherId])
    expect(rx.interestCharges(f.db, f.party)).toHaveLength(1)
  })

  it('binning the note frees the period; restoring it after a re-charge is refused', () => {
    const f = fixture()
    invoice(f, '2026-04-01', 100_000, 'INV-1')
    const first = rx.postInterest(f.db, COMPANY, { asOn: '2026-06-05', ledgerId: f.party })
    deleteVoucher(f.db, first.voucherId)
    expect(rx.interestPreview(f.db, COMPANY, '2026-06-05')).toHaveLength(1)
    rx.postInterest(f.db, COMPANY, { asOn: '2026-06-05', ledgerId: f.party })
    expect(() => restoreVoucher(f.db, first.voucherId)).toThrow(/charge it twice/)
  })

  it('without GST (the option off) posts one line to the plain interest ledger', () => {
    const f = fixture()
    invoice(f, '2026-04-01', 100_000)
    const posted = rx.postInterest(f.db, COMPANY, { asOn: '2026-06-05', ledgerId: f.party, gstOnInterest: false })
    expect(posted.gstPaise).toBe(0)
    const v = getVoucher(f.db, posted.voucherId)!
    expect(v.lines).toHaveLength(2)
    const plain = f.db.prepare("SELECT id FROM ledgers WHERE name = 'Interest on Overdue Bills'").get() as { id: number }
    expect(v.lines.find((l) => l.drCr === 'cr')?.ledgerId).toBe(plain.id)
  })

  it('an unregistered company never charges GST; a party without a rate is never charged', () => {
    const f = fixture()
    invoice(f, '2026-04-01', 100_000)
    const rows = rx.interestPreview(f.db, { ...COMPANY, gstRegistrationType: 'unregistered' }, '2026-06-05')
    expect(rows[0]!.gstPaise).toBe(0)
    const g = fixture({ rateBp: null })
    invoice(g, '2026-04-01', 100_000)
    expect(rx.interestPreview(g.db, COMPANY, '2026-06-05')).toEqual([])
  })
})

function pick(g: { cgst: number; sgst: number; igst: number; cess: number }): { cessRate: number; cgst: number; sgst: number; igst: number; cess: number } {
  return { cessRate: 0, cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess }
}

describe('credit hold', () => {
  it('blocks a new sales invoice, lets an owner override with an audited reason', () => {
    const f = fixture()
    const existing = invoice(f, '2026-04-01', 10_000)
    rx.setCreditHold(f.db, f.party, true, 'Cheque bounced twice')
    expect(auditRows(f.db, 'credit_hold')).toHaveLength(1)
    expect(() => invoice(f, '2026-04-02', 10_000)).toThrow(CREDIT_HOLD_PREFIX)
    // A receipt is not new credit; nor is an edit of an existing invoice.
    receipt(f, '2026-04-03', 5_000)
    const v = getVoucher(f.db, existing)!
    saveVoucher(f.db, { ...v, narration: 'fixed' } as never, existing)
    // Owner override.
    const g = computeGst(10_000, 18, 'intra')
    const saved = saveVoucher(
      f.db,
      {
        voucherTypeId: vtId(f.db, 'sales'), date: '2026-04-04', partyLedgerId: f.party,
        lines: [
          { ledgerId: f.party, drCr: 'dr', amount: 10_000 + g.cgst + g.sgst },
          { ledgerId: f.sales, drCr: 'cr', amount: 10_000 },
          { ledgerId: f.cgst, drCr: 'cr', amount: g.cgst },
          { ledgerId: f.sgst, drCr: 'cr', amount: g.sgst }
        ]
      },
      undefined,
      { creditHoldOverride: { reason: 'Owner approved: advance received' } }
    )
    const ov = auditRows(f.db, 'credit_override')
    expect(ov.map((a) => a.entity_id)).toEqual([saved.id])
    expect(JSON.parse(ov[0]!.after_json!).overrideReason).toBe('Owner approved: advance received')
    rx.setCreditHold(f.db, f.party, false, '')
    invoice(f, '2026-04-05', 10_000)
  })

  it('lists parties by exposure with utilisation, hold and promises', () => {
    const f = fixture()
    f.db.prepare('UPDATE ledgers SET credit_limit = 100000 WHERE id = ?').run(f.party)
    invoice(f, '2026-04-01', 50_000, 'INV-1')
    rx.setCreditHold(f.db, f.party, true, 'Over limit')
    const inv = f.db.prepare("SELECT id FROM vouchers WHERE number = 'INV-1'").get() as { id: number }
    rx.addFollowup(f.db, { ledgerId: f.party, billVoucherId: inv.id, billRef: 'INV-1', date: '2026-05-02', note: 'Called, will pay Friday', promisedDate: '2026-05-08', promisedAmount: 59_000 })
    const [row] = rx.creditControl(f.db, '2026-05-05')
    expect(row!.outstanding).toBe(59_000)
    expect(row!.utilisation).toBe(0.59)
    expect(row!.hold).toBe(true)
    expect(row!.holdReason).toBe('Over limit')
    expect(row!.promisedDate).toBe('2026-05-08')
    expect(row!.dso).toBe(90) // ₹590 outstanding ÷ ₹590 sales in 90 days × 90
  })
})

describe('follow-ups and promises', () => {
  it('adds, lists, counts this week and deletes (audited)', () => {
    const f = fixture()
    const inv = invoice(f, '2026-04-01', 50_000, 'INV-1')
    const a = rx.addFollowup(f.db, { ledgerId: f.party, billVoucherId: inv, billRef: 'INV-1', date: '2026-05-04', note: 'Promised by Thursday', promisedDate: '2026-05-07', promisedAmount: null })
    expect(rx.listFollowups(f.db, f.party)).toHaveLength(1)
    const wk = rx.promisedThisWeek(f.db, '2026-05-05') // Tue; week Mon 4 – Sun 10 May
    expect([wk.weekFrom, wk.weekTo, wk.count, wk.amount]).toEqual(['2026-05-04', '2026-05-10', 1, 59_000])
    expect(rx.promisedThisWeek(f.db, '2026-05-12').overdueCount).toBe(1)
    receipt(f, '2026-05-07', 59_000)
    expect(rx.promisedThisWeek(f.db, '2026-05-08').count).toBe(0)
    rx.deleteFollowup(f.db, a.id)
    expect(auditRows(f.db, 'bill_followup').map((r) => r.action)).toEqual(['create', 'delete'])
  })
})

describe('reminders', () => {
  it('picks the letter by the oldest bill, logs it, and respects the cadence', async () => {
    const f = fixture({ rateBp: null })
    invoice(f, '2026-04-01', 50_000, 'INV-1') // due 1 May
    const [c] = rx.reminderCandidates(f.db, '2026-05-10')
    expect([c!.bucket, c!.maxOverdueDays, c!.oldestBill, c!.allowed]).toEqual(['gentle', 9, 'INV-1', true])
    expect(rx.reminderCandidates(f.db, '2026-06-05')[0]!.bucket).toBe('firm')
    expect(rx.reminderCandidates(f.db, '2026-07-05')[0]!.bucket).toBe('final')
    const sent = await rx.remind(f.db, COMPANY, SLUG, { ledgerId: f.party, asOn: '2026-05-10', channel: 'email' })
    expect(existsSync(sent.path)).toBe(true)
    expect(sent.mailto).toContain('mailto:accounts@mehta.example')
    expect(sent.body).toContain('INV-1')
    expect(rx.reminderLog(f.db, '2026-05-01', '2026-05-31').map((r) => [r.bucket, r.channel, r.oldestBill])).toEqual([['gentle', 'email', 'INV-1']])
    await expect(rx.remind(f.db, COMPANY, SLUG, { ledgerId: f.party, asOn: '2026-05-12', channel: 'email' })).rejects.toThrow(rx.REMINDER_CADENCE_PREFIX)
    const bulk = await rx.remindBulk(f.db, COMPANY, SLUG, { asOn: '2026-05-12', channel: 'pdf' })
    expect([bulk.sent.length, bulk.skipped.length]).toEqual([0, 1])
    const forced = await rx.remind(f.db, COMPANY, SLUG, { ledgerId: f.party, asOn: '2026-05-12', channel: 'phone', force: true })
    expect(forced.logId).toBeGreaterThan(sent.logId)
    expect(auditRows(f.db, 'reminder')).toHaveLength(2)
  })
})

describe('collection reports', () => {
  it('DSO, collection efficiency and ageing per month', () => {
    const f = fixture({ rateBp: null })
    invoice(f, '2026-04-05', 100_000) // ₹1,180, due 5 May
    receipt(f, '2026-05-10', 59_000)
    const rep = rx.collectionReport(f.db, '2026-04-01', '2026-05-31')
    const [apr, may] = rep.months
    expect([apr!.month, apr!.sales, apr!.closing, apr!.closingNotDue, apr!.collected]).toEqual(['2026-04', 118_000, 118_000, 118_000, 0])
    expect(apr!.dso).toBe(30)
    expect(apr!.efficiency).toBeNull() // nothing was due in April
    expect([may!.opening, may!.closing, may!.collected, may!.due, may!.efficiency]).toEqual([118_000, 59_000, 59_000, 118_000, 0.5])
    expect(may!.buckets).toEqual([59_000, 0, 0, 0])
    const top = rx.topOverdue(f.db, '2026-06-30', 10)
    expect(top.map((t) => [t.name, t.overdue, t.lastReceiptDate])).toEqual([['Mehta Traders', 59_000, '2026-05-10']])
  })
})
