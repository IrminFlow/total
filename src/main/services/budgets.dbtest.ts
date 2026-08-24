import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createGroup, createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { listBudgets, saveBudget, deleteBudget, budgetVarianceReport } from './budgets'
import { saveCostCentre } from './costCentres'
import type { VoucherInputParsed } from '@shared/schemas'

function expenseLedger(db: ReturnType<typeof seededDb>, name: string, groupId: number) {
  return createLedger(db, {
    name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
}

function journalVoucher(
  db: ReturnType<typeof seededDb>,
  date: string,
  lines: VoucherInputParsed['lines'],
  flags: { postDated?: boolean; isOptional?: boolean } = {}
) {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, number: undefined, partyLedgerId: null, narration: null, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null, ...flags, lines, inventory: [], billRefs: [], tds: null
  })
}

describe('budgets', () => {
  it('saves a budget with lines and replaces them wholesale on update', () => {
    const db = seededDb()
    const directExpenses = db.prepare("SELECT id FROM groups WHERE name = 'Direct Expenses'").get() as { id: number }
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const travel = expenseLedger(db, 'Travel', directExpenses.id)

    const created = saveBudget(db, {
      name: 'FY26 Budget',
      fyStartYear: 2025,
      lines: [
        { ledgerId: travel.id, groupId: null, month: '2025-04', amount: 500000 },
        { ledgerId: null, groupId: directExpenses.id, month: null, amount: 2000000 }
      ]
    })
    expect(created.lines).toHaveLength(2)
    expect(listBudgets(db).map((b) => b.name)).toEqual(['FY26 Budget'])

    // Replace with a single, different line — the old two must not linger.
    const updated = saveBudget(
      db,
      { name: 'FY26 Budget', fyStartYear: 2025, lines: [{ ledgerId: cash.id, groupId: null, month: null, amount: 100000 }] },
      created.id
    )
    expect(updated.id).toBe(created.id)
    expect(updated.lines).toHaveLength(1)
    expect(updated.lines[0]).toMatchObject({ ledgerId: cash.id, groupId: null, month: null, amount: 100000 })

    const orphaned = db.prepare('SELECT COUNT(*) AS n FROM budget_lines WHERE budget_id = ?').get(created.id) as { n: number }
    expect(orphaned.n).toBe(1)
  })

  it('deletes a budget and cascades its lines', () => {
    const db = seededDb()
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const created = saveBudget(db, {
      name: 'To Delete',
      fyStartYear: 2025,
      lines: [{ ledgerId: cash.id, groupId: null, month: null, amount: 1000 }]
    })
    deleteBudget(db, created.id)
    expect(listBudgets(db)).toEqual([])
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM budget_lines WHERE budget_id = ?').get(created.id) as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('budgetVarianceReport: monthly line matches its exact month, annual line is FY-to-date, and a group line rolls up its children', () => {
    const db = seededDb()
    const directExpenses = db.prepare("SELECT id FROM groups WHERE name = 'Direct Expenses'").get() as { id: number }
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }

    // Two sub-groups under Direct Expenses, one ledger each — actuals posted across two months.
    const travelGroup = createGroup(db, { name: 'Travel Costs', parentId: directExpenses.id })
    const officeGroup = createGroup(db, { name: 'Office Costs', parentId: directExpenses.id })
    const travel = expenseLedger(db, 'Travel', travelGroup.id)
    const office = expenseLedger(db, 'Office Supplies', officeGroup.id)

    journalVoucher(db, '2025-04-10', [
      { ledgerId: travel.id, drCr: 'dr', amount: 300000, costAllocations: [] },
      { ledgerId: cash.id, drCr: 'cr', amount: 300000, costAllocations: [] }
    ])
    journalVoucher(db, '2025-05-12', [
      { ledgerId: travel.id, drCr: 'dr', amount: 200000, costAllocations: [] },
      { ledgerId: cash.id, drCr: 'cr', amount: 200000, costAllocations: [] }
    ])
    journalVoucher(db, '2025-04-15', [
      { ledgerId: office.id, drCr: 'dr', amount: 100000, costAllocations: [] },
      { ledgerId: cash.id, drCr: 'cr', amount: 100000, costAllocations: [] }
    ])
    // Outside the FY-to-date window we'll query (upToMonth '2025-05') — must not leak into the
    // annual line's actual.
    journalVoucher(db, '2025-06-01', [
      { ledgerId: travel.id, drCr: 'dr', amount: 999999, costAllocations: [] },
      { ledgerId: cash.id, drCr: 'cr', amount: 999999, costAllocations: [] }
    ])

    const budget = saveBudget(db, {
      name: 'FY26 Budget',
      fyStartYear: 2025,
      lines: [
        { ledgerId: travel.id, groupId: null, month: '2025-04', amount: 250000 }, // monthly: April only
        { ledgerId: travel.id, groupId: null, month: null, amount: 600000 }, // annual: FY-to-date
        { ledgerId: null, groupId: directExpenses.id, month: null, amount: 700000 } // group rollup, annual
      ]
    })

    const report = budgetVarianceReport(db, budget.id, '2025-05')
    expect(report).toHaveLength(3)

    const monthly = report[0]!
    expect(monthly).toMatchObject({ targetName: 'Travel', month: '2025-04', budget: 250000, actual: 300000, variance: 50000, pct: 120 })

    const annualTravel = report[1]!
    // FY-to-date through 2025-05: April 300000 + May 200000 = 500000 (June's 999999 excluded).
    expect(annualTravel).toMatchObject({ targetName: 'Travel', month: null, budget: 600000, actual: 500000, variance: -100000 })

    const groupLine = report[2]!
    // Direct Expenses rollup: Travel (300000 + 200000) + Office (100000) = 600000, June excluded.
    expect(groupLine).toMatchObject({ targetName: 'Direct Expenses', month: null, budget: 700000, actual: 600000, variance: -100000 })
  })

  it('excludes optional (memorandum) and unmatured post-dated vouchers from actuals (IN_BOOKS)', () => {
    const db = seededDb()
    const directExpenses = db.prepare("SELECT id FROM groups WHERE name = 'Direct Expenses'").get() as { id: number }
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const travel = expenseLedger(db, 'Travel', directExpenses.id)

    // Real in-books expense: ₹1,000.
    journalVoucher(db, '2025-04-10', [
      { ledgerId: travel.id, drCr: 'dr', amount: 100000, costAllocations: [] },
      { ledgerId: cash.id, drCr: 'cr', amount: 100000, costAllocations: [] }
    ])
    // Optional (memorandum) expense — out of the books, must not inflate actuals.
    journalVoucher(db, '2025-04-12', [
      { ledgerId: travel.id, drCr: 'dr', amount: 40000, costAllocations: [] },
      { ledgerId: cash.id, drCr: 'cr', amount: 40000, costAllocations: [] }
    ], { isOptional: true })
    // Unmatured post-dated expense — out of the books until it matures.
    journalVoucher(db, '2025-04-20', [
      { ledgerId: travel.id, drCr: 'dr', amount: 30000, costAllocations: [] },
      { ledgerId: cash.id, drCr: 'cr', amount: 30000, costAllocations: [] }
    ], { postDated: true })

    const budget = saveBudget(db, {
      name: 'IN_BOOKS Budget', fyStartYear: 2025,
      lines: [{ ledgerId: travel.id, groupId: null, month: '2025-04', amount: 200000 }]
    })
    const report = budgetVarianceReport(db, budget.id, '2025-04')
    // Actual ties to the P&L's ₹1,000 — not the ₹1,700 that would include out-of-books entries.
    expect(report[0]).toMatchObject({ actual: 100000, variance: -100000 })
  })

  it('a line with no matching postings reports zero actual (pct null stays covered by the shared budgetVariance unit tests)', () => {
    const db = seededDb()
    const directExpenses = db.prepare("SELECT id FROM groups WHERE name = 'Direct Expenses'").get() as { id: number }
    const travel = expenseLedger(db, 'Travel', directExpenses.id)
    const budget = saveBudget(db, {
      name: 'Untouched Budget',
      fyStartYear: 2025,
      lines: [{ ledgerId: travel.id, groupId: null, month: '2025-04', amount: 100000 }]
    })
    const report = budgetVarianceReport(db, budget.id, '2025-04')
    expect(report[0]).toMatchObject({ actual: 0, variance: -100000, pct: 0 })
  })

  it('budgets a parent operational dimension and rolls up project or branch children',()=>{
    const db=seededDb();const directExpenses=db.prepare("SELECT id FROM groups WHERE name='Direct Expenses'").get() as {id:number};const cash=db.prepare("SELECT id FROM ledgers WHERE name='Cash'").get() as {id:number};const travel=expenseLedger(db,'Project travel',directExpenses.id);const branch=saveCostCentre(db,{name:'West region',parentId:null,active:true});const project=saveCostCentre(db,{name:'Pune launch',parentId:branch.id,active:true})
    journalVoucher(db,'2025-04-10',[{ledgerId:travel.id,drCr:'dr',amount:125000,costAllocations:[{costCentreId:project.id,amount:125000}]},{ledgerId:cash.id,drCr:'cr',amount:125000,costAllocations:[]}])
    const budget=saveBudget(db,{name:'Branch budget',fyStartYear:2025,lines:[{ledgerId:null,groupId:null,costCentreId:branch.id,month:'2025-04',amount:150000}]})
    expect(budgetVarianceReport(db,budget.id,'2025-04')[0]).toMatchObject({targetName:'West region',actual:125000,variance:-25000})
  })
})
