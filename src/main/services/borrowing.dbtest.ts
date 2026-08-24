import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, createStockItem, createUnit } from './masters'
import { saveVoucher } from './vouchers'
import {
  addCost,
  capitalisationDraft,
  computeStockStatement,
  deleteLoan,
  depositSummary,
  fileStockStatement,
  instalmentDraft,
  listFiledStatements,
  listPrepaid,
  loanView,
  prepaidDraft,
  recordCapitalisation,
  recordInstalment,
  recordPrepaidPosting,
  returnDeposit,
  saveDeposit,
  saveLoan,
  savePrepaid,
  saveProject
} from './borrowing'

type Db = ReturnType<typeof seededDb>

const LEDGER_DEFAULTS = {
  openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

const groupId = (db: Db, name: string): number =>
  (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id

const TERMS = {
  name: 'Tata Ace',
  principalPaise: 5_00_000_00,
  annualRateBp: 1200,
  months: 24,
  disbursedOn: '2026-04-01',
  firstInstalmentDate: '2026-05-10'
}

describe('the loan register', () => {
  it('refuses terms that never amortise, at entry rather than at the first posting', () => {
    const db = seededDb()
    expect(() => saveLoan(db, { ...TERMS, emiPaise: 1_000_00 })).toThrow('never repays')
  })

  it('splits the EMI, and the loan account takes the principal only', () => {
    const db = seededDb()
    const loan = saveLoan(db, TERMS)
    const draft = instalmentDraft(db, loan.id, 1)
    const principal = draft.lines.find((l) => l.group === 'Secured Loans')!
    const interest = draft.lines.find((l) => l.group === 'Indirect Expenses')!
    const bank = draft.lines.find((l) => l.group === 'Bank Accounts')!
    expect(interest.amount).toBe(5_000_00)
    expect(principal.amount + interest.amount).toBe(bank.amount)
    expect(bank.drCr).toBe('cr')
  })

  it('drafts and posts nothing by itself', () => {
    const db = seededDb()
    const loan = saveLoan(db, TERMS)
    instalmentDraft(db, loan.id, 1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
  })

  it('will not book the same month twice', () => {
    const db = seededDb()
    const loan = saveLoan(db, TERMS)
    recordInstalment(db, loan.id, 1, null)
    expect(() => recordInstalment(db, loan.id, 1, null)).toThrow('already been posted')
    expect(() => instalmentDraft(db, loan.id, 1)).toThrow('already been posted')
  })

  it('says what is still owed, and which instalments are behind', () => {
    const db = seededDb()
    const loan = saveLoan(db, TERMS)
    const view = loanView(db, loan.id, '2026-07-31')
    expect(view.unposted).toHaveLength(3) // May, June, July
    expect(view.outstandingPaise).toBeLessThan(TERMS.principalPaise)
    expect(view.schedule.rows[23]!.closingPaise).toBe(0)
  })

  it('will not delete a loan with postings against it', () => {
    const db = seededDb()
    const loan = saveLoan(db, TERMS)
    recordInstalment(db, loan.id, 1, null)
    expect(() => deleteLoan(db, loan.id)).toThrow('close it instead')
  })
})

describe('the deposit register', () => {
  it('lists what is out, and what is overdue back', () => {
    const db = seededDb()
    saveDeposit(db, { direction: 'paid', counterparty: 'Landlord', amountPaise: 2_00_000_00, paidOn: '2024-04-01', refundableOn: '2026-03-31' })
    saveDeposit(db, { direction: 'received', counterparty: 'Distributor', amountPaise: 50_000_00, paidOn: '2025-04-01' })
    const summary = depositSummary(db, '2026-06-01')
    expect(summary.paidPaise).toBe(2_00_000_00)
    expect(summary.receivedPaise).toBe(50_000_00)
    expect(summary.overdue).toHaveLength(1)
  })

  it('flags one that has been out for years with no date on it', () => {
    const db = seededDb()
    saveDeposit(db, { direction: 'paid', counterparty: 'Electricity board', amountPaise: 10_000_00, paidOn: '2014-04-01' })
    expect(depositSummary(db, '2026-06-01').stale).toHaveLength(1)
  })

  it('comes back once, and only once', () => {
    const db = seededDb()
    const d = saveDeposit(db, { direction: 'paid', counterparty: 'Landlord', amountPaise: 1000, paidOn: '2024-04-01' })
    returnDeposit(db, d.id, '2026-04-01', 1000)
    expect(() => returnDeposit(db, d.id, '2026-05-01', 1000)).toThrow('came back on')
    expect(depositSummary(db, '2026-06-01').paidPaise).toBe(0)
  })
})

describe('capital work in progress', () => {
  it('accumulates costs and capitalises the lot on one date', () => {
    const db = seededDb()
    const project = saveProject(db, { name: 'New shed', startedOn: '2026-04-01' })
    addCost(db, project.id, { date: '2026-04-10', description: 'Steel', amountPaise: 3_00_000_00 })
    addCost(db, project.id, { date: '2026-05-10', description: 'Labour', amountPaise: 1_50_000_00 })

    const draft = capitalisationDraft(db, project.id, '2026-06-01', 'Factory Shed')
    expect(draft.total).toBe(4_50_000_00)
    expect(draft.lines.find((l) => l.drCr === 'dr')!.ledgerName).toBe('Factory Shed')
    expect(draft.lines.reduce((s, l) => s + (l.drCr === 'dr' ? l.amount : -l.amount), 0)).toBe(0)
  })

  it('settles the cost once capitalised — a later bill is somebody else’s problem', () => {
    const db = seededDb()
    const project = saveProject(db, { name: 'New shed', startedOn: '2026-04-01' })
    addCost(db, project.id, { date: '2026-04-10', description: 'Steel', amountPaise: 1000 })
    recordCapitalisation(db, project.id, '2026-06-01', null, null)
    expect(() => addCost(db, project.id, { date: '2026-07-01', description: 'Late bill', amountPaise: 100 })).toThrow('cost is settled')
    expect(() => capitalisationDraft(db, project.id, '2026-07-01', 'Shed')).toThrow('already capitalised')
  })

  it('refuses to capitalise a project nothing has been spent on', () => {
    const db = seededDb()
    const project = saveProject(db, { name: 'Idea', startedOn: '2026-04-01' })
    expect(() => capitalisationDraft(db, project.id, '2026-06-01', 'Shed')).toThrow('Nothing has been spent')
  })
})

describe('prepaid and accrued', () => {
  it('spreads a premium across the months it covers', () => {
    const db = seededDb()
    const s = savePrepaid(db, {
      kind: 'prepaid', name: 'Fire policy', amountPaise: 12_000_00,
      periodFrom: '2026-04-01', periodTo: '2027-03-31'
    })
    expect(s.rows).toHaveLength(12)
    expect(s.rows.reduce((t, r) => t + r.amountPaise, 0)).toBe(12_000_00)
  })

  it('knows what is due and what is still an asset', () => {
    const db = seededDb()
    savePrepaid(db, {
      kind: 'prepaid', name: 'Fire policy', amountPaise: 12_000_00,
      periodFrom: '2026-04-01', periodTo: '2027-03-31'
    })
    const s = listPrepaid(db, '2026-06-30')[0]!
    expect(s.duePaise).toBe(3_000_00)
    expect(s.unexpiredPaise).toBe(9_000_00)
  })

  it('drafts a month once, and refuses it a second time', () => {
    const db = seededDb()
    const s = savePrepaid(db, {
      kind: 'prepaid', name: 'Fire policy', amountPaise: 12_000_00,
      periodFrom: '2026-04-01', periodTo: '2027-03-31'
    })
    const draft = prepaidDraft(db, s.id, '2026-04')
    expect(draft.total).toBe(1_000_00)
    expect(draft.lines[0]!.drCr).toBe('dr')
    recordPrepaidPosting(db, s.id, '2026-04', null)
    expect(() => prepaidDraft(db, s.id, '2026-04')).toThrow('already been posted')
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
  })

  it('an accrual raises a liability where a prepayment releases an asset', () => {
    const db = seededDb()
    const s = savePrepaid(db, {
      kind: 'accrued', name: 'March rent', amountPaise: 30_000_00,
      periodFrom: '2027-03-01', periodTo: '2027-03-31'
    })
    expect(prepaidDraft(db, s.id, '2027-03').lines[1]!.group).toBe('Current Liabilities')
  })

  it('will not re-cut a schedule that has been part posted', () => {
    const db = seededDb()
    const s = savePrepaid(db, {
      kind: 'prepaid', name: 'Fire policy', amountPaise: 12_000_00,
      periodFrom: '2026-04-01', periodTo: '2027-03-31'
    })
    recordPrepaidPosting(db, s.id, '2026-04', null)
    expect(() =>
      savePrepaid(db, {
        kind: 'prepaid', name: 'Fire policy', amountPaise: 6_000_00,
        periodFrom: '2026-04-01', periodTo: '2027-03-31'
      }, s.id)
    ).toThrow('cannot be re-cut')
  })
})

describe('the bank’s monthly stock statement', () => {
  function tradingBooks(): { db: Db; margins: { stockMarginPercent: number; debtorMarginPercent: number; debtorAgeLimitDays: number; sanctionedLimitPaise: number } } {
    const db = seededDb()
    // The landed-cost table this branch's stockAnalysis reads is created by a migration that has
    // not landed here yet (see services/inventoryLandedCost.ts, whose own dbtest fails the same
    // way on a clean checkout). Created empty so the stock valuation can run; delete this block
    // once that migration is merged.
    db.exec(`CREATE TABLE IF NOT EXISTS landed_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
      ledger_id INTEGER REFERENCES ledgers(id),
      label TEXT, amount INTEGER NOT NULL, basis TEXT NOT NULL, line_order INTEGER NOT NULL DEFAULT 0)`)
    const unit =
      (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined) ??
      createUnit(db, { name: 'Pieces', symbol: 'pcs', decimals: 3, uqc: 'PCS' })
    const widget = createStockItem(db, {
      name: 'Widget', groupId: null, unitId: unit.id, hsn: '8471', gstRate: 18, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
    } as never).id
    const supplier = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Supplier', groupId: groupId(db, 'Sundry Creditors') }).id
    const buyer = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Kumar Stores', groupId: groupId(db, 'Sundry Debtors') }).id
    const purchases = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Purchase Account', groupId: groupId(db, 'Purchase Accounts') }).id
    const sales = createLedger(db, { ...LEDGER_DEFAULTS, name: 'Sales Account', groupId: groupId(db, 'Sales Accounts') }).id
    const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

    saveVoucher(db, {
      voucherTypeId: vt('purchase'), date: '2026-01-10', partyLedgerId: supplier,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: purchases, drCr: 'dr', amount: 10_00_000_00, costAllocations: [] },
        { ledgerId: supplier, drCr: 'cr', amount: 10_00_000_00, costAllocations: [] }
      ],
      inventory: [{ stockItemId: widget, godownId: null, qtyMilli: 1000_000, ratePaise: 100_000, amount: 10_00_000_00, direction: 'in' }],
      billRefs: [], tds: null
    })
    // One recent sale (eligible) and one old one (past the bank's cut-off).
    for (const [date, amount] of [['2026-06-01', 4_00_000_00], ['2025-12-01', 1_00_000_00]] as [string, number][]) {
      saveVoucher(db, {
        voucherTypeId: vt('sales'), date, partyLedgerId: buyer,
        narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
        vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: buyer, drCr: 'dr', amount, costAllocations: [] },
          { ledgerId: sales, drCr: 'cr', amount, costAllocations: [] }
        ],
        inventory: [], billRefs: [], tds: null
      })
    }
    return {
      db,
      margins: { stockMarginPercent: 25, debtorMarginPercent: 40, debtorAgeLimitDays: 90, sanctionedLimitPaise: 20_00_000_00 }
    }
  }

  it('reads stock, debts and creditors out of the books, and excludes the old debts', () => {
    const { db, margins } = tradingBooks()
    const s = computeStockStatement(db, '2026-06-30', margins)
    expect(s.stockPaise).toBe(10_00_000_00)
    expect(s.creditorsPaise).toBe(10_00_000_00)
    expect(s.eligibleDebtorsPaise).toBe(4_00_000_00)
    expect(s.ineligibleDebtorsPaise).toBe(1_00_000_00)
    expect(s.excludedParties[0]!.name).toBe('Kumar Stores')
  })

  it('produces drawing power from what it read', () => {
    const { db, margins } = tradingBooks()
    const s = computeStockStatement(db, '2026-06-30', margins)
    // Stock 10L less creditors 10L = nothing paid for, so all the drawing power is on debts.
    expect(s.dpOnStockPaise).toBe(0)
    expect(s.dpOnDebtorsPaise).toBe(2_40_000_00)
    expect(s.drawingPowerPaise).toBe(2_40_000_00)
    expect(s.cappedBySecurity).toBe(true)
  })

  it('files once, exactly as it read on the day', () => {
    const { db, margins } = tradingBooks()
    fileStockStatement(db, '2026-06-30', margins, 'June')
    expect(() => fileStockStatement(db, '2026-06-30', margins, 'June again')).toThrow('already been filed')
    const filed = listFiledStatements(db)
    expect(filed).toHaveLength(1)
    expect(filed[0]!.drawingPowerPaise).toBe(2_40_000_00)
  })
})
