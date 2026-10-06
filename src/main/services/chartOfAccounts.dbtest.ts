// WP 1.2 — "Local Sale is a sub-ledger of Sales Account but not showing in masters". The
// chart of accounts (Masters → Groups) must list ledgers under their group with closing
// balances that agree with the trial balance and ignore binned/optional vouchers.
import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger } from './masters'
import { saveVoucher, deleteVoucher } from './vouchers'
import { chartOfAccounts, trialBalance } from './reports'
import type { ChartGroupNode } from '@shared/chartOfAccounts'

const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const ledgerId = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id

function ledger(db: DB, name: string, group: string, openingBalance = 0): number {
  return createLedger(db, {
    name, groupId: groupId(db, group), openingBalance, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function journal(db: DB, date: string, dr: number, cr: number, amount: number, isOptional = false): ReturnType<typeof saveVoucher> {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, partyLedgerId: null, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null, isOptional,
    lines: [
      { ledgerId: dr, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  })
}

function findGroup(roots: ChartGroupNode[], name: string): ChartGroupNode | undefined {
  for (const r of roots) {
    if (r.name === name) return r
    const hit = findGroup(r.children, name)
    if (hit) return hit
  }
  return undefined
}

describe('chartOfAccounts', () => {
  it('shows Local Sale under Sales Accounts and Local Purchase under Purchase Accounts with balances and counts', () => {
    const db = seededDb()
    const cash = ledgerId(db, 'Cash')
    const sale = ledger(db, 'Local Sale', 'Sales Accounts')
    const purchase = ledger(db, 'Local Purchase', 'Purchase Accounts')

    journal(db, '2025-04-05', cash, sale, 1_00_000_00) // ₹1,00,000 sale
    journal(db, '2025-04-06', purchase, cash, 40_000_00) // ₹40,000 purchase
    const binned = journal(db, '2025-04-07', cash, sale, 5_000_00)
    deleteVoucher(db, binned.id) // soft-deleted: must not count
    journal(db, '2025-04-08', cash, sale, 7_000_00, true) // optional (memorandum): must not count
    journal(db, '2025-05-01', cash, sale, 9_000_00) // after asOn: must not count

    const roots = chartOfAccounts(db, '2025-04-30')

    const salesGroup = findGroup(roots, 'Sales Accounts')!
    expect(salesGroup.ledgers.map((l) => l.name)).toContain('Local Sale')
    const saleLeaf = salesGroup.ledgers.find((l) => l.name === 'Local Sale')!
    expect(saleLeaf.id).toBe(sale)
    expect(saleLeaf.balance).toBe(-1_00_000_00) // credit
    expect(salesGroup.ledgerCount).toBe(salesGroup.ledgers.length + salesGroup.children.reduce((s, c) => s + c.ledgerCount, 0))
    expect(salesGroup.ledgerCount).toBeGreaterThanOrEqual(1)
    expect(salesGroup.balance).toBe(-1_00_000_00)

    const purchaseGroup = findGroup(roots, 'Purchase Accounts')!
    const purchaseLeaf = purchaseGroup.ledgers.find((l) => l.name === 'Local Purchase')!
    expect(purchaseLeaf.balance).toBe(40_000_00) // debit
    expect(purchaseGroup.balance).toBe(40_000_00)
    expect(purchaseGroup.ledgerCount).toBeGreaterThanOrEqual(1)

    // Every ledger appears exactly once, and every leaf balance agrees with the trial balance.
    const tb = trialBalance(db, '2025-04-30')
    const leaves: { id: number; balance: number }[] = []
    const walk = (n: ChartGroupNode): void => {
      leaves.push(...n.ledgers)
      n.children.forEach(walk)
    }
    roots.forEach(walk)
    const ledgerCount = (db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n
    expect(leaves.length).toBe(ledgerCount)
    expect(roots.reduce((s, r) => s + r.ledgerCount, 0)).toBe(ledgerCount)
    for (const leaf of leaves) {
      const row = tb.rows.find((r) => r.ledgerId === leaf.id)
      expect(leaf.balance).toBe(row ? row.debit - row.credit : 0)
    }
    // Books balance: the whole chart nets to zero.
    expect(roots.reduce((s, r) => s + r.balance, 0)).toBe(0)
  })

  it('keeps zero-balance ledgers and includes opening balances', () => {
    const db = seededDb()
    ledger(db, 'Local Sale', 'Sales Accounts')
    const debtor = ledger(db, 'Acme Traders', 'Sundry Debtors', 12_345_00)
    const roots = chartOfAccounts(db, '2025-04-30')
    expect(findGroup(roots, 'Sales Accounts')!.ledgers.find((l) => l.name === 'Local Sale')!.balance).toBe(0)
    expect(findGroup(roots, 'Sundry Debtors')!.ledgers.find((l) => l.id === debtor)!.balance).toBe(12_345_00)
    // Sundry Debtors sits under Current Assets, which rolls it up.
    const ca = findGroup(roots, 'Current Assets')!
    expect(ca.ledgerCount).toBeGreaterThanOrEqual(1)
    expect(findGroup(ca.children, 'Sundry Debtors')).toBeDefined()
  })

  it('two years, year-end close not run: income/expense leaves show only the current FY and match the TB (WP 1.3)', () => {
    const db = seededDb() // books from FY 2025-26
    const cash = ledgerId(db, 'Cash')
    const sale = ledger(db, 'Local Sale', 'Sales Accounts')
    const purchase = ledger(db, 'Local Purchase', 'Purchase Accounts')
    const debtor = ledger(db, 'Acme Traders', 'Sundry Debtors')

    journal(db, '2025-06-10', purchase, cash, 1_40_50_613_00) // FY1 purchases
    journal(db, '2025-07-01', debtor, sale, 2_00_00_000_00) // FY1 sale on credit
    journal(db, '2026-05-15', purchase, cash, 2_50_000_00) // FY2 purchases
    journal(db, '2026-06-01', debtor, sale, 4_00_000_00) // FY2 sale on credit

    const asOn = '2027-03-31'
    const roots = chartOfAccounts(db, asOn)
    const purchaseGroup = findGroup(roots, 'Purchase Accounts')!
    const purchaseLeaf = purchaseGroup.ledgers.find((l) => l.id === purchase)!
    expect(purchaseLeaf.balance).toBe(2_50_000_00) // FY2 only — not FY1's ₹1,40,50,613
    expect(purchaseGroup.balance).toBe(2_50_000_00)
    expect(findGroup(roots, 'Sales Accounts')!.ledgers.find((l) => l.id === sale)!.balance).toBe(-4_00_000_00)
    // Asset ledgers stay cumulative.
    expect(findGroup(roots, 'Sundry Debtors')!.ledgers.find((l) => l.id === debtor)!.balance).toBe(2_04_00_000_00)

    const tb = trialBalance(db, asOn)
    expect(tb.totalDebit).toBe(tb.totalCredit)
    const purchaseRow = tb.rows.find((r) => r.ledgerId === purchase)!
    expect(purchaseLeaf.balance).toBe(purchaseRow.debit - purchaseRow.credit)
    const leaves: { id: number; balance: number }[] = []
    const walk = (n: ChartGroupNode): void => {
      leaves.push(...n.ledgers)
      n.children.forEach(walk)
    }
    roots.forEach(walk)
    for (const leaf of leaves) {
      const row = tb.rows.find((r) => r.ledgerId === leaf.id)
      expect(leaf.balance).toBe(row ? row.debit - row.credit : 0)
    }
  })
})
