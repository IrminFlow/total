import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, updateLedger } from './masters'
import { saveVoucher, getVoucher } from './vouchers'
import { listCostCentres, saveCostCentre, deleteCostCentre, ccReport, ccStatement } from './costCentres'
import type { VoucherInputParsed } from '@shared/schemas'

function expenseLedger(db: ReturnType<typeof seededDb>, name: string) {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Direct Expenses'").get() as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
}

function incomeLedger(db: ReturnType<typeof seededDb>, name: string) {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Direct Incomes'").get() as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
}

function journalVoucher(
  db: ReturnType<typeof seededDb>,
  date: string,
  lines: VoucherInputParsed['lines'],
  flags: { postDated?: boolean; isOptional?: boolean } = {}
): ReturnType<typeof saveVoucher> {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, number: undefined, partyLedgerId: null, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null, ...flags, lines, inventory: [], billRefs: [], tds: null
  })
}

describe('cost centres', () => {
  it('creates and lists cost centres', () => {
    const db = seededDb()
    saveCostCentre(db, { name: 'Mumbai Branch', parentId: null, active: true })
    saveCostCentre(db, { name: 'Pune Branch', parentId: null, active: true })
    const list = listCostCentres(db)
    expect(list.map((c) => c.name)).toEqual(['Mumbai Branch', 'Pune Branch'])
  })

  it('updates an existing cost centre when an id is given', () => {
    const db = seededDb()
    const created = saveCostCentre(db, { name: 'Mumbai Branch', parentId: null, active: true })
    const updated = saveCostCentre(db, { name: 'Mumbai HQ', parentId: null, active: true }, created.id)
    expect(updated.id).toBe(created.id)
    expect(listCostCentres(db).map((c) => c.name)).toEqual(['Mumbai HQ'])
  })

  it('refuses to delete a cost centre with posted allocations, but deleting an unused one works', () => {
    const db = seededDb()
    const cc = saveCostCentre(db, { name: 'Mumbai Branch', parentId: null, active: true })
    const unused = saveCostCentre(db, { name: 'Unused', parentId: null, active: true })
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const expense = expenseLedger(db, 'Travel')

    journalVoucher(db, '2025-05-01', [
      { ledgerId: expense.id, drCr: 'dr', amount: 5000, costAllocations: [{ costCentreId: cc.id, amount: 5000 }] },
      { ledgerId: cash.id, drCr: 'cr', amount: 5000, costAllocations: [] }
    ])

    expect(() => deleteCostCentre(db, cc.id)).toThrow(/deactivate/i)
    expect(() => deleteCostCentre(db, unused.id)).not.toThrow()
    expect(listCostCentres(db).map((c) => c.name)).toEqual(['Mumbai Branch'])
  })

  it('deactivating (active: false) is allowed even with posted allocations', () => {
    const db = seededDb()
    const cc = saveCostCentre(db, { name: 'Mumbai Branch', parentId: null, active: true })
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const expense = expenseLedger(db, 'Travel')
    journalVoucher(db, '2025-05-01', [
      { ledgerId: expense.id, drCr: 'dr', amount: 5000, costAllocations: [{ costCentreId: cc.id, amount: 5000 }] },
      { ledgerId: cash.id, drCr: 'cr', amount: 5000, costAllocations: [] }
    ])
    const updated = saveCostCentre(db, { name: 'Mumbai Branch', parentId: null, active: false }, cc.id)
    expect(updated.active).toBe(false)
  })

  it('saveVoucher round-trip persists cost allocations, and replacing lines on update keeps them consistent', () => {
    const db = seededDb()
    const cc1 = saveCostCentre(db, { name: 'Mumbai Branch', parentId: null, active: true })
    const cc2 = saveCostCentre(db, { name: 'Pune Branch', parentId: null, active: true })
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const expense = expenseLedger(db, 'Travel')

    const saved = journalVoucher(db, '2025-05-01', [
      {
        ledgerId: expense.id, drCr: 'dr', amount: 10000,
        costAllocations: [
          { costCentreId: cc1.id, amount: 6000 },
          { costCentreId: cc2.id, amount: 4000 }
        ]
      },
      { ledgerId: cash.id, drCr: 'cr', amount: 10000, costAllocations: [] }
    ])

    const fetched = getVoucher(db, saved.id)!
    const expenseLine = fetched.lines.find((l) => l.ledgerId === expense.id)!
    expect(expenseLine.costAllocations).toHaveLength(2)
    expect(expenseLine.costAllocations).toEqual(
      expect.arrayContaining([
        { costCentreId: cc1.id, amount: 6000 },
        { costCentreId: cc2.id, amount: 4000 }
      ])
    )

    // Editing the voucher to drop one allocation must not leave the old one dangling — lines are
    // fully replaced on update, and voucher_line_cost_allocations cascades off voucher_lines.
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
    saveVoucher(
      db,
      {
        voucherTypeId: vt.id, date: '2025-05-01', number: fetched.number, partyLedgerId: null, narration: null,
        reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
        transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: expense.id, drCr: 'dr', amount: 10000, costAllocations: [{ costCentreId: cc1.id, amount: 10000 }] },
          { ledgerId: cash.id, drCr: 'cr', amount: 10000, costAllocations: [] }
        ],
        inventory: [], billRefs: [], tds: null
      },
      saved.id
    )

    const refetched = getVoucher(db, saved.id)!
    const refExpenseLine = refetched.lines.find((l) => l.ledgerId === expense.id)!
    expect(refExpenseLine.costAllocations).toEqual([{ costCentreId: cc1.id, amount: 10000 }])

    const orphaned = db.prepare('SELECT COUNT(*) AS n FROM voucher_line_cost_allocations WHERE cost_centre_id = ?').get(cc2.id) as { n: number }
    expect(orphaned.n).toBe(0)
  })

  it('ccReport sums expense (dr) and income (cr) allocations, and net = income - expense', () => {
    const db = seededDb()
    const cc = saveCostCentre(db, { name: 'Mumbai Branch', parentId: null, active: true })
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const expense = expenseLedger(db, 'Travel')
    const income = incomeLedger(db, 'Consulting Income')

    journalVoucher(db, '2025-05-01', [
      { ledgerId: expense.id, drCr: 'dr', amount: 3000, costAllocations: [{ costCentreId: cc.id, amount: 3000 }] },
      { ledgerId: cash.id, drCr: 'cr', amount: 3000, costAllocations: [] }
    ])
    journalVoucher(db, '2025-05-10', [
      { ledgerId: cash.id, drCr: 'dr', amount: 8000, costAllocations: [] },
      { ledgerId: income.id, drCr: 'cr', amount: 8000, costAllocations: [{ costCentreId: cc.id, amount: 8000 }] }
    ])

    const report = ccReport(db, '2025-04-01', '2025-06-30')
    const row = report.find((r) => r.costCentreId === cc.id)!
    expect(row.expense).toBe(3000)
    expect(row.income).toBe(8000)
    expect(row.net).toBe(5000)
  })

  it('nets a reversal-direction allocation instead of dropping it (credit against an expense ledger reduces expense)', () => {
    const db = seededDb()
    const cc = saveCostCentre(db, { name: 'CC-A', parentId: null, active: true })
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const expense = expenseLedger(db, 'Travel')

    // Original expense: dr Travel 10000, allocated to CC-A.
    journalVoucher(db, '2025-05-01', [
      { ledgerId: expense.id, drCr: 'dr', amount: 10000, costAllocations: [{ costCentreId: cc.id, amount: 10000 }] },
      { ledgerId: cash.id, drCr: 'cr', amount: 10000, costAllocations: [] }
    ])
    // Partial reversal (e.g. a refund/credit note): cr Travel 3000, allocated to CC-A. Without
    // netting, this line was silently dropped by the old nature/drCr filter.
    journalVoucher(db, '2025-05-15', [
      { ledgerId: cash.id, drCr: 'dr', amount: 3000, costAllocations: [] },
      { ledgerId: expense.id, drCr: 'cr', amount: 3000, costAllocations: [{ costCentreId: cc.id, amount: 3000 }] }
    ])

    const report = ccReport(db, '2025-04-01', '2025-06-30')
    const row = report.find((r) => r.costCentreId === cc.id)!
    expect(row.expense).toBe(7000) // 10000 - 3000
    expect(row.income).toBe(0)
    expect(row.net).toBe(-7000)
  })

  it('ccStatement drills into every allocation posted to one cost centre', () => {
    const db = seededDb()
    const cc = saveCostCentre(db, { name: 'Mumbai Branch', parentId: null, active: true })
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const expense = expenseLedger(db, 'Travel')
    journalVoucher(db, '2025-05-01', [
      { ledgerId: expense.id, drCr: 'dr', amount: 3000, costAllocations: [{ costCentreId: cc.id, amount: 3000 }] },
      { ledgerId: cash.id, drCr: 'cr', amount: 3000, costAllocations: [] }
    ])

    const rows = ccStatement(db, cc.id, '2025-04-01', '2025-06-30')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ledgerName: 'Travel', drCr: 'dr', amount: 3000, date: '2025-05-01' })
  })

  it('excludes optional (memorandum) and unmatured post-dated vouchers from ccReport and ccStatement (IN_BOOKS)', () => {
    const db = seededDb()
    const cc = saveCostCentre(db, { name: 'Delhi', parentId: null, active: true })
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const expense = expenseLedger(db, 'Travel')

    // Real in-books expense: ₹50 allocated to Delhi.
    journalVoucher(db, '2025-05-01', [
      { ledgerId: expense.id, drCr: 'dr', amount: 5000, costAllocations: [{ costCentreId: cc.id, amount: 5000 }] },
      { ledgerId: cash.id, drCr: 'cr', amount: 5000, costAllocations: [] }
    ])
    // Optional (memorandum) expense of ₹100 — out of the books, must not appear.
    journalVoucher(db, '2025-05-05', [
      { ledgerId: expense.id, drCr: 'dr', amount: 10000, costAllocations: [{ costCentreId: cc.id, amount: 10000 }] },
      { ledgerId: cash.id, drCr: 'cr', amount: 10000, costAllocations: [] }
    ], { isOptional: true })
    // Unmatured post-dated expense of ₹70 — out of the books until it matures.
    journalVoucher(db, '2025-05-10', [
      { ledgerId: expense.id, drCr: 'dr', amount: 7000, costAllocations: [{ costCentreId: cc.id, amount: 7000 }] },
      { ledgerId: cash.id, drCr: 'cr', amount: 7000, costAllocations: [] }
    ], { postDated: true })

    const report = ccReport(db, '2025-04-01', '2025-06-30')
    const row = report.find((r) => r.costCentreId === cc.id)!
    // Ties to the P&L's ₹50 expense for the period — not ₹220.
    expect(row.expense).toBe(5000)
    expect(row.net).toBe(-5000)

    const stmt = ccStatement(db, cc.id, '2025-04-01', '2025-06-30')
    expect(stmt).toHaveLength(1)
    expect(stmt[0]).toMatchObject({ amount: 5000, date: '2025-05-01' })
  })
})

describe('party default cost centre (migration 33)', () => {
  it('round-trips on the ledger, and survives an update that does not mention it', () => {
    const db = seededDb()
    const cc = saveCostCentre(db, { name: 'Mumbai branch', parentId: null, active: true })
    const groupId = (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id
    const party = createLedger(db, { name: 'Acme Ltd', groupId, openingBalance: 0, defaultCostCentreId: cc.id })
    expect(party.defaultCostCentreId).toBe(cc.id)

    // The ledger form sends the whole record, but importers and the AI bridge send partials —
    // an update that says nothing about the default must not silently clear it.
    const renamed = updateLedger(db, party.id, { name: 'Acme Limited', groupId, openingBalance: 0 })
    expect(renamed.defaultCostCentreId).toBe(cc.id)

    const cleared = updateLedger(db, party.id, {
      name: 'Acme Limited', groupId, openingBalance: 0, defaultCostCentreId: null
    })
    expect(cleared.defaultCostCentreId).toBeNull()
  })

  it('defaults to null, so every ledger that predates the column keeps no opinion', () => {
    const db = seededDb()
    const cash = db.prepare("SELECT default_cost_centre_id AS cc FROM ledgers WHERE name = 'Cash'").get() as {
      cc: number | null
    }
    expect(cash.cc).toBeNull()
  })
})
