import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { openBills } from './analysis'
import { saveVoucher } from './vouchers'
import {
  cancelPaymentRun,
  createPaymentRun,
  paymentAccounts,
  postPaymentRun,
  previewPaymentRun,
  paymentFilePreview,
  paymentFileCsv
} from './paymentRuns'

const defaults = { gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 0, exportType: null }

function supplierBill(db: ReturnType<typeof seededDb>, amount = 100_000): { partyId: number; number: string; date: string } {
  const group = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const partyId = createLedger(db, { ...defaults, name: 'Run Supplier', groupId: group('Sundry Creditors'), openingBalance: 0 }).id
  const purchaseId = createLedger(db, { ...defaults, name: 'Run Purchases', groupId: group('Purchase Accounts'), openingBalance: 0 }).id
  const typeId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }).id
  const date = '2026-08-01'
  const number = 'SUP-100'
  saveVoucher(db, {
    voucherTypeId: typeId, date, partyLedgerId: partyId, narration: 'Supplier invoice', reference: number,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null,
    lines: [{ ledgerId: purchaseId, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: partyId, drCr: 'cr', amount, costAllocations: [] }],
    inventory: [], billRefs: [{ kind: 'new', name: number, amount, dueDate: date }], tds: null
  })
  return { partyId, number, date }
}

describe('supplier payment runs', () => {
  it('previews bank impact, stays outside books as a draft, then posts linked bill payments atomically', () => {
    const db = seededDb()
    db.prepare("UPDATE ledgers SET opening_balance = 500000 WHERE name = 'Cash'").run()
    const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const bill = supplierBill(db)
    const selection = [{ partyLedgerId: bill.partyId, billNumber: bill.number, billDate: bill.date, amount: 100_000 }]

    expect(paymentAccounts(db, '2026-08-24').find((account) => account.ledgerId === cashId)?.balance).toBe(500_000)
    expect(previewPaymentRun(db, cashId, '2026-08-24', selection)).toMatchObject({
      totalAmount: 100_000, balanceAfter: 400_000, supplierCount: 1, billCount: 1
    })
    const voucherCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    const before = voucherCount()
    const draft = createPaymentRun(db, { bankLedgerId: cashId, date: '2026-08-24', note: 'Weekly run', bills: selection }, 'Asha')
    expect(draft).toMatchObject({ status: 'draft', totalAmount: 100_000, createdBy: 'Asha' })
    expect(voucherCount()).toBe(before)

    const posted = postPaymentRun(db, draft.id, 'Owner')
    expect(posted).toMatchObject({ status: 'posted', postedBy: 'Owner' })
    expect(posted.items[0]?.voucherId).toEqual(expect.any(Number))
    expect(voucherCount()).toBe(before + 1)
    expect(openBills(db, bill.partyId, '2026-08-24')).toEqual([])
    expect(() => postPaymentRun(db, draft.id, 'Owner')).toThrow('Only a draft')
  })

  it('refuses a stale draft before writing any payment voucher', () => {
    const db = seededDb()
    db.prepare("UPDATE ledgers SET opening_balance = 500000 WHERE name = 'Cash'").run()
    const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const bill = supplierBill(db)
    const selection = [{ partyLedgerId: bill.partyId, billNumber: bill.number, billDate: bill.date, amount: 100_000 }]
    const draft = createPaymentRun(db, { bankLedgerId: cashId, date: '2026-08-24', note: null, bills: selection }, 'Asha')
    const typeId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }).id
    saveVoucher(db, {
      voucherTypeId: typeId, date: '2026-08-24', partyLedgerId: bill.partyId, narration: 'Paid separately', reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [{ ledgerId: bill.partyId, drCr: 'dr', amount: 100_000, costAllocations: [] }, { ledgerId: cashId, drCr: 'cr', amount: 100_000, costAllocations: [] }],
      inventory: [], billRefs: [{ kind: 'against', name: bill.number, amount: 100_000, dueDate: null }], tds: null
    })
    const before = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    expect(() => postPaymentRun(db, draft.id, 'Owner')).toThrow('no longer uniquely open')
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(before)
  })

  it('cancels drafts without touching the books', () => {
    const db = seededDb()
    const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const bill = supplierBill(db)
    const draft = createPaymentRun(db, {
      bankLedgerId: cashId,
      date: '2026-08-24',
      note: null,
      bills: [{ partyLedgerId: bill.partyId, billNumber: bill.number, billDate: bill.date, amount: 100_000 }]
    }, 'Asha')
    expect(cancelPaymentRun(db, draft.id, 'Asha').status).toBe('cancelled')
    expect(() => postPaymentRun(db, draft.id, 'Owner')).toThrow('Only a draft')
  })

  it('exports reviewable bank-specific files only for verified beneficiary details', () => {
    const db = seededDb()
    const bankId = createLedger(db, { ...defaults, name: 'Bulk Payment Bank', groupId: (db.prepare("SELECT id FROM groups WHERE name = 'Bank Accounts'").get() as { id: number }).id, openingBalance: 500000 }).id
    const bill = supplierBill(db)
    const draft = createPaymentRun(db, { bankLedgerId: bankId, date: '2026-08-24', note: null, bills: [{ partyLedgerId: bill.partyId, billNumber: bill.number, billDate: bill.date, amount: 100000 }] }, 'Asha')
    expect(paymentFilePreview(db, draft.id, 'generic_neft').blockers).toEqual(['Run Supplier: bank account and IFSC are required'])
    db.prepare(`INSERT INTO vendor_profiles (ledger_id, bank_account, ifsc, status, verified_by, verified_at) VALUES (?, '1234567890', 'HDFC0001234', 'verified', 'Owner', datetime('now'))`).run(bill.partyId)
    const preview = paymentFilePreview(db, draft.id, 'hdfc_bulk')
    expect(preview).toMatchObject({ blockers: [], totalAmount: 100000, rows: [{ beneficiaryName: 'Run Supplier', bankAccount: '1234567890', ifsc: 'HDFC0001234' }] })
    const file = paymentFileCsv(db, draft.id, 'hdfc_bulk')
    expect(file.filename).toBe(`payment-run-${draft.id}-hdfc_bulk.csv`)
    expect(file.csv).toContain('Transaction Type,Beneficiary Code')
    expect(file.csv).toContain('HDFC0001234')
    expect(paymentFilePreview(db, draft.id, 'icici_bulk').blockers).toContain('Add the company debit account in Settings → Invoice → Bank details before ICICI export')
    db.prepare("INSERT INTO meta (key, value) VALUES ('invoice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ bankDetails: { name: 'ICICI Bank', account: '998877665544', ifsc: 'ICIC0001234', branch: 'Main' } }))
    const icici = paymentFileCsv(db, draft.id, 'icici_bulk')
    expect(icici.preview.debitAccount).toBe('998877665544')
    expect(icici.csv).toContain('NEFT,998877665544,Run Supplier')
  })
})
