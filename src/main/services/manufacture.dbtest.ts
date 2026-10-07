// WP 2.2 — the Manufacture voucher end to end on a real (in-memory) company: posting, derived
// costing, labour ledger lines vs "already booked", validation, negative stock warn/block, lock
// date, edit, soft delete / restore / purge, the margin register and the movement list.
import { beforeEach, describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { stockItemInputSchema } from '@shared/schemas'
import type { ManufactureInput } from '@shared/manufacture'
import { createLedger, createStockItem } from './masters'
import { deleteVoucher, getVoucher, purgeVoucher, restoreVoucher, saveVoucher, setLockDate, MANUFACTURE_EDIT_ELSEWHERE } from './vouchers'
import {
  costPreview, getManufactureDetails, manufactureRegister, saveManufacture, suggestedSaleRate, LOSS_NEEDS_CONFIRMATION
} from './manufacture'
import { itemMovements, stockSummary, stockValue } from './stockAnalysis'
import { trialBalance } from './reports'
import { getFeatures, setFeatures } from './config'
import { savePriceLevel, saveRate } from './priceLevels'

let db: DB
let steel: number, paint: number, chair: number, table: number
let cash: number, purchases: number, sales: number

const typeId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const ledgerId = (name: string): number | undefined =>
  (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined)?.id

function item(name: string, openingQtyMilli = 0, openingValue = 0, valuationMethod: 'weighted_avg' | 'fifo' = 'weighted_avg'): number {
  const unit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }
  return createStockItem(db, stockItemInputSchema.parse({ name, unitId: unit.id, openingQtyMilli, openingValue, valuationMethod })).id
}

function ledger(name: string, group: string): number {
  return createLedger(db, {
    name, groupId: groupId(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
    gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

const blank = {
  partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
  vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null
}

function purchase(date: string, itemId: number, qtyMilli: number, amount: number): number {
  return saveVoucher(db, {
    ...blank, voucherTypeId: typeId('purchase'), date,
    lines: [{ ledgerId: purchases, drCr: 'dr', amount }, { ledgerId: cash, drCr: 'cr', amount }],
    inventory: [{ stockItemId: itemId, godownId: null, qtyMilli, ratePaise: Math.round((amount * 1000) / qtyMilli), amount, direction: 'in' }]
  }).id
}

function sale(date: string, itemId: number, qtyMilli: number, amount: number): number {
  return saveVoucher(db, {
    ...blank, voucherTypeId: typeId('sales'), date,
    lines: [{ ledgerId: cash, drCr: 'dr', amount }, { ledgerId: sales, drCr: 'cr', amount }],
    inventory: [{ stockItemId: itemId, godownId: null, qtyMilli, ratePaise: Math.round((amount * 1000) / qtyMilli), amount, direction: 'out' }]
  }).id
}

/** 2 chairs from 4 steel + 0.5 paint, ₹300 labour, sold at ₹1,000 each. Steel costs ₹150/unit
 *  and paint ₹400/unit at this point (see beforeEach): materials ₹600 + ₹200 = ₹800. */
function chairs(over: Partial<ManufactureInput> = {}): ManufactureInput {
  const base: ManufactureInput = {
    date: '2025-06-10',
    finishedItemId: chair,
    qtyMilli: 2000,
    saleRatePaise: 100000,
    raw: [{ stockItemId: steel, qtyMilli: 4000 }, { stockItemId: paint, qtyMilli: 500 }],
    labourPaise: 30000,
    labourPosted: true,
    profitPaise: 0
  }
  const input = { ...base, ...over }
  // The screen's figure: sale − (engine consumption + labour).
  const priced = costPreview(db, { date: input.date, lines: input.raw.map((r) => ({ itemId: r.stockItemId, qtyMilli: r.qtyMilli })) })
  const sale = Math.round((input.qtyMilli * input.saleRatePaise) / 1000)
  return { ...input, profitPaise: over.profitPaise ?? sale - (priced.totalPaise + input.labourPaise) }
}

const row = (asOn: string, id: number) => stockSummary(db, asOn).find((r) => r.stockItemId === id)!

beforeEach(() => {
  db = seededDb()
  cash = ledgerId('Cash')!
  purchases = ledger('Purchases', 'Purchase Accounts')
  sales = ledger('Sales', 'Sales Accounts')
  steel = item('Steel Rod', 10000, 150000) // 10 @ ₹150
  paint = item('Paint', 0, 0)
  chair = item('Chair')
  table = item('Table')
  purchase('2025-06-01', paint, 2000, 80000) // 2 @ ₹400
})

describe('saveManufacture — posting', () => {
  it('posts raw materials out at engine cost, the finished item in at materials + labour, labour Dr/Cr', () => {
    const saved = saveManufacture(db, chairs())
    const v = getVoucher(db, saved.id)!
    expect(v.narration).toBe('Manufactured 2 × Chair')
    expect(v.inventory.map((l) => [l.stockItemId, l.direction, l.qtyMilli, l.ratePaise, l.amount])).toEqual([
      [steel, 'out', 4000, 15000, 60000],
      [paint, 'out', 500, 40000, 20000],
      [chair, 'in', 2000, 55000, 110000]
    ])
    const labour = ledgerId('Labour Charges')!
    const wages = ledgerId('Wages Payable')!
    expect(v.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[labour, 'dr', 30000], [wages, 'cr', 30000]])
    const grp = (id: number) => (db.prepare('SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ?').get(id) as { name: string }).name
    expect(grp(labour)).toBe('Direct Expenses')
    expect(grp(wages)).toBe('Current Liabilities')
    expect(getManufactureDetails(db, saved.id)).toEqual({
      voucherId: saved.id, finishedItemId: chair, qtyMilli: 2000, saleRatePaise: 100000, saleAmount: 200000,
      labourPaise: 30000, labourPosted: true, labourExpenseLedgerId: labour, labourCreditLedgerId: wages, profitPaise: 90000
    })
    // Sale price never posts: no sales ledger line, and stock enters at cost.
    expect(saved.manufacture.profitPaise).toBe(90000)
    expect(row('2025-06-30', chair)).toMatchObject({ inwardQtyMilli: 2000, closingQtyMilli: 2000, closingValue: 110000 })
    expect(row('2025-06-30', steel)).toMatchObject({ outwardQtyMilli: 4000, closingQtyMilli: 6000, closingValue: 90000 })
    // The labour journal is in the books: Dr Labour Charges / Cr Wages Payable.
    const tb = trialBalance(db, '2025-06-30')
    expect(tb.rows.find((r) => r.ledgerId === labour)).toMatchObject({ debit: 30000, credit: 0 })
    expect(tb.rows.find((r) => r.ledgerId === wages)).toMatchObject({ debit: 0, credit: 30000 })
  })

  it('"labour already booked" capitalises labour without ledger lines — counted once', () => {
    const saved = saveManufacture(db, chairs({ labourPosted: false }))
    expect(getVoucher(db, saved.id)!.lines).toEqual([])
    expect(getManufactureDetails(db, saved.id)).toMatchObject({ labourPosted: false, labourExpenseLedgerId: null, labourCreditLedgerId: null })
    expect(row('2025-06-30', chair).closingValue).toBe(110000)
  })

  it('posted labour is not counted twice (explicit labour beats the Dr ledger line)', () => {
    saveManufacture(db, chairs())
    expect(row('2025-06-30', chair).closingValue).toBe(60000 + 20000 + 30000)
  })

  it('labour can be credited to a chosen account', () => {
    const contractor = ledger('Contractor', 'Sundry Creditors')
    const saved = saveManufacture(db, chairs({ labourCreditLedgerId: contractor }))
    expect(getVoucher(db, saved.id)!.lines.map((l) => [l.ledgerId, l.drCr])).toEqual([[ledgerId('Labour Charges'), 'dr'], [contractor, 'cr']])
  })

  it('zero labour posts no ledger lines and creates no ledgers', () => {
    const saved = saveManufacture(db, chairs({ labourPaise: 0 }))
    expect(getVoucher(db, saved.id)!.lines).toEqual([])
    expect(ledgerId('Labour Charges')).toBeUndefined()
  })
})

describe('derived costing', () => {
  it('finished goods = consumption + labour, and a backdated purchase re-prices them', () => {
    saveManufacture(db, chairs())
    expect(row('2025-06-30', chair).closingValue).toBe(110000)
    // Backdated purchase of steel at ₹250 → steel average 10 @150 + 10 @250 = ₹200 → 4 × 200 = 800.
    purchase('2025-06-05', steel, 10000, 250000)
    expect(row('2025-06-30', chair).closingValue).toBe(80000 + 20000 + 30000)
    // Conservation: total stock value = openings + purchases − nothing sold (labour capitalised).
    expect(stockValue(db, '2025-06-30')).toBe(150000 + 80000 + 250000 + 30000)
  })

  it('selling the finished goods charges COGS at production cost', () => {
    saveManufacture(db, chairs())
    sale('2025-06-20', chair, 1000, 100000)
    expect(row('2025-06-30', chair)).toMatchObject({ closingQtyMilli: 1000, closingValue: 55000 })
  })

  it('legacy stock journals (no details row) keep their stored costing', () => {
    const id = saveVoucher(db, {
      ...blank, voucherTypeId: typeId('stock_journal'), date: '2025-06-10', lines: [],
      inventory: [
        { stockItemId: steel, godownId: null, qtyMilli: 4000, ratePaise: 15000, amount: 60000, direction: 'out' },
        { stockItemId: chair, godownId: null, qtyMilli: 2000, ratePaise: 99999, amount: 199998, direction: 'in' }
      ]
    }).id
    expect(getManufactureDetails(db, id)).toBeNull()
    expect(row('2025-06-30', chair).closingValue).toBe(199998)
  })
})

describe('validation', () => {
  it('profit must match sale − production cost to the paisa', () => {
    expect(() => saveManufacture(db, chairs({ profitPaise: 89999 }))).toThrow(/Profit must equal/)
  })

  it('a loss needs confirmation', () => {
    expect(() => saveManufacture(db, chairs({ saleRatePaise: 10000 }))).toThrow(LOSS_NEEDS_CONFIRMATION)
    const saved = saveManufacture(db, chairs({ saleRatePaise: 10000, confirmLoss: true }))
    expect(saved.manufacture.profitPaise).toBe(20000 - 110000)
  })

  it('structure: item, qty, complete rows, no self-consumption, no duplicates', () => {
    expect(() => saveManufacture(db, chairs({ finishedItemId: 0 }))).toThrow(/Pick the item/)
    expect(() => saveManufacture(db, chairs({ qtyMilli: 0 }))).toThrow(/quantity manufactured/)
    expect(() => saveManufacture(db, chairs({ raw: [] }))).toThrow(/at least one raw material/)
    expect(() => saveManufacture(db, chairs({ raw: [{ stockItemId: steel, qtyMilli: 0 }] }))).toThrow(/row 1: enter a quantity/)
    expect(() => saveManufacture(db, chairs({ raw: [{ stockItemId: chair, qtyMilli: 1000 }] }))).toThrow(/can't be a raw material of itself/)
    expect(() =>
      saveManufacture(db, chairs({ raw: [{ stockItemId: steel, qtyMilli: 1000 }, { stockItemId: steel, qtyMilli: 1000 }] }))
    ).toThrow(/combine them into one row/)
    expect(() => saveManufacture(db, chairs({ raw: [{ stockItemId: 9999, qtyMilli: 1000 }] }))).toThrow(/Stock item not found/)
    expect(() => saveManufacture(db, chairs({ voucherTypeId: typeId('sales') }))).toThrow(/stock journal/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM manufacture_details').get()).toEqual({ n: 0 })
  })

  it('insufficient raw stock warns by default and blocks (rolling everything back) under preventNegativeStock', () => {
    const warned = saveManufacture(db, chairs({ raw: [{ stockItemId: steel, qtyMilli: 12000 }], labourPosted: false, confirmLoss: true }))
    expect(warned.warnings.negativeStock.map((w) => [w.stockItemId, w.closingQtyMilli])).toEqual([[steel, -2000]])
    deleteVoucher(db, warned.id)

    setFeatures(db, { ...getFeatures(db), preventNegativeStock: true })
    const vouchersBefore = (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
    expect(() => saveManufacture(db, chairs({ raw: [{ stockItemId: steel, qtyMilli: 12000 }], confirmLoss: true }))).toThrow(
      /Insufficient stock for: Steel Rod/
    )
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(vouchersBefore)
    expect(db.prepare('SELECT COUNT(*) AS n FROM manufacture_details WHERE voucher_id <> ?').get(warned.id)).toEqual({ n: 0 })
    expect(ledgerId('Labour Charges')).toBeUndefined() // the find-or-create rolled back too
  })

  it('respects the lock date', () => {
    setLockDate(db, '2025-06-15')
    expect(() => saveManufacture(db, chairs())).toThrow(/locked up to 2025-06-15/)
  })

  it('a manufacture cannot be altered through the generic voucher:save path', () => {
    const saved = saveManufacture(db, chairs())
    const v = getVoucher(db, saved.id)!
    expect(() =>
      saveVoucher(db, { ...blank, voucherTypeId: v.voucherTypeId, date: v.date, narration: 'x', lines: [], inventory: [] }, saved.id)
    ).toThrow(MANUFACTURE_EDIT_ELSEWHERE)
  })

  it('refuses to convert a legacy stock journal', () => {
    const id = saveVoucher(db, {
      ...blank, voucherTypeId: typeId('stock_journal'), date: '2025-06-10', lines: [],
      inventory: [
        { stockItemId: steel, godownId: null, qtyMilli: 1000, ratePaise: 15000, amount: 15000, direction: 'out' },
        { stockItemId: chair, godownId: null, qtyMilli: 1000, ratePaise: 15000, amount: 15000, direction: 'in' }
      ]
    }).id
    expect(() => saveManufacture(db, chairs(), id)).toThrow(/before 0.6.0/)
  })
})

describe('edit, delete, restore, purge', () => {
  it('edit = same function with the voucher id: quantities re-priced at the voucher position, number kept', () => {
    const saved = saveManufacture(db, chairs())
    const edited = saveManufacture(db, chairs({ qtyMilli: 3000, raw: [{ stockItemId: steel, qtyMilli: 6000 }, { stockItemId: paint, qtyMilli: 750 }] }), saved.id)
    expect(edited.id).toBe(saved.id)
    expect(edited.number).toBe(saved.number)
    expect(edited.narration).toBe('Manufactured 3 × Chair')
    expect(getManufactureDetails(db, saved.id)).toMatchObject({ qtyMilli: 3000, saleAmount: 300000, profitPaise: 300000 - (90000 + 30000 + 30000) })
    expect(row('2025-06-30', chair)).toMatchObject({ closingQtyMilli: 3000, closingValue: 150000 })
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'manufacture' AND entity_id = ?").get(saved.id) as { n: number }).n).toBe(2)
  })

  it('soft delete keeps the details row (excluded from stock and the register); restore brings both back; purge cascades', () => {
    const saved = saveManufacture(db, chairs())
    deleteVoucher(db, saved.id)
    expect(getManufactureDetails(db, saved.id)).not.toBeNull()
    expect(row('2025-06-30', chair).closingQtyMilli).toBe(0)
    expect(row('2025-06-30', steel).closingQtyMilli).toBe(10000)
    expect(manufactureRegister(db, '2025-04-01', '2026-03-31')).toEqual([])
    restoreVoucher(db, saved.id)
    expect(row('2025-06-30', chair)).toMatchObject({ closingQtyMilli: 2000, closingValue: 110000 })
    expect(manufactureRegister(db, '2025-04-01', '2026-03-31')).toHaveLength(1)
    deleteVoucher(db, saved.id)
    purgeVoucher(db, saved.id)
    expect(getManufactureDetails(db, saved.id)).toBeNull()
  })
})

describe('pricing, register and movements', () => {
  it('costPreview prices rows as of the date; an edit leaves its own lines out', () => {
    const p = costPreview(db, { date: '2025-06-10', finishedItemId: chair, lines: [{ itemId: steel, qtyMilli: 4000 }, { itemId: paint, qtyMilli: 0 }] })
    expect(p.lines).toEqual([
      { itemId: steel, qtyMilli: 4000, costPaise: 60000, unitCostPaise: 15000, onHandQtyMilli: 10000 },
      { itemId: paint, qtyMilli: 0, costPaise: 0, unitCostPaise: 40000, onHandQtyMilli: 2000 }
    ])
    expect(p.totalPaise).toBe(60000)
    // Before the paint purchase there is no paint cost.
    expect(costPreview(db, { date: '2025-05-31', lines: [{ itemId: paint, qtyMilli: 1000 }] }).lines[0]).toMatchObject({ costPaise: 0, onHandQtyMilli: 0 })
    const saved = saveManufacture(db, chairs())
    const again = costPreview(db, { date: '2025-06-10', voucherId: saved.id, lines: [{ itemId: steel, qtyMilli: 4000 }] })
    expect(again.lines[0]).toMatchObject({ costPaise: 60000, onHandQtyMilli: 10000 })
  })

  it('suggested sale rate: average of this FY sales → price list → null', () => {
    expect(suggestedSaleRate(db, table, '2025-06-10')).toEqual({ ratePaise: null, source: null })
    const level = savePriceLevel(db, { name: 'Retail' })
    saveRate(db, { priceLevelId: level.id, stockItemId: table, rate: 123400, effectiveFrom: '2025-04-01' })
    expect(suggestedSaleRate(db, table, '2025-06-10')).toEqual({ ratePaise: 123400, source: 'priceList' })
    purchase('2025-06-02', table, 5000, 100000)
    sale('2025-06-03', table, 1000, 150000)
    sale('2025-06-04', table, 2000, 240000)
    expect(suggestedSaleRate(db, table, '2025-06-10')).toEqual({ ratePaise: 130000, source: 'sales' })
    // Last FY's sales don't count.
    expect(suggestedSaleRate(db, table, '2026-04-10')).toEqual({ ratePaise: 123400, source: 'priceList' })
  })

  it('manufacture register lists live manufactures with production cost, sale value and profit', () => {
    const a = saveManufacture(db, chairs())
    saveManufacture(db, chairs({ date: '2025-06-12', qtyMilli: 1000, raw: [{ stockItemId: steel, qtyMilli: 1000 }], labourPaise: 0, saleRatePaise: 20000 }))
    const rows = manufactureRegister(db, '2025-06-01', '2025-06-30')
    expect(rows.map((r) => [r.voucherId === a.id, r.date, r.itemName, r.qtyMilli, r.productionCost, r.saleAmount, r.profitPaise])).toEqual([
      [true, '2025-06-10', 'Chair', 2000, 110000, 200000, 90000],
      [false, '2025-06-12', 'Chair', 1000, 15000, 20000, 5000]
    ])
  })

  it('the movement list shows finished goods in and raw materials out on the voucher date', () => {
    const saved = saveManufacture(db, chairs())
    expect(itemMovements(db, chair, '2025-04-01', '2026-03-31')).toEqual([
      expect.objectContaining({ voucherId: saved.id, date: '2025-06-10', kind: 'stock_journal', inQtyMilli: 2000, outQtyMilli: 0, amount: 110000 })
    ])
    expect(itemMovements(db, steel, '2025-04-01', '2026-03-31')).toEqual([
      expect.objectContaining({ voucherId: saved.id, date: '2025-06-10', inQtyMilli: 0, outQtyMilli: 4000 })
    ])
    deleteVoucher(db, saved.id)
    expect(itemMovements(db, chair, '2025-04-01', '2026-03-31')).toEqual([])
  })
})
