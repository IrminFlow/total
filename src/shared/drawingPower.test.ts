import { describe, it, expect } from 'vitest'
import { DEFAULT_MARGINS, drawingPower, drawingPowerRows, type StockStatementInput } from './drawingPower'

const margins = { ...DEFAULT_MARGINS, sanctionedLimitPaise: 50_00_000_00 }
const statement: StockStatementInput = {
  asOn: '2026-06-30',
  stockPaise: 40_00_000_00,
  eligibleDebtorsPaise: 30_00_000_00,
  ineligibleDebtorsPaise: 8_00_000_00,
  creditorsPaise: 10_00_000_00,
  utilisedPaise: 35_00_000_00
}

describe('drawing power', () => {
  it('deducts creditors before the margin, not after', () => {
    const r = drawingPower(statement, margins)
    expect(r.paidStockPaise).toBe(30_00_000_00)
    expect(r.stockMarginPaise).toBe(7_50_000_00) // 25% of paid stock, not of gross stock
    expect(r.dpOnStockPaise).toBe(22_50_000_00)
  })

  it('discounts eligible debts by their own margin', () => {
    const r = drawingPower(statement, margins)
    expect(r.dpOnDebtorsPaise).toBe(18_00_000_00) // 30L less 40%
  })

  it('excludes overdue debts outright rather than discounting them', () => {
    const r = drawingPower(statement, margins)
    expect(r.grossDrawingPowerPaise).toBe(40_50_000_00)
    // The ineligible debts are reported so the borrower can see what was left out…
    expect(r.ineligibleDebtorsPaise).toBe(8_00_000_00)
    // …and contribute nothing.
    const without = drawingPower({ ...statement, ineligibleDebtorsPaise: 0 }, margins)
    expect(without.drawingPowerPaise).toBe(r.drawingPowerPaise)
  })

  it('caps at the sanctioned limit', () => {
    const r = drawingPower({ ...statement, stockPaise: 2_00_00_000_00 }, margins)
    expect(r.drawingPowerPaise).toBe(50_00_000_00)
    expect(r.cappedBySecurity).toBe(false)
  })

  it('says when security rather than the sanction is the constraint', () => {
    const r = drawingPower(statement, margins)
    expect(r.cappedBySecurity).toBe(true)
    expect(r.drawingPowerPaise).toBe(40_50_000_00)
  })

  it('flags an account drawn beyond its security', () => {
    const r = drawingPower(statement, margins)
    expect(r.headroomPaise).toBe(5_50_000_00)
    expect(r.excess).toBe(false)
    const over = drawingPower({ ...statement, utilisedPaise: 45_00_000_00 }, margins)
    expect(over.excess).toBe(true)
    expect(over.headroomPaise).toBe(-4_50_000_00)
  })

  it('has no paid stock when creditors exceed stock, rather than negative security', () => {
    const r = drawingPower({ ...statement, creditorsPaise: 60_00_000_00 }, margins)
    expect(r.paidStockPaise).toBe(0)
    expect(r.dpOnStockPaise).toBe(0)
  })

  it('stands on the security figure when nobody has entered a sanction yet', () => {
    const r = drawingPower(statement, { ...margins, sanctionedLimitPaise: 0 })
    expect(r.drawingPowerPaise).toBe(r.grossDrawingPowerPaise)
  })

  it('is integer paise throughout, on an odd margin', () => {
    const r = drawingPower({ ...statement, stockPaise: 33_33_333_33 }, { ...margins, stockMarginPercent: 22.5 })
    for (const v of Object.values(r)) {
      if (typeof v === 'number') expect(Number.isInteger(v)).toBe(true)
    }
  })
})

describe('the bank’s own form', () => {
  it('lays the arithmetic out so each line follows from the one above', () => {
    const r = drawingPower(statement, margins)
    const rows = drawingPowerRows(r, margins)
    const value = (label: string): number => rows.find((x) => x.label.startsWith(label))!.value
    expect(value('Stock on hand') + value('Less: sundry creditors')).toBe(value('Paid stock'))
    expect(value('Paid stock') + value('Less: margin @ 25')).toBe(value('Drawing power on stock'))
    expect(value('Drawing power on stock') + value('Drawing power on book debts')).toBe(value('Total drawing power'))
  })
})
