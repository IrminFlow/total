/**
 * The banking tail against a real DB: the bank's own charges (#135), the reconciliation freeze
 * (#142), UTR matching (#141) and bounced cheques (#138).
 *
 * The classification and extraction rules are unit-tested in src/shared; what is exercised here
 * is what only exists once there is a database — ledgers being found or created, bank dates
 * refusing to move, and a reversal voucher that actually re-opens the bill it should.
 */
import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { listAudit, setAuditContext } from './audit'
import {
  bulkAcceptSuggestions, chargeLedgers, getReconLock, importStatement, listReconLocks,
  setBankDate, setReconLock, setupChargeLedgers, suggestVouchers
} from './banking'
import { bounceCheque, bounceCountByParty, listBounces, unbounce } from './chequeBounce'
import { deleteVoucher, getVoucher, saveVoucher } from './vouchers'
import { openBills } from './analysis'

type Db = ReturnType<typeof seededDb>

function ledgerIn(db: Db, group: string, name: string): { id: number } {
  const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(group) as { id: number }
  return createLedger(db, { name, groupId: g.id })
}

const bankLedger = (db: Db, name = 'HDFC Bank'): { id: number } => ledgerIn(db, 'Bank Accounts', name)

const header = 'Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance'
const csv = (...rows: string[]): string => [header, ...rows].join('\n')

// ---------------------------------------------------------------- #135 charges

describe('the bank’s own charges (#135)', () => {
  it('reports a recognised charge even before the ledger to post it to exists', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const rows = suggestVouchers(db, bank.id, csv('05/08/2026,AMC CHRG 062026,,"590.00",,"9,410.00"'))
    expect(rows).toHaveLength(1)
    // Recognised — but there is nowhere to put it, so no suggestion. The UI needs both facts to
    // know it should offer to create the ledgers rather than shrug.
    expect(rows[0]!.chargeCategory).toBe('charge')
    expect(rows[0]!.suggestion).toBeNull()
  })

  it('creates the four ledgers once, under the groups that make them mean the right thing', () => {
    const db = seededDb()
    const first = setupChargeLedgers(db)
    expect(first.created).toEqual([
      'Bank Charges', 'Bank Charges GST', 'Bank Interest Paid', 'Bank Interest Received'
    ])
    // Idempotent: opening a second statement must not make a second set.
    const again = setupChargeLedgers(db)
    expect(again.created).toEqual([])
    expect(again.existing).toHaveLength(4)

    const groupOf = (name: string): string =>
      (db.prepare('SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = ?').get(name) as
        { name: string }).name
    expect(groupOf('Bank Charges')).toBe('Indirect Expenses')
    // Recoverable input tax, not an expense.
    expect(groupOf('Bank Charges GST')).toBe('Duties & Taxes')
    expect(groupOf('Bank Interest Received')).toBe('Indirect Incomes')
  })

  it('adopts a Bank Charges ledger the user already had rather than creating a second one', () => {
    const db = seededDb()
    const mine = ledgerIn(db, 'Indirect Expenses', 'Bank Charges')
    setupChargeLedgers(db)
    expect(chargeLedgers(db).find((c) => c.category === 'charge')!.ledgerId).toBe(mine.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE name = ?').get('Bank Charges')).toEqual({ n: 1 })
  })

  it('suggests the charge, the GST on it and the interest, each to its own ledger', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    setupChargeLedgers(db)
    const rows = suggestVouchers(
      db,
      bank.id,
      csv(
        '05/08/2026,AMC CHRG 062026,,"500.00",,"9,500.00"',
        '05/08/2026,GST ON CHRG 18PCT,,"90.00",,"9,410.00"',
        '31/08/2026,CREDIT INTEREST CAPITALISED,,,"213.00","9,623.00"',
        '20/08/2026,BILLDESK RECHARGE JIO,,"299.00",,"9,324.00"'
      )
    )
    const by = (n: number): string | undefined => rows[n]!.suggestion?.ledgerName
    expect(by(0)).toBe('Bank Charges')
    expect(by(1)).toBe('Bank Charges GST')
    expect(by(2)).toBe('Bank Interest Received')
    // The false positive this whole feature is shaped around.
    expect(rows[3]!.suggestion).toBeNull()
    expect(rows[3]!.chargeCategory).toBeUndefined()

    expect(rows[0]!.suggestion!.source).toBe('charge')
    expect(rows[0]!.suggestion!.kind).toBe('payment')
    expect(rows[2]!.suggestion!.kind).toBe('receipt')
  })

  it('a user’s own rule still beats the built-in recognition', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    setupChargeLedgers(db)
    const mine = ledgerIn(db, 'Indirect Expenses', 'Bank Fees (mine)')
    db.prepare('INSERT INTO bank_rules (pattern, match_field, ledger_id, kind, active) VALUES (?, ?, ?, ?, 1)')
      .run('AMC CHRG', 'description', mine.id, 'payment')
    const rows = suggestVouchers(db, bank.id, csv('05/08/2026,AMC CHRG 062026,,"590.00",,"9,410.00"'))
    expect(rows[0]!.suggestion!.ledgerName).toBe('Bank Fees (mine)')
    expect(rows[0]!.suggestion!.source).toBe('rule')
  })

  it('bulk accept files the recognised charges, because 95 clears the default bar', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    setupChargeLedgers(db)
    const statement = csv(
      '05/08/2026,AMC CHRG 062026,,"500.00",,"9,500.00"',
      '31/08/2026,CREDIT INTEREST CAPITALISED,,,"213.00","9,713.00"'
    )
    const preview = bulkAcceptSuggestions(db, bank.id, statement)
    expect(preview.count).toBe(2)
    expect(preview.applied).toBe(false)

    const applied = bulkAcceptSuggestions(db, bank.id, statement, undefined, { apply: true })
    expect(applied.applied).toBe(true)
    expect(applied.accepted.every((a) => a.voucherId != null)).toBe(true)
    // Filed AND reconciled — the bank side of what was just posted is the statement row.
    const dates = db
      .prepare('SELECT bank_date AS d FROM voucher_lines WHERE ledger_id = ?')
      .all(bank.id) as { d: string | null }[]
    expect(dates.map((r) => r.d).sort()).toEqual(['2026-08-05', '2026-08-31'])
  })
})

// ---------------------------------------------------------------- #142 freeze

describe('reconciliation freeze (#142)', () => {
  const openBankLine = (db: Db, bankId: number, date: string, amount: number): number => {
    const office = ledgerIn(db, 'Direct Expenses', `Office ${date}${amount}`)
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
    const v = saveVoucher(db, {
      voucherTypeId: vt.id, date, partyLedgerId: null, narration: null, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: office.id, drCr: 'dr', amount },
        { ledgerId: bankId, drCr: 'cr', amount }
      ],
      inventory: [], billRefs: [], tds: null
    })
    return v.lines.find((l) => l.ledgerId === bankId)!.id
  }

  it('defaults to nothing frozen, and reports the lock per account', () => {
    const db = seededDb()
    const a = bankLedger(db, 'HDFC Bank')
    const b = bankLedger(db, 'ICICI Bank')
    expect(getReconLock(db, a.id)).toBeNull()
    setReconLock(db, a.id, '2026-06-30')
    expect(listReconLocks(db)).toEqual([
      { ledgerId: a.id, ledgerName: 'HDFC Bank', lockedTo: '2026-06-30' },
      { ledgerId: b.id, ledgerName: 'ICICI Bank', lockedTo: null }
    ])
  })

  it('refuses to reconcile INTO a frozen period', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const line = openBankLine(db, bank.id, '2026-06-10', 100_00)
    setReconLock(db, bank.id, '2026-06-30')
    expect(() => setBankDate(db, line, '2026-06-12')).toThrow(/frozen up to 2026-06-30/)
  })

  it('refuses to un-reconcile OUT of a frozen period — the change is the same size either way', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const line = openBankLine(db, bank.id, '2026-06-10', 100_00)
    setBankDate(db, line, '2026-06-12')
    setReconLock(db, bank.id, '2026-06-30')
    expect(() => setBankDate(db, line, null)).toThrow(/frozen/)
    expect(() => setBankDate(db, line, '2026-07-01')).toThrow(/frozen/)
  })

  it('leaves the period after the lock alone, and another account entirely alone', () => {
    const db = seededDb()
    const a = bankLedger(db, 'HDFC Bank')
    const b = bankLedger(db, 'ICICI Bank')
    const after = openBankLine(db, a.id, '2026-07-05', 100_00)
    const other = openBankLine(db, b.id, '2026-06-05', 100_00)
    setReconLock(db, a.id, '2026-06-30')
    setBankDate(db, after, '2026-07-06')
    setBankDate(db, other, '2026-06-06')
    expect(getReconLock(db, b.id)).toBeNull()
  })

  it('stops an import writing bank dates over the frozen period, before it writes any of them', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    openBankLine(db, bank.id, '2026-06-10', 100_00)
    const late = openBankLine(db, bank.id, '2026-07-10', 200_00)
    setReconLock(db, bank.id, '2026-06-30')
    const statement = csv(
      '10/06/2026,OLD ONE,,"100.00",,"0.00"',
      '10/07/2026,NEW ONE,,"200.00",,"0.00"'
    )
    expect(() => importStatement(db, bank.id, statement)).toThrow(/frozen/)
    // Nothing at all was written, including the row that was legal on its own.
    const row = db.prepare('SELECT bank_date AS d FROM voucher_lines WHERE id = ?').get(late) as { d: string | null }
    expect(row.d).toBeNull()
  })

  it('clearing the lock is audited, so a re-opened period leaves a trace', () => {
    setAuditContext({ appVersion: '1.0.0', getUserName: () => 'Tester' })
    const db = seededDb()
    const bank = bankLedger(db)
    setReconLock(db, bank.id, '2026-06-30')
    setReconLock(db, bank.id, null)
    expect(listAudit(db, { entity: 'bank_recon_lock' }).total).toBe(2)
    expect(getReconLock(db, bank.id)).toBeNull()
  })

  it('refuses to bin a voucher that is reconciled inside the frozen period', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const line = openBankLine(db, bank.id, '2026-06-10', 100_00)
    setBankDate(db, line, '2026-06-12')
    setReconLock(db, bank.id, '2026-06-30')

    const voucherId = (db.prepare('SELECT voucher_id AS v FROM voucher_lines WHERE id = ?').get(line) as
      { v: number }).v
    // Deleting it takes the entry off the statement side, which changes the signed-off BRS just
    // as much as clearing the bank date by hand would.
    expect(() => deleteVoucher(db, voucherId)).toThrow(/frozen up to 2026-06-30/)
  })

  it('leaves an UNRECONCILED voucher in the frozen period deletable', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const line = openBankLine(db, bank.id, '2026-06-10', 100_00)
    setReconLock(db, bank.id, '2026-06-30')
    const voucherId = (db.prepare('SELECT voucher_id AS v FROM voucher_lines WHERE id = ?').get(line) as
      { v: number }).v
    // It was never part of the frozen figure, so removing it cannot change it.
    expect(() => deleteVoucher(db, voucherId)).not.toThrow()
  })

  it('refuses a lock on something that is not a bank account', () => {
    const db = seededDb()
    const office = ledgerIn(db, 'Direct Expenses', 'Office')
    expect(() => setReconLock(db, office.id, '2026-06-30')).toThrow(/not a bank account/)
    expect(() => setReconLock(db, bankLedger(db).id, '30-06-2026')).toThrow(/Invalid/)
  })
})

// ---------------------------------------------------------------- #141 UTR

describe('UPI reference matching (#141)', () => {
  it('matches a statement row to the voucher quoting the same UTR, whatever the dates say', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = ledgerIn(db, 'Sundry Debtors', 'Acme Traders')
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
    saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-08-01', partyLedgerId: party.id, narration: null,
      reference: '451234567890', instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: bank.id, drCr: 'dr', amount: 25_000_00 },
        { ledgerId: party.id, drCr: 'cr', amount: 25_000_00 }
      ],
      inventory: [], billRefs: [], tds: null
    })
    // Twelve days later than the voucher — well outside the ±5-day proximity window, so only the
    // UTR can connect the two.
    const result = importStatement(
      db,
      bank.id,
      csv('13/08/2026,UPI/CR/451234567890/ACME TRADERS/HDFC/acme@okhdfc/Inv 41,,,"25,000.00","1,00,000.00"'),
      { apply: false }
    )
    expect(result.matched).toBe(1)
    expect(result.unmatched).toHaveLength(0)
  })

  it('will not match a shared UTR onto a different amount', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = ledgerIn(db, 'Sundry Debtors', 'Acme Traders')
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
    saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-08-13', partyLedgerId: party.id, narration: null,
      reference: '451234567890', instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: bank.id, drCr: 'dr', amount: 25_000_00 },
        { ledgerId: party.id, drCr: 'cr', amount: 25_000_00 }
      ],
      inventory: [], billRefs: [], tds: null
    })
    const result = importStatement(
      db,
      bank.id,
      csv('13/08/2026,UPI/CR/451234567890/ACME TRADERS/HDFC/acme@okhdfc/Part,,,"10,000.00","1,00,000.00"'),
      { apply: false }
    )
    // A part payment quoting the same UTR is not the same transaction.
    expect(result.matched).toBe(0)
  })
})

// ---------------------------------------------------------------- #138 bounces

describe('bounced cheques (#138)', () => {
  function receipt(db: Db, bankId: number, partyId: number, opts: { bill?: string } = {}): number {
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
    const v = saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-08-05', partyLedgerId: partyId, narration: null,
      reference: null, instrumentNo: '004521', instrumentDate: '2026-08-05', transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: bankId, drCr: 'dr', amount: 50_000_00 },
        { ledgerId: partyId, drCr: 'cr', amount: 50_000_00 }
      ],
      inventory: [],
      billRefs: opts.bill ? [{ kind: 'against', name: opts.bill, amount: 50_000_00, dueDate: '2026-07-31' }] : [],
      tds: null
    })
    return v.id
  }

  function invoice(db: Db, partyId: number, name: string): void {
    const sales = ledgerIn(db, 'Sales Accounts', `Sales ${name}`)
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-07-01', number: name, partyLedgerId: partyId, narration: null,
      reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: partyId, drCr: 'dr', amount: 50_000_00 },
        { ledgerId: sales.id, drCr: 'cr', amount: 50_000_00 }
      ],
      inventory: [],
      billRefs: [{ kind: 'new', name, amount: 50_000_00, dueDate: '2026-07-31' }],
      tds: null
    })
  }

  it('reverses every line of the receipt and records the event', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = ledgerIn(db, 'Sundry Debtors', 'Acme Traders')
    const rid = receipt(db, bank.id, party.id)

    const record = bounceCheque(db, { voucherId: rid, bounceDate: '2026-08-12', reason: 'Funds insufficient' })
    expect(record.bounceDate).toBe('2026-08-12')
    expect(record.reversalVoucherId).not.toBeNull()

    const reversal = getVoucher(db, record.reversalVoucherId!)!
    expect(reversal.narration).toContain('Cheque 004521 returned unpaid')
    expect(reversal.narration).toContain('Funds insufficient')
    const bankLine = reversal.lines.find((l) => l.ledgerId === bank.id)!
    // The receipt debited the bank; the reversal credits it.
    expect(bankLine.drCr).toBe('cr')
    expect(reversal.lines.find((l) => l.ledgerId === party.id)!.drCr).toBe('dr')
  })

  it('re-opens the bill under its own name and its original due date', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = ledgerIn(db, 'Sundry Debtors', 'Acme Traders')
    invoice(db, party.id, 'INV-7')
    const rid = receipt(db, bank.id, party.id, { bill: 'INV-7' })

    // Paid: nothing open before the cheque comes back.
    expect(openBills(db, party.id, '2026-08-31')).toHaveLength(0)

    bounceCheque(db, { voucherId: rid, bounceDate: '2026-08-12' })
    const open = openBills(db, party.id, '2026-08-31')
    expect(open).toHaveLength(1)
    expect(open[0]!.number).toBe('INV-7')
    expect(open[0]!.pending).toBe(50_000_00)

    const reversal = getVoucher(db, listBounces(db)[0]!.reversalVoucherId!)!
    // The due date travels with the bill: ageing that restarted on the bounce date would reward
    // the customer for the cheque failing.
    expect(reversal.billRefs).toEqual([
      { kind: 'new', name: 'INV-7', amount: 50_000_00, dueDate: '2026-07-31' }
    ])
  })

  it('puts the bank’s return charge on the same journal', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = ledgerIn(db, 'Sundry Debtors', 'Acme Traders')
    const charges = ledgerIn(db, 'Indirect Expenses', 'Bank Charges')
    const rid = receipt(db, bank.id, party.id)

    const record = bounceCheque(db, {
      voucherId: rid, bounceDate: '2026-08-12', chargeAmount: 590_00, chargeLedgerId: charges.id
    })
    const reversal = getVoucher(db, record.reversalVoucherId!)!
    expect(reversal.lines.find((l) => l.ledgerId === charges.id)).toMatchObject({ drCr: 'dr', amount: 590_00 })
    // The bank is credited twice: the returned money and the fee.
    const bankTotal = reversal.lines
      .filter((l) => l.ledgerId === bank.id && l.drCr === 'cr')
      .reduce((s, l) => s + l.amount, 0)
    expect(bankTotal).toBe(50_590_00)
  })

  it('refuses the things that would produce a plausible wrong entry', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = ledgerIn(db, 'Sundry Debtors', 'Acme Traders')
    const rid = receipt(db, bank.id, party.id)

    expect(() => bounceCheque(db, { voucherId: rid, bounceDate: '2026-08-01' }))
      .toThrow(/cannot bounce before/)
    expect(() => bounceCheque(db, { voucherId: rid, bounceDate: 'yesterday' })).toThrow(/Invalid/)
    expect(() => bounceCheque(db, { voucherId: rid, bounceDate: '2026-08-12', chargeAmount: 100_00 }))
      .toThrow(/needs a ledger/)
    expect(() => bounceCheque(db, { voucherId: 9999, bounceDate: '2026-08-12' })).toThrow(/not found/)

    bounceCheque(db, { voucherId: rid, bounceDate: '2026-08-12' })
    expect(() => bounceCheque(db, { voucherId: rid, bounceDate: '2026-08-20' })).toThrow(/already recorded/)
  })

  it('refuses a voucher that is not a cheque-bearing receipt or payment', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const other = bankLedger(db, 'ICICI Bank')
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'contra'").get() as { id: number }
    const v = saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-08-05', partyLedgerId: null, narration: null, reference: null,
      instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: bank.id, drCr: 'dr', amount: 1_000_00 },
        { ledgerId: other.id, drCr: 'cr', amount: 1_000_00 }
      ],
      inventory: [], billRefs: [], tds: null
    })
    expect(() => bounceCheque(db, { voucherId: v.id, bounceDate: '2026-08-12' }))
      .toThrow(/receipt or a payment/)
  })

  it('asks which bank when the voucher touches two of them', () => {
    const db = seededDb()
    const a = bankLedger(db, 'HDFC Bank')
    const b = bankLedger(db, 'ICICI Bank')
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
    const v = saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-08-05', partyLedgerId: null, narration: null, reference: null,
      instrumentNo: '9001', instrumentDate: null, transporterId: null, vehicleNo: null,
      transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: a.id, drCr: 'dr', amount: 1_000_00 },
        { ledgerId: b.id, drCr: 'cr', amount: 1_000_00 }
      ],
      inventory: [], billRefs: [], tds: null
    })
    expect(() => bounceCheque(db, { voucherId: v.id, bounceDate: '2026-08-12' })).toThrow(/more than one bank/)
    expect(bounceCheque(db, { voucherId: v.id, bounceDate: '2026-08-12', bankLedgerId: a.id }).id).toBeGreaterThan(0)
  })

  it('counts bounces by party — the number a credit decision wants', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const acme = ledgerIn(db, 'Sundry Debtors', 'Acme Traders')
    const other = ledgerIn(db, 'Sundry Debtors', 'Bharat Stores')
    bounceCheque(db, { voucherId: receipt(db, bank.id, acme.id), bounceDate: '2026-08-12' })
    bounceCheque(db, { voucherId: receipt(db, bank.id, other.id), bounceDate: '2026-08-14' })
    expect(bounceCountByParty(db)).toEqual([
      { partyLedgerId: acme.id, partyName: 'Acme Traders', bounces: 1 },
      { partyLedgerId: other.id, partyName: 'Bharat Stores', bounces: 1 }
    ])
  })

  it('undoing a bounce takes the reversal off the books with it', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = ledgerIn(db, 'Sundry Debtors', 'Acme Traders')
    const record = bounceCheque(db, { voucherId: receipt(db, bank.id, party.id), bounceDate: '2026-08-12' })
    unbounce(db, record.id)
    expect(listBounces(db)).toHaveLength(0)
    expect(getVoucher(db, record.reversalVoucherId!)!.deletedAt).not.toBeNull()
  })

  it('filters the register by date', () => {
    const db = seededDb()
    const bank = bankLedger(db)
    const party = ledgerIn(db, 'Sundry Debtors', 'Acme Traders')
    bounceCheque(db, { voucherId: receipt(db, bank.id, party.id), bounceDate: '2026-08-12' })
    expect(listBounces(db, '2026-09-01')).toHaveLength(0)
    expect(listBounces(db, '2026-08-01', '2026-08-31')).toHaveLength(1)
  })
})
