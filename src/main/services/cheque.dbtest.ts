import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { setAuditContext, listAudit } from './audit'
import { getChequeConfig, setChequeConfig } from './config'
import { chequeData } from './cheque'
import { DEFAULT_CHEQUE_CONFIG, type ChequeConfig } from '@shared/schemas'

function bankLedger(db: ReturnType<typeof seededDb>, name = 'HDFC Bank'): { id: number } {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Bank Accounts'").get() as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
}

function partyLedger(db: ReturnType<typeof seededDb>, name = 'Acme Traders'): { id: number } {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Creditors'").get() as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
}

function postPayment(
  db: ReturnType<typeof seededDb>,
  opts: { partyId: number; bankId: number; amount: number; instrumentNo?: string }
) {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id,
    date: '2026-08-01',
    partyLedgerId: opts.partyId,
    narration: 'Being amount paid',
    reference: null,
    instrumentNo: opts.instrumentNo ?? null,
    instrumentDate: opts.instrumentNo ? '2026-08-01' : null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    currencyCode: null,
    exchangeRate: null,
    lines: [
      { ledgerId: opts.partyId, drCr: 'dr', amount: opts.amount, costAllocations: [] },
      { ledgerId: opts.bankId, drCr: 'cr', amount: opts.amount, costAllocations: [] }
    ],
    inventory: [],
    billRefs: [],
    tds: null
  })
}

describe('cheque config (meta.cheque.<bankLedgerId>)', () => {
  it('getChequeConfig returns the CTS-2010 defaults for an unconfigured ledger', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    expect(getChequeConfig(db, bank.id)).toEqual(DEFAULT_CHEQUE_CONFIG)
  })

  it('setChequeConfig round-trips a custom layout, is scoped per bank ledger, and audits the change', () => {
    setAuditContext({ appVersion: '1.0.0', getUserName: () => 'Tester' })
    const db = seededDb()
    const bankA = bankLedger(db, 'HDFC Bank')
    const bankB = bankLedger(db, 'ICICI Bank')

    const custom: ChequeConfig = {
      ...DEFAULT_CHEQUE_CONFIG,
      widthMm: 210,
      heightMm: 95,
      acPayee: false
    }
    const saved = setChequeConfig(db, bankA.id, custom)
    expect(saved).toEqual(custom)

    // Scoped: bankB is untouched and still reads the defaults.
    expect(getChequeConfig(db, bankA.id)).toEqual(custom)
    expect(getChequeConfig(db, bankB.id)).toEqual(DEFAULT_CHEQUE_CONFIG)

    const rows = listAudit(db, { entity: 'cheque_config' })
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.action).toBe('update')
    expect(rows.rows[0]!.entityId).toBe(bankA.id)
  })

  it('rejects an out-of-range mm offset', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    expect(() => setChequeConfig(db, bank.id, { ...DEFAULT_CHEQUE_CONFIG, widthMm: 500 })).toThrow()
  })
})

describe('chequeData validation + resolution', () => {
  it('throws for a non-payment voucher', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = partyLedger(db)
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
    const receipt = saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-08-01', partyLedgerId: party.id, narration: null, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: bank.id, drCr: 'dr', amount: 50000, costAllocations: [] },
        { ledgerId: party.id, drCr: 'cr', amount: 50000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    expect(() => chequeData(db, receipt.id, bank.id)).toThrow(/payment voucher/i)
  })

  it('throws when the given bank ledger has no credit line on the voucher', () => {
    const db = seededDb()
    const bankA = bankLedger(db, 'HDFC Bank')
    const bankB = bankLedger(db, 'ICICI Bank')
    const party = partyLedger(db)
    const voucher = postPayment(db, { partyId: party.id, bankId: bankA.id, amount: 75000 })
    expect(() => chequeData(db, voucher.id, bankB.id)).toThrow(/credit/i)
  })

  it('throws when bankLedgerId is not actually a bank ledger', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = partyLedger(db)
    const voucher = postPayment(db, { partyId: party.id, bankId: bank.id, amount: 75000 })
    expect(() => chequeData(db, voucher.id, party.id)).toThrow(/not a bank account/i)
  })

  it('resolves payee (party ledger name), amount (the bank credit line), and date correctly', () => {
    const db = seededDb()
    const bank = bankLedger(db, 'HDFC Bank')
    const party = partyLedger(db, 'Acme Traders')
    const voucher = postPayment(db, { partyId: party.id, bankId: bank.id, amount: 123456, instrumentNo: '000123' })

    const data = chequeData(db, voucher.id, bank.id)
    expect(data.payee).toBe('Acme Traders')
    expect(data.amount).toBe(123456)
    expect(data.date).toBe('2026-08-01')
    expect(data.bankLedgerId).toBe(bank.id)
    expect(data.bankLedgerName).toBe('HDFC Bank')
    expect(data.voucherNumber).toBe(voucher.number)
  })

  it('falls back to the largest debit line\'s ledger name when the voucher has no party', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const expenseGroup = db.prepare("SELECT id FROM groups WHERE name = 'Direct Expenses'").get() as { id: number }
    const expense = createLedger(db, {
      name: 'Office Rent', groupId: expenseGroup.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
    const voucher = saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-08-02', partyLedgerId: null, narration: 'Rent paid', reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
      currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: expense.id, drCr: 'dr', amount: 30000, costAllocations: [] },
        { ledgerId: bank.id, drCr: 'cr', amount: 30000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })

    const data = chequeData(db, voucher.id, bank.id)
    expect(data.payee).toBe('Office Rent')
  })
})
