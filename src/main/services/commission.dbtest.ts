import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { outstandings } from './analysis'
import { commissionDraft, commissionReport, saveCommissionScheme } from './commission'

type Db = ReturnType<typeof seededDb>

/**
 * Commission on collection.
 *
 * The property that matters: an invoice that is never collected earns nothing, and a part
 * collection earns part of it. The second property is that "collected" here agrees with the
 * ageing report, because the two are derived from the same allocation.
 */
const LEDGER_DEFAULTS = {
  openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

function books(): {
  db: Db
  buyer: number
  sell: (date: string, number: string, taxable: number, tax: number) => void
  receive: (date: string, amount: number, against?: string) => void
} {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

  const buyer = createLedger(db, {
    ...LEDGER_DEFAULTS, name: 'Kumar Stores', groupId: groupId('Sundry Debtors'), salesperson: 'Ravi'
  } as never).id
  const sales = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Sales Account', groupId: groupId('Sales Accounts') }).id
  const cgst = createLedger(db, { ...LEDGER_DEFAULTS, name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

  const sell = (date: string, number: string, taxable: number, tax: number): void => {
    saveVoucher(db, {
      voucherTypeId: vt('sales'), date, number, partyLedgerId: buyer,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: buyer, drCr: 'dr', amount: taxable + tax, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: taxable, costAllocations: [] },
        { ledgerId: cgst, drCr: 'cr', amount: tax, costAllocations: [] }
      ],
      inventory: [],
      billRefs: [{ kind: 'new', name: number, amount: taxable + tax, dueDate: null }],
      tds: null
    })
  }

  const receive = (date: string, amount: number, against?: string): void => {
    saveVoucher(db, {
      voucherTypeId: vt('receipt'), date, partyLedgerId: buyer,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: buyer, drCr: 'cr', amount, costAllocations: [] }
      ],
      inventory: [],
      billRefs: against ? [{ kind: 'against', name: against, amount, dueDate: null }] : [],
      tds: null
    })
  }

  return { db, buyer, sell, receive }
}

const scheme = (db: Db, basis: 'gross' | 'net_of_tax' = 'net_of_tax'): void => {
  saveCommissionScheme(db, { salesperson: 'Ravi', rateBp: 250, basis, fromDate: '2026-04-01' })
}

describe('commission is earned on the money, not on the bill', () => {
  it('an uncollected invoice earns nothing at all', () => {
    const { db, sell } = books()
    scheme(db)
    sell('2026-04-05', 'SV-1', 1_00_000_00, 18_000_00)
    const report = commissionReport(db, '2026-04-01', '2026-06-30')
    expect(report.totalCollectedPaise).toBe(0)
    expect(report.statements).toEqual([])
  })

  it('a collected invoice earns the rate on its tax-exclusive value', () => {
    const { db, sell, receive } = books()
    scheme(db)
    sell('2026-04-05', 'SV-1', 1_00_000_00, 18_000_00)
    receive('2026-05-10', 1_18_000_00, 'SV-1')
    const report = commissionReport(db, '2026-04-01', '2026-06-30')
    expect(report.totalCollectedPaise).toBe(1_18_000_00)
    expect(report.statements[0]!.salesperson).toBe('Ravi')
    // 2.5% of the taxable 1,00,000 — not of the 1,18,000 that included the government's money.
    expect(report.statements[0]!.commissionPaise).toBe(2_500_00)
  })

  it('a gross scheme pays on the whole receipt', () => {
    const { db, sell, receive } = books()
    scheme(db, 'gross')
    sell('2026-04-05', 'SV-1', 1_00_000_00, 18_000_00)
    receive('2026-05-10', 1_18_000_00, 'SV-1')
    expect(commissionReport(db, '2026-04-01', '2026-06-30').statements[0]!.commissionPaise).toBe(2_950_00)
  })

  it('a part collection earns part of the commission', () => {
    const { db, sell, receive } = books()
    scheme(db)
    sell('2026-04-05', 'SV-1', 1_00_000_00, 18_000_00)
    receive('2026-05-10', 59_000_00, 'SV-1')
    expect(commissionReport(db, '2026-04-01', '2026-06-30').statements[0]!.commissionPaise).toBe(1_250_00)
  })

  it('the rest is earned in the period the rest is received', () => {
    const { db, sell, receive } = books()
    scheme(db)
    sell('2026-04-05', 'SV-1', 1_00_000_00, 18_000_00)
    receive('2026-05-10', 59_000_00, 'SV-1')
    receive('2026-07-10', 59_000_00, 'SV-1')
    expect(commissionReport(db, '2026-04-01', '2026-06-30').totalCommissionPaise).toBe(1_250_00)
    expect(commissionReport(db, '2026-07-01', '2026-09-30').totalCommissionPaise).toBe(1_250_00)
  })

  it('agrees with the ageing report about what is still open', () => {
    const { db, buyer, sell, receive } = books()
    scheme(db)
    sell('2026-04-05', 'SV-1', 1_00_000_00, 18_000_00)
    receive('2026-05-10', 59_000_00, 'SV-1')
    const ageing = outstandings(db, 'receivable', '2026-06-30', { includeBills: true }).find((p) => p.ledgerId === buyer)!
    const collected = commissionReport(db, '2026-04-01', '2026-06-30').totalCollectedPaise
    expect(ageing.pending + collected).toBe(1_18_000_00)
  })
})

describe('who is paid', () => {
  it('nobody without a scheme, and the gap is reported rather than hidden', () => {
    const { db, sell, receive } = books()
    sell('2026-04-05', 'SV-1', 1_00_000_00, 18_000_00)
    receive('2026-05-10', 1_18_000_00, 'SV-1')
    const report = commissionReport(db, '2026-04-01', '2026-06-30')
    expect(report.statements).toEqual([])
    expect(report.withoutScheme).toEqual(['Ravi'])
  })

  it('collections from a party with no salesperson are counted separately, not lost', () => {
    const db = seededDb()
    const groupId = (name: string): number =>
      (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
    const buyer = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Nobody’s customer', groupId: groupId('Sundry Debtors'), openingBalance: 1_00_000_00 }).id
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    saveVoucher(db, {
      voucherTypeId: vt('receipt'), date: '2026-05-10', partyLedgerId: buyer,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash, drCr: 'dr', amount: 40_000_00, costAllocations: [] },
        { ledgerId: buyer, drCr: 'cr', amount: 40_000_00, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    const report = commissionReport(db, '2026-04-01', '2026-06-30')
    expect(report.unassignedCollectedPaise).toBe(40_000_00)
    expect(report.totalCommissionPaise).toBe(0)
  })

  it('a later rate is not retrospective', () => {
    const { db, sell, receive } = books()
    saveCommissionScheme(db, { salesperson: 'Ravi', rateBp: 250, basis: 'net_of_tax', fromDate: '2026-04-01' })
    saveCommissionScheme(db, { salesperson: 'Ravi', rateBp: 500, basis: 'net_of_tax', fromDate: '2026-07-01' })
    sell('2026-04-05', 'SV-1', 1_00_000_00, 18_000_00)
    receive('2026-05-10', 1_18_000_00, 'SV-1')
    expect(commissionReport(db, '2026-04-01', '2026-06-30').statements[0]!.commissionPaise).toBe(2_500_00)
  })

  it('refuses a rate above 100%', () => {
    const { db } = books()
    expect(() => saveCommissionScheme(db, { salesperson: 'Ravi', rateBp: 20000, basis: 'gross', fromDate: '2026-04-01' }))
      .toThrow('between 0% and 100%')
  })
})

describe('the journal', () => {
  it('is a draft, it balances, and it credits a payable rather than paying anybody', () => {
    const { db, sell, receive } = books()
    scheme(db)
    sell('2026-04-05', 'SV-1', 1_00_000_00, 18_000_00)
    receive('2026-05-10', 1_18_000_00, 'SV-1')
    const before = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    const draft = commissionDraft(db, '2026-04-01', '2026-06-30')!
    expect(draft.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)).toBe(
      draft.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
    )
    expect(draft.lines.some((l) => l.group === 'Current Liabilities')).toBe(true)
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(before)
  })

  it('is nothing at all when nothing was collected', () => {
    const { db } = books()
    scheme(db)
    expect(commissionDraft(db, '2026-04-01', '2026-06-30')).toBeNull()
  })
})
