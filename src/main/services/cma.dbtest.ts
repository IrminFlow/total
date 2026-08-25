import { describe, it, expect } from 'vitest'
import type { CompanyInfo } from '@shared/domain'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import { profitAndLoss } from './reports'
import { saveLoan } from './borrowing'
import { computeStockStatement } from './borrowing'
import {
  cmaBookFigures,
  cmaColumnSpecs,
  cmaPackView,
  deleteCmaFacility,
  deleteCmaPack,
  listCmaFacilities,
  listCmaPacks,
  prefillCmaColumn,
  saveCmaFacility,
  saveCmaPack,
  setCmaInput
} from './cma'

type Db = ReturnType<typeof seededDb>

const LEDGER_DEFAULTS = {
  openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

const groupId = (db: Db, name: string): number =>
  (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id

const vt = (db: Db, kind: string): number =>
  (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

/** The seeded chart already carries Cash and one or two others; reuse rather than collide. */
const ledger = (db: Db, name: string, group: string, opening = 0): number => {
  const existing = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined
  if (existing) {
    db.prepare('UPDATE ledgers SET opening_balance = ? WHERE id = ?').run(opening, existing.id)
    return existing.id
  }
  return createLedger(db, { ...LEDGER_DEFAULTS, name, groupId: groupId(db, group), openingBalance: opening }).id
}

/** Books that open in FY 2024-25, so FY 2024-25 and FY 2025-26 are both fully covered. */
const INFO: CompanyInfo = { ...TEST_INFO, booksFrom: 2024 }

/**
 * A small trading year: an opening stock purchase, sales to two buyers, an overdraft, a term
 * loan, and a handful of expenses across the standard groups.
 */
function tradingBooks(): { db: Db; buyer: number; supplier: number } {
  const db = seededDb()
  // The seeded chart already carries the default units; creating one again collides.
  const unit = (db.prepare("SELECT id FROM units WHERE name = 'Numbers'").get() as { id: number }).id
  const widget = createStockItem(db, {
    name: 'Widget', groupId: null, unitId: unit, hsn: '8471', gstRate: 18, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, reorderLevelMilli: null, barcode: null
  }).id

  const buyer = ledger(db, 'Buyer Ltd', 'Sundry Debtors')
  const supplier = ledger(db, 'Supplier Ltd', 'Sundry Creditors')
  const purchases = ledger(db, 'Purchase A/c', 'Purchase Accounts')
  const sales = ledger(db, 'Sales A/c', 'Sales Accounts')
  const wages = ledger(db, 'Factory Wages', 'Direct Expenses')
  const rent = ledger(db, 'Office Rent', 'Indirect Expenses')
  const depreciation = ledger(db, 'Depreciation', 'Indirect Expenses')
  const cash = ledger(db, 'Cash', 'Cash-in-Hand', 2_00_000_00)
  ledger(db, 'Bank OD', 'Bank OD A/c', -8_00_000_00)
  ledger(db, 'Capital', 'Capital Account', -20_00_000_00)
  ledger(db, 'Plant', 'Fixed Assets', 25_00_000_00)

  const buy = (date: string, amount: number, qtyMilli: number): void => {
    saveVoucher(db, {
      voucherTypeId: vt(db, 'purchase'), date, partyLedgerId: supplier,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: purchases, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: supplier, drCr: 'cr', amount, costAllocations: [] }
      ],
      inventory: [{ stockItemId: widget, godownId: null, qtyMilli, ratePaise: Math.round((amount * 1000) / qtyMilli), amount, direction: 'in' }],
      billRefs: [], tds: null
    })
  }
  const sell = (date: string, amount: number, qtyMilli: number): void => {
    saveVoucher(db, {
      voucherTypeId: vt(db, 'sales'), date, partyLedgerId: buyer,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: buyer, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount, costAllocations: [] }
      ],
      inventory: [{ stockItemId: widget, godownId: null, qtyMilli, ratePaise: Math.round((amount * 1000) / qtyMilli), amount, direction: 'out' }],
      billRefs: [], tds: null
    })
  }
  const expense = (date: string, ledgerId: number, amount: number): void => {
    saveVoucher(db, {
      voucherTypeId: vt(db, 'journal'), date, partyLedgerId: null,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: cash, drCr: 'cr', amount, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
  }

  // FY 2024-25
  buy('2024-05-10', 10_00_000_00, 1000_000)
  sell('2024-09-15', 14_00_000_00, 600_000)
  expense('2024-11-01', wages, 1_00_000_00)
  expense('2024-12-01', rent, 60_000_00)
  expense('2025-03-20', depreciation, 2_50_000_00)
  // FY 2025-26
  buy('2025-06-10', 8_00_000_00, 800_000)
  sell('2025-08-15', 12_00_000_00, 500_000)
  sell('2026-02-20', 3_00_000_00, 100_000)
  expense('2025-11-01', wages, 1_20_000_00)
  expense('2026-01-01', rent, 60_000_00)
  expense('2026-03-20', depreciation, 2_50_000_00)

  return { db, buyer, supplier }
}

const newPack = (db: Db, estimateFy = 2026): number =>
  saveCmaPack(db, { name: 'Renewal 2026', estimateFyStartYear: estimateFy, notes: null }).id

const lineValue = (view: ReturnType<typeof cmaPackView>, form: string, key: string, col: number) =>
  view.forms.find((f) => f.id === form)!.lines.find((l) => l.key === key)!.cells[col]!

describe('the columns a CMA pack covers', () => {
  it('counts two audited years back and two projections forward from the estimate', () => {
    const specs = cmaColumnSpecs(INFO, 2026)
    expect(specs.map((s) => s.fyStartYear)).toEqual([2024, 2025, 2026, 2027, 2028])
    expect(specs.map((s) => s.from)).toEqual(['2024-04-01', '2025-04-01', '2026-04-01', '2027-04-01', '2028-04-01'])
  })

  it('marks an audited year the books do not reach as uncovered, not as nil', () => {
    // Books that opened in 2025-26 cannot speak for 2024-25.
    const specs = cmaColumnSpecs({ ...INFO, booksFrom: 2025 }, 2026)
    expect(specs.find((s) => s.key === 'a2')!.booksCover).toBe(false)
    expect(specs.find((s) => s.key === 'a1')!.booksCover).toBe(true)
  })

  it('treats a year the books only half cover as uncovered', () => {
    // A partial year presented as audited is worse than a blank one: it looks like a bad year.
    const specs = cmaColumnSpecs({ ...INFO, booksFrom: 2026 }, 2026)
    expect(specs.filter((s) => s.booksCover)).toHaveLength(0)
  })
})

describe('reading an audited year out of the books', () => {
  it('ties Form II profit before tax to the P&L for the same period', () => {
    const { db } = tradingBooks()
    const f = cmaBookFigures(db, '2025-04-01', '2026-03-31')
    const pnl = profitAndLoss(db, '2025-04-01', '2026-03-31')
    const pbt =
      f.netSales + f.otherOperatingIncome + f.otherIncome + f.closingStock - f.openingStock -
      f.rawMaterials - f.directWages - f.powerAndFuel - f.otherManufacturingExpenses - f.depreciation -
      f.sellingExpenses - f.administrativeExpenses - f.otherIndirectExpenses - f.interest
    // The pack's operating statement and the app's own P&L are two views of one set of vouchers.
    // If they ever disagree the pack is the one the bank will disbelieve.
    expect(pbt - f.taxProvision).toBe(pnl.netProfit)
  })

  it('puts depreciation and wages on their own lines rather than in a residue', () => {
    const { db } = tradingBooks()
    const f = cmaBookFigures(db, '2025-04-01', '2026-03-31')
    expect(f.depreciation).toBe(2_50_000_00)
    expect(f.directWages).toBe(1_20_000_00)
    expect(f.administrativeExpenses).toBe(60_000_00)
  })

  it('classifies the same working capital the stock statement does', () => {
    const { db } = tradingBooks()
    const f = cmaBookFigures(db, '2025-04-01', '2026-03-31')
    // #372's statement and #371's Form III read one borrower. Different published cut-offs, one
    // set of figures — the stock and the creditors have to be identical to the paisa.
    const statement = computeStockStatement(db, '2026-03-31')
    expect(f.inventory).toBe(statement.stockPaise)
    expect(f.sundryCreditors).toBe(statement.creditorsPaise)
    expect(f.bankBorrowingShortTerm).toBe(statement.utilisedPaise)
    // Book debts add up to the same total even though the split point differs (six months here,
    // the bank's ninety days there).
    expect(f.receivablesWithinSixMonths + f.receivablesOverSixMonths).toBe(
      statement.eligibleDebtorsPaise + statement.ineligibleDebtorsPaise
    )
  })

  it('reports nil everywhere for a year with no transactions rather than throwing', () => {
    const { db } = tradingBooks()
    const f = cmaBookFigures(db, '2028-04-01', '2029-03-31')
    expect(f.netSales).toBe(0)
    expect(f.rawMaterials).toBe(0)
    // The position lines are as-at figures, so they still carry the balances that existed then.
    expect(f.inventory).toBeGreaterThanOrEqual(0)
  })

  it('takes term-loan interest and instalments off the loan register for DSCR', () => {
    const { db } = tradingBooks()
    saveLoan(db, {
      name: 'Machine loan', principalPaise: 6_00_000_00, annualRateBp: 1200, months: 36,
      disbursedOn: '2025-04-01', firstInstalmentDate: '2025-05-10'
    })
    const f = cmaBookFigures(db, '2025-04-01', '2026-03-31')
    expect(f.termLoanInterest).toBeGreaterThan(0)
    expect(f.termLoanInstalments).toBeGreaterThan(0)
    // The year's principal repayments plus what is due in the following twelve months are two
    // different questions; Form III wants the second.
    expect(f.currentInstalmentsOfTermLoans).toBeGreaterThan(0)
  })

  it('ignores a working-capital facility when computing debt service', () => {
    const { db } = tradingBooks()
    saveLoan(db, {
      name: 'CC limit', kind: 'working_capital', principalPaise: 6_00_000_00, annualRateBp: 1200,
      months: 36, disbursedOn: '2025-04-01', firstInstalmentDate: '2025-05-10'
    })
    const f = cmaBookFigures(db, '2025-04-01', '2026-03-31')
    // A cash-credit limit has no instalment to service, so including it would depress DSCR
    // against a repayment nobody is contractually making.
    expect(f.termLoanInstalments).toBe(0)
  })
})

describe('the pack a bank is handed', () => {
  it('computes the audited columns and leaves the estimate and projections blank', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    const view = cmaPackView(db, id, INFO)
    expect(view.columns.map((c) => c.state)).toEqual(['books', 'books', 'empty', 'empty', 'empty'])
    expect(lineValue(view, 'II', 'ii_net_sales_total', 1).source).toBe('books')
    expect(lineValue(view, 'II', 'ii_net_sales_total', 2).value).toBeNull()
  })

  it('warns, in words, about every column that has nothing behind it', () => {
    const { db } = tradingBooks()
    const view = cmaPackView(db, newPack(db), INFO)
    expect(view.warnings).toHaveLength(3)
    expect(view.warnings[0]).toContain('FY 2026-27')
  })

  it('says plainly when an audited year predates the books', () => {
    const { db } = tradingBooks()
    const view = cmaPackView(db, newPack(db), { ...INFO, booksFrom: 2025 })
    // The silent-zeros failure this exists to prevent: the column is not computed, it is called
    // out, and the user is told to key it off that year's accounts.
    expect(view.columns[0]!.state).toBe('empty')
    expect(view.warnings.some((w) => w.includes('the books do not cover'))).toBe(true)
  })

  it('stores a typed figure and marks the column as the borrower’s own claim', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    setCmaInput(db, id, 'e', 'ii_net_sales_total', 20_00_000_00)
    const view = cmaPackView(db, id, INFO)
    expect(view.columns[2]!.state).toBe('typed')
    expect(lineValue(view, 'II', 'ii_net_sales_total', 2)).toEqual({ value: 20_00_000_00, source: 'typed' })
  })

  it('clears a cell back to blank rather than to zero', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    setCmaInput(db, id, 'p1', 'iii_inventory', 5_00_000_00)
    setCmaInput(db, id, 'p1', 'iii_inventory', null)
    expect(cmaPackView(db, id, INFO).columns[3]!.state).toBe('empty')
  })

  it('refuses a line key that is not in the catalogue', () => {
    const { db } = tradingBooks()
    expect(() => setCmaInput(db, newPack(db), 'e', 'ii_invented', 1)).toThrow('Unknown CMA line')
  })

  it('recomputes the audited columns rather than storing them', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    const before = lineValue(cmaPackView(db, id, INFO), 'II', 'ii_net_sales_total', 1).value!
    // A back-dated sale into the audited year must move the pack, because the bank's own
    // verification will be run against the ledgers and not against a snapshot.
    const buyer = (db.prepare("SELECT id FROM ledgers WHERE name = 'Buyer Ltd'").get() as { id: number }).id
    const sales = (db.prepare("SELECT id FROM ledgers WHERE name = 'Sales A/c'").get() as { id: number }).id
    saveVoucher(db, {
      voucherTypeId: vt(db, 'sales'), date: '2026-03-30', partyLedgerId: buyer,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: buyer, drCr: 'dr', amount: 1_00_000_00, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 1_00_000_00, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    expect(lineValue(cmaPackView(db, id, INFO), 'II', 'ii_net_sales_total', 1).value).toBe(before + 1_00_000_00)
  })

  it('excludes a deleted voucher from the audited columns', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    const before = lineValue(cmaPackView(db, id, INFO), 'II', 'ii_net_sales_total', 1).value!
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE date = '2026-02-20'").run()
    expect(lineValue(cmaPackView(db, id, INFO), 'II', 'ii_net_sales_total', 1).value).toBe(before - 3_00_000_00)
  })
})

describe('starting a projection from a year that exists', () => {
  it('copies the figures in as the user’s own, not as book figures', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    const copied = prefillCmaColumn(db, id, 'a1', 'e', INFO)
    expect(copied).toBeGreaterThan(0)
    const view = cmaPackView(db, id, INFO)
    expect(view.columns[2]!.state).toBe('typed')
    expect(lineValue(view, 'II', 'ii_net_sales_total', 2).source).toBe('typed')
    expect(lineValue(view, 'II', 'ii_net_sales_total', 2).value).toBe(
      lineValue(view, 'II', 'ii_net_sales_total', 1).value
    )
  })

  it('will not copy from a column that has nothing in it', () => {
    const { db } = tradingBooks()
    expect(() => prefillCmaColumn(db, newPack(db), 'p2', 'p1', INFO)).toThrow('no figures')
  })

  it('will not copy a column on to itself', () => {
    const { db } = tradingBooks()
    expect(() => prefillCmaColumn(db, newPack(db), 'a1', 'a1', INFO)).toThrow('itself')
  })
})

describe('Form I — the facilities', () => {
  it('reads an outstanding off the books when a ledger is linked', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    const od = (db.prepare("SELECT id FROM ledgers WHERE name = 'Bank OD'").get() as { id: number }).id
    saveCmaFacility(db, id, {
      facility: 'Cash credit', existingLimitPaise: 20_00_000_00, proposedLimitPaise: 30_00_000_00,
      outstandingPaise: 99_99_999_99, ledgerId: od, security: 'Hypothecation of stock', notes: null, seq: 0
    })
    const rows = listCmaFacilities(db, id, '2026-03-31')
    expect(rows[0]!.outstandingFromBooks).toBe(true)
    // The typed figure is ignored, not stored — a facility pointed at a ledger reports what the
    // ledger says today, not what somebody keyed months ago.
    expect(rows[0]!.outstandingPaise).toBe(8_00_000_00)
  })

  it('keeps a typed outstanding when there is no ledger to ask', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    saveCmaFacility(db, id, {
      facility: 'Bank guarantee', existingLimitPaise: 5_00_000_00, proposedLimitPaise: 5_00_000_00,
      outstandingPaise: 1_50_000_00, ledgerId: null, security: null, notes: null, seq: 1
    })
    const rows = listCmaFacilities(db, id, '2026-03-31')
    expect(rows[0]!.outstandingFromBooks).toBe(false)
    expect(rows[0]!.outstandingPaise).toBe(1_50_000_00)
  })

  it('totals the limits across the facilities', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    saveCmaFacility(db, id, { facility: 'CC', existingLimitPaise: 20_00_000_00, proposedLimitPaise: 30_00_000_00, outstandingPaise: 0, ledgerId: null, security: null, notes: null, seq: 0 })
    saveCmaFacility(db, id, { facility: 'TL', existingLimitPaise: 6_00_000_00, proposedLimitPaise: 6_00_000_00, outstandingPaise: 0, ledgerId: null, security: null, notes: null, seq: 1 })
    expect(cmaPackView(db, id, INFO).facilityTotals.proposedLimitPaise).toBe(36_00_000_00)
  })

  it('deletes a facility without touching the pack', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    const fid = saveCmaFacility(db, id, { facility: 'CC', existingLimitPaise: 1, proposedLimitPaise: 1, outstandingPaise: 0, ledgerId: null, security: null, notes: null, seq: 0 })
    deleteCmaFacility(db, fid)
    expect(listCmaFacilities(db, id, '2026-03-31')).toHaveLength(0)
    expect(listCmaPacks(db)).toHaveLength(1)
  })
})

describe('the pack register', () => {
  it('lists, renames and deletes', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    saveCmaPack(db, { name: 'Enhancement 2027', estimateFyStartYear: 2027, notes: 'for HDFC' }, id)
    expect(listCmaPacks(db)[0]!.name).toBe('Enhancement 2027')
    deleteCmaPack(db, id)
    expect(listCmaPacks(db)).toHaveLength(0)
  })

  it('takes its typed cells and its facilities with it when deleted', () => {
    const { db } = tradingBooks()
    const id = newPack(db)
    setCmaInput(db, id, 'e', 'iii_inventory', 1_00_000_00)
    saveCmaFacility(db, id, { facility: 'CC', existingLimitPaise: 1, proposedLimitPaise: 1, outstandingPaise: 0, ledgerId: null, security: null, notes: null, seq: 0 })
    deleteCmaPack(db, id)
    expect((db.prepare('SELECT COUNT(*) AS n FROM cma_inputs').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM cma_facilities').get() as { n: number }).n).toBe(0)
  })

  it('refuses to open a pack that is not there', () => {
    const { db } = tradingBooks()
    expect(() => cmaPackView(db, 999, INFO)).toThrow('No such CMA pack')
  })
})
