import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger } from './masters'
import { deleteVoucher, getVoucher, saveVoucher, setLockDate } from './vouchers'
import { export26qCsv, tdsSuggestion } from './tds'
import {
  applyTdsToVoucher, autoAllocate, challanFromPayment, challanInterest, challanRows, exemptVoucher, form16aData, form26qData,
  removeTdsFromVoucher, tdsDeducted, tdsEligible, tdsLedgerSummary, tdsPaymentCandidates, unexemptVoucher
} from './tdsWorkbench'
import { ensureCompanyTree } from '../paths'
import type { VoucherInput } from '@shared/schemas'

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-tdswb-test-'))
})

const sectionId = (db: DB, code: string): number => (db.prepare('SELECT id FROM tds_sections WHERE code = ?').get(code) as { id: number }).id
const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const vtId = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

function ledger(db: DB, name: string, group: string, extra: Record<string, unknown> = {}): number {
  return createLedger(db, {
    name, groupId: groupId(db, group), openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  } as Parameters<typeof createLedger>[1]).id
}

function fixture(db: DB) {
  return {
    contractor: ledger(db, 'Contractor Co', 'Sundry Creditors', { tdsSectionId: sectionId(db, '194C'), pan: 'ABCCE1234F' }),
    plainSupplier: ledger(db, 'Goods Supplier', 'Sundry Creditors', { pan: 'ABCFE1234F' }),
    consultant: ledger(db, 'Consultant LLP', 'Sundry Creditors', { pan: 'ABCFE9999F' }),
    labour: ledger(db, 'Labour Charges', 'Direct Expenses'),
    fees: ledger(db, 'Professional Fees', 'Indirect Expenses', { tdsDefaultSectionId: sectionId(db, '194J') }),
    purchases: ledger(db, 'Purchases', 'Purchase Accounts'),
    cgst: ledger(db, 'CGST Input', 'Duties & Taxes', { taxType: 'cgst' }),
    sgst: ledger(db, 'SGST Input', 'Duties & Taxes', { taxType: 'sgst' }),
    bank: ledger(db, 'HDFC Bank', 'Bank Accounts')
  }
}
type Fx = ReturnType<typeof fixture>

const journal = (db: DB, date: string, party: number, expense: number, amount: number, extra: Partial<VoucherInput> = {}): number =>
  saveVoucher(db, {
    voucherTypeId: vtId(db, 'journal'), date, partyLedgerId: party,
    lines: [{ ledgerId: expense, drCr: 'dr', amount }, { ledgerId: party, drCr: 'cr', amount }], ...extra
  }).id

/** Purchase: Dr Purchases taxable + CGST/SGST 9% each / Cr Supplier, with a 'new' bill ref. */
const purchase = (db: DB, fx: Fx, date: string, party: number, taxable: number): number => {
  const tax = Math.round(taxable * 0.09)
  const total = taxable + 2 * tax
  return saveVoucher(db, {
    voucherTypeId: vtId(db, 'purchase'), date, partyLedgerId: party,
    lines: [
      { ledgerId: fx.purchases, drCr: 'dr', amount: taxable }, { ledgerId: fx.cgst, drCr: 'dr', amount: tax },
      { ledgerId: fx.sgst, drCr: 'dr', amount: tax }, { ledgerId: party, drCr: 'cr', amount: total }
    ],
    billRefs: [{ kind: 'new', name: `B-${date}`, amount: total, dueDate: null }]
  }).id
}

const payment = (db: DB, fx: Fx, date: string, party: number, amount: number): number =>
  saveVoucher(db, {
    voucherTypeId: vtId(db, 'payment'), date, partyLedgerId: party,
    lines: [{ ledgerId: party, drCr: 'dr', amount }, { ledgerId: fx.bank, drCr: 'cr', amount }]
  }).id

const balanced = (db: DB, id: number): void => {
  const v = getVoucher(db, id)!
  const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  expect(dr).toBe(cr)
}

const FY = { from: '2025-04-01', to: '2026-03-31' }

describe('tdsEligible — thresholds over every qualifying credit', () => {
  it('single-transaction crossing: a ₹35,000 contract bill is eligible, a ₹20,000 one is not', () => {
    const db = seededDb()
    const fx = fixture(db)
    const small = journal(db, '2025-04-10', fx.contractor, fx.labour, 2000000)
    const big = journal(db, '2025-05-10', fx.contractor, fx.labour, 3500000)
    const rows = tdsEligible(db, FY.from, FY.to)
    expect(rows.map((r) => r.voucherId)).toEqual([big])
    expect(rows[0]).toMatchObject({ reason: 'single', sectionCode: '194C', basePaise: 3500000, rateBp: 200, tdsPaise: 70000, partyLedgerId: fx.contractor })
    expect(rows.some((r) => r.voucherId === small)).toBe(false)
  })

  it('aggregate crossing mid-year makes the earlier below-limit bills eligible too', () => {
    const db = seededDb()
    const fx = fixture(db)
    const a = journal(db, '2025-04-10', fx.contractor, fx.labour, 2500000)
    const b = journal(db, '2025-06-10', fx.contractor, fx.labour, 2500000)
    const c = journal(db, '2025-08-10', fx.contractor, fx.labour, 2500000)
    // Before the fourth bill: ₹75,000 aggregate, nothing eligible.
    expect(tdsEligible(db, FY.from, FY.to)).toEqual([])
    const d = journal(db, '2025-10-10', fx.contractor, fx.labour, 2600000)
    const rows = tdsEligible(db, FY.from, FY.to)
    expect(rows.map((r) => [r.voucherId, r.reason])).toEqual([[a, 'aggregate_later'], [b, 'aggregate_later'], [c, 'aggregate_later'], [d, 'aggregate']])
    // The period filter only narrows what is listed — the walk still starts at the FY.
    expect(tdsEligible(db, '2025-10-01', '2025-12-31').map((r) => r.voucherId)).toEqual([d])
  })

  it('counts bills that already carry TDS towards the aggregate, but never lists them', () => {
    const db = seededDb()
    const fx = fixture(db)
    const first = journal(db, '2025-04-10', fx.contractor, fx.labour, 9000000)
    applyTdsToVoucher(db, { voucherId: first, manualPaise: 100000 })
    const second = journal(db, '2025-05-10', fx.contractor, fx.labour, 2000000)
    expect(tdsEligible(db, FY.from, FY.to)).toMatchObject([{ voucherId: second, reason: 'aggregate' }])
  })

  it('WP 3.1 gap: the suggestion threshold counts undeducted bills, not just recorded entries', () => {
    const db = seededDb()
    const fx = fixture(db)
    journal(db, '2025-04-10', fx.contractor, fx.labour, 2500000)
    journal(db, '2025-05-10', fx.contractor, fx.labour, 2500000)
    journal(db, '2025-06-10', fx.contractor, fx.labour, 2500000)
    const s = tdsSuggestion(db, fx.contractor, 2600000, '2025-07-01')!
    expect(s.threshold.priorPaise).toBe(7500000)
    expect(s.thresholdCrossed).toBe(true)
    expect(s.threshold.reason).toBe('aggregate')
  })

  it('"Not applicable" drops a voucher from the list and from the aggregate', () => {
    const db = seededDb()
    const fx = fixture(db)
    const a = journal(db, '2025-04-10', fx.contractor, fx.labour, 6000000)
    journal(db, '2025-05-10', fx.contractor, fx.labour, 2500000)
    journal(db, '2025-06-10', fx.contractor, fx.labour, 2000000)
    expect(tdsEligible(db, FY.from, FY.to).length).toBe(3)
    exemptVoucher(db, a, 'Reimbursement of expenses — not a contract payment')
    // ₹45,000 left, no single bill over ₹30,000: nothing liable.
    expect(tdsEligible(db, FY.from, FY.to)).toEqual([])
    expect(tdsEligible(db, FY.from, FY.to, { includeExempt: true })).toMatchObject([{ voucherId: a, exemptReason: 'Reimbursement of expenses — not a contract payment' }])
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'tdsExemption' AND entity_id = ?").get(a)).toEqual({ n: 1 })
    unexemptVoucher(db, a)
    expect(tdsEligible(db, FY.from, FY.to).length).toBe(3)
  })

  it('excludes binned, optional and unmatured post-dated vouchers — from the list and the aggregate', () => {
    const db = seededDb()
    const fx = fixture(db)
    const binned = journal(db, '2025-04-10', fx.contractor, fx.labour, 6000000)
    deleteVoucher(db, binned)
    journal(db, '2025-04-11', fx.contractor, fx.labour, 6000000, { isOptional: true })
    journal(db, '2025-04-12', fx.contractor, fx.labour, 6000000, { postDated: true })
    const real = journal(db, '2025-05-10', fx.contractor, fx.labour, 2500000)
    expect(tdsEligible(db, FY.from, FY.to)).toEqual([])
    expect(tdsSuggestion(db, fx.contractor, 2500000, '2025-06-01')!.threshold.priorPaise).toBe(2500000)
    void real
  })

  it('section from the debited ledger: base = debits to that ledger, the party needs a PAN-readable type', () => {
    const db = seededDb()
    const fx = fixture(db)
    const id = journal(db, '2025-05-10', fx.consultant, fx.fees, 6000000)
    expect(tdsEligible(db, FY.from, FY.to)).toMatchObject([{ voucherId: id, sectionCode: '194J', basePaise: 6000000, tdsPaise: 600000, reason: 'aggregate', expenseLedgerId: fx.fees }])
  })

  it('purchase base is the taxable value (GST excluded)', () => {
    const db = seededDb()
    const fx = fixture(db)
    const id = purchase(db, fx, '2025-05-10', fx.contractor, 4000000)
    expect(tdsEligible(db, FY.from, FY.to)).toMatchObject([{ voucherId: id, basePaise: 4000000, tdsPaise: 80000 }])
  })

  it('first-of-credit-or-payment: a payment that deducts covers the undeducted bill; an advance is its own event', () => {
    const db = seededDb()
    const fx = fixture(db)
    const bill = journal(db, '2025-05-10', fx.contractor, fx.labour, 4000000)
    expect(tdsEligible(db, FY.from, FY.to).map((r) => r.voucherId)).toEqual([bill])
    // Paying the bill: the banner offers TDS on the undeducted bill.
    const s = tdsSuggestion(db, fx.contractor, 4000000, '2025-06-01', { voucherKind: 'payment' })!
    expect(s.payment).toMatchObject({ undeductedBillsPaise: 4000000, advancePaise: 0, deductedAtCredit: false })
    expect(s).toMatchObject({ basePaise: 4000000, tdsPaise: 80000 })
    const pay = payment(db, fx, '2025-06-01', fx.contractor, 4000000)
    applyTdsToVoucher(db, { voucherId: pay })
    expect(getVoucher(db, pay)!.tds).toMatchObject({ baseAmount: 4000000, tdsAmount: 80000 })
    expect(tdsEligible(db, FY.from, FY.to)).toEqual([])
    // A later payment against a bill that was deducted at credit: nothing to deduct.
    const bill2 = journal(db, '2025-07-10', fx.contractor, fx.labour, 4000000)
    applyTdsToVoucher(db, { voucherId: bill2 })
    expect(tdsSuggestion(db, fx.contractor, 3920000, '2025-07-20', { voucherKind: 'payment' })).toMatchObject({ tdsPaise: 0, payment: { deductedAtCredit: true } })
    // An advance (paid before any bill) above the single limit is eligible as such.
    const other = ledger(db, 'Advance Contractor', 'Sundry Creditors', { tdsSectionId: sectionId(db, '194C'), pan: 'ABCCE7777F' })
    const advance = payment(db, fx, '2025-08-01', other, 3500000)
    expect(tdsEligible(db, FY.from, FY.to)).toMatchObject([{ voucherId: advance, reason: 'advance', basePaise: 3500000 }])
  })
})

describe('tds:applyToVoucher / tds:removeFromVoucher — per voucher kind', () => {
  it('purchase: the supplier credit (and its new bill) gives up the TDS; remove restores it', () => {
    const db = seededDb()
    const fx = fixture(db)
    const id = purchase(db, fx, '2025-05-10', fx.contractor, 4000000)
    const before = getVoucher(db, id)!
    const after = applyTdsToVoucher(db, { voucherId: id })!
    balanced(db, id)
    expect(after.tds).toMatchObject({ baseAmount: 4000000, tdsAmount: 80000, isManual: false, rateBp: 200 })
    const last = after.lines[after.lines.length - 1]!
    expect(last).toMatchObject({ drCr: 'cr', amount: 80000 })
    expect(db.prepare('SELECT name, tds_payable_section_id AS s FROM ledgers WHERE id = ?').get(last.ledgerId)).toEqual({ name: 'TDS Payable 194C', s: sectionId(db, '194C') })
    expect(after.lines.find((l) => l.ledgerId === fx.contractor)!.amount).toBe(4720000 - 80000)
    expect(after.billRefs[0]!.amount).toBe(4720000 - 80000)
    expect(db.prepare("SELECT action FROM audit_log WHERE entity = 'tdsEntry'").all()).toEqual([{ action: 'create' }])
    // Deducted + ledger summary see it.
    expect(tdsDeducted(db, FY.from, FY.to)).toMatchObject([{ voucherId: id, tdsPaise: 80000, challanStatus: 'unallocated', kind: 'purchase' }])
    expect(tdsLedgerSummary(db, 2025, 1)).toMatchObject([{ sectionCode: '194C', deductedPaise: 80000, outstandingPaise: 80000, entriesTdsPaise: 80000, deductees: 1 }])

    const removed = removeTdsFromVoucher(db, id)!
    balanced(db, id)
    expect(removed.tds).toBeNull()
    expect(removed.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual(before.lines.map((l) => [l.ledgerId, l.drCr, l.amount]))
    expect(removed.billRefs).toEqual(before.billRefs)
    expect(db.prepare("SELECT action FROM audit_log WHERE entity = 'tdsEntry' ORDER BY id").all()).toEqual([{ action: 'create' }, { action: 'delete' }])
  })

  it('journal: the party credit; payment: the bank credit — both balanced both ways', () => {
    const db = seededDb()
    const fx = fixture(db)
    const j = journal(db, '2025-05-10', fx.contractor, fx.labour, 4000000)
    applyTdsToVoucher(db, { voucherId: j })
    balanced(db, j)
    expect(getVoucher(db, j)!.lines.find((l) => l.ledgerId === fx.contractor)!.amount).toBe(3920000)
    removeTdsFromVoucher(db, j)
    balanced(db, j)
    expect(getVoucher(db, j)!.lines.find((l) => l.ledgerId === fx.contractor)!.amount).toBe(4000000)

    const p = payment(db, fx, '2025-08-01', fx.contractor, 3500000)
    const applied = applyTdsToVoucher(db, { voucherId: p })!
    balanced(db, p)
    expect(applied.lines.find((l) => l.ledgerId === fx.contractor)!.amount).toBe(3500000)
    expect(applied.lines.find((l) => l.ledgerId === fx.bank)!.amount).toBe(3500000 - 70000)
    removeTdsFromVoucher(db, p)
    balanced(db, p)
    expect(getVoucher(db, p)!.lines.find((l) => l.ledgerId === fx.bank)!.amount).toBe(3500000)
  })

  it('manual amount and section choice', () => {
    const db = seededDb()
    const fx = fixture(db)
    const j = journal(db, '2025-05-10', fx.contractor, fx.labour, 4000000)
    const v = applyTdsToVoucher(db, { voucherId: j, sectionId: sectionId(db, '194J'), manualPaise: 123400 })!
    expect(v.tds).toMatchObject({ sectionId: sectionId(db, '194J'), tdsAmount: 123400, isManual: true })
    balanced(db, j)
  })

  it('refuses with a reason: already deducted, locked books, closed year, a sales voucher, no deductee', () => {
    const db = seededDb()
    const fx = fixture(db)
    const j = journal(db, '2025-05-10', fx.contractor, fx.labour, 4000000)
    applyTdsToVoucher(db, { voucherId: j })
    expect(() => applyTdsToVoucher(db, { voucherId: j })).toThrow(/already carries/)
    const k = journal(db, '2025-05-11', fx.contractor, fx.labour, 4000000)
    setLockDate(db, '2025-05-31')
    expect(() => applyTdsToVoucher(db, { voucherId: k })).toThrow(/locked up to 2025-05-31/)
    expect(() => removeTdsFromVoucher(db, j)).toThrow(/locked/)
    setLockDate(db, null)
    // A live closing journal in the FY closes it.
    const close = journal(db, '2026-03-31', fx.labour, fx.purchases, 100)
    db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(close)
    expect(() => applyTdsToVoucher(db, { voucherId: k })).toThrow(/FY 2025-26 is closed/)
    db.prepare('UPDATE vouchers SET is_year_end_close = 0 WHERE id = ?').run(close)
    const plain = journal(db, '2025-05-12', fx.labour, fx.purchases, 4000000)
    expect(() => applyTdsToVoucher(db, { voucherId: plain })).toThrow(/No deductee/)
    // The voucher is untouched by every refusal.
    expect(getVoucher(db, k)!.tds).toBeNull()
    balanced(db, k)
  })
})

describe('challans, interest and returns', () => {
  it('challan from the deposit payment, auto-allocated oldest first, interest, 26Q and 16A data', () => {
    const db = seededDb()
    const fx = fixture(db)
    const a = journal(db, '2025-05-10', fx.contractor, fx.labour, 4000000)
    const b = journal(db, '2025-06-10', fx.contractor, fx.labour, 4000000)
    applyTdsToVoucher(db, { voucherId: a })
    applyTdsToVoucher(db, { voucherId: b })
    const payable = db.prepare("SELECT id FROM ledgers WHERE name = 'TDS Payable 194C'").get() as { id: number }
    // Deposit both on 7 June: May's is on time, June's is early.
    const dep = saveVoucher(db, {
      voucherTypeId: vtId(db, 'payment'), date: '2025-07-20',
      lines: [{ ledgerId: payable.id, drCr: 'dr', amount: 160000 }, { ledgerId: fx.bank, drCr: 'cr', amount: 160000 }]
    }).id
    expect(tdsPaymentCandidates(db, 2025)).toMatchObject([{ voucherId: dep, amountPaise: 160000, sectionCodes: '194C', challanId: null }])
    const c = challanFromPayment(db, { paymentVoucherId: dep, bsrCode: '0510308', challanNo: '42', autoAllocate: true })
    expect(c).toMatchObject({ quarter: 1, fyStartYear: 2025, amountPaise: 160000, allocatedPaise: 160000, entryCount: 2, paymentVoucherNumber: getVoucher(db, dep)!.number })
    expect(autoAllocate(db, c.id)).toEqual([])
    // Paid 20 July: May's deduction was due 7 June → May..July = 3 months at 1.5% on ₹800; June's due 7 July → 2 months.
    const interest = challanInterest(db, c.id)
    expect(interest.map((i) => [i.dueDate, i.months, i.interestPaise])).toEqual([['2025-06-07', 3, 3600], ['2025-07-07', 2, 2400]])
    expect(challanRows(db, 2025)[0]!.interestPaise).toBe(6000)
    expect(challanInterest(db, c.id, 100).map((i) => i.interestPaise)).toEqual([2400, 1600])
    expect(tdsDeducted(db, FY.from, FY.to).map((r) => r.challanStatus)).toEqual(['paid', 'paid'])
    expect(tdsLedgerSummary(db, 2025, 2)).toMatchObject([{ sectionCode: '194C', openingPaise: 160000, depositedPaise: 160000, outstandingPaise: 0 }])

    const q = form26qData(db, 2025, 1)
    expect(q.layout).toBe('form26q')
    expect(q.deductees).toMatchObject([
      { serial: 1, partyName: 'Contractor Co', pan: 'ABCCE1234F', deducteeCode: '01', returnCode: '94C', amountPaise: 4000000, tdsPaise: 80000, challanSerial: 1, bsrCode: '0510308', reasonCode: '' },
      { serial: 2, challanSerial: 1 }
    ])
    expect(q.challans).toMatchObject([{ serial: 1, challanNo: '42', amountPaise: 160000, allocatedPaise: 160000, entries: 2 }])
    expect(q.totals).toEqual({ amountPaise: 8000000, tdsPaise: 160000, depositedPaise: 160000 })

    const f = form16aData(db, { ...TEST_INFO, tan: 'MUMT12345A', pan: 'AAACT1234C' }, 2025, 1)
    expect(f).toMatchObject({ assessmentYear: '2026-27', deductor: { tan: 'MUMT12345A' }, period: { from: '2025-04-01', to: '2025-06-30' } })
    expect(f.parties).toMatchObject([{ partyName: 'Contractor Co', totals: { amountPaise: 8000000, tdsPaise: 160000, depositedPaise: 160000 }, challans: [{ challanNo: '42', tdsPaise: 160000 }] }])

    const slug = 'tdswb-26q'
    ensureCompanyTree(slug)
    const csv = readFileSync(export26qCsv(db, TEST_INFO, slug, 2025, 1), 'utf8').trim().split(/\r?\n/)
    expect(csv[1]).toContain(',0510308,2025-07-20,42,94C,2025-05-10,,1600.00')
    expect(csv).toContain('Challan #,Challan BSR,Challan Date,Challan Serial,Challan Amount (Rs),TDS Allocated (Rs),Entries')
    expect(csv[csv.length - 1]).toBe('1,0510308,2025-07-20,42,1600.00,1600.00,2')
  })
})
