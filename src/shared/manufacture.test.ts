import { describe, expect, it } from 'vitest'
import {
  autoManufactureNarration, bomFromRows, buildManufactureVoucher, lineAmount, manufactureTotals, needsLossConfirmation,
  rowsFromBom, unitRate, validateManufacture, type ManufactureInput
} from './manufacture'

const CHAIR = 1
const STEEL = 2
const PAINT = 3
const names = (id: number): string => ({ [CHAIR]: 'Chair', [STEEL]: 'Steel', [PAINT]: 'Paint' })[id] ?? '?'

const base: ManufactureInput = {
  date: '2025-06-01',
  finishedItemId: CHAIR,
  qtyMilli: 2000,
  saleRatePaise: 100000,
  raw: [
    { stockItemId: STEEL, qtyMilli: 4000 },
    { stockItemId: PAINT, qtyMilli: 500 }
  ],
  labourPaise: 30000,
  labourPosted: true,
  profitPaise: 200000 - (100000 + 30000)
}
const codes = (input: Partial<ManufactureInput>, consumption?: number): string[] =>
  validateManufacture({ ...base, ...input }, consumption, names).map((i) => i.code)

describe('manufacture totals', () => {
  it('sale amount = qty × price; production cost = materials + labour; profit balances the two sides', () => {
    const t = manufactureTotals({ qtyMilli: 2500, saleRatePaise: 33333, materialPaise: 50000, labourPaise: 1234 })
    expect(t.saleAmount).toBe(83333) // 2.5 × 333.33 = 833.325 → 833.33
    expect(t.productionCost).toBe(51234)
    expect(t.profit).toBe(83333 - 51234)
    expect(t.rightTotal).toBe(t.saleAmount)
  })

  it('a loss is a negative profit and needs confirmation', () => {
    const t = manufactureTotals({ qtyMilli: 1000, saleRatePaise: 100, materialPaise: 500, labourPaise: 0 })
    expect(t.profit).toBe(-400)
    expect(needsLossConfirmation(t.profit)).toBe(true)
    expect(needsLossConfirmation(0)).toBe(false)
  })

  it('integer helpers', () => {
    expect(lineAmount(1500, 999)).toBe(1499) // 1498.5 → 1499
    expect(unitRate(25000, 750)).toBe(33333)
    expect(unitRate(100, 0)).toBe(0)
    expect(autoManufactureNarration(2500, 'Chair')).toBe('Manufactured 2.5 × Chair')
  })
})

describe('validateManufacture', () => {
  it('accepts a complete voucher whose profit matches to the paisa', () => {
    expect(codes({}, 100000)).toEqual([])
  })

  it('needs a finished item, a positive quantity and at least one raw material', () => {
    expect(codes({ finishedItemId: 0 })).toContain('no_item')
    expect(codes({ qtyMilli: 0 })).toContain('bad_qty')
    expect(codes({ qtyMilli: -5 })).toContain('bad_qty')
    expect(codes({ raw: [] })).toContain('no_raw')
  })

  it('every raw row must be complete', () => {
    const issues = validateManufacture({ ...base, raw: [{ stockItemId: STEEL, qtyMilli: 0 }, { stockItemId: 0, qtyMilli: 10 }] })
    expect(issues.map((i) => [i.code, i.row])).toEqual([['incomplete_row', 0], ['incomplete_row', 1]])
    expect(issues[0]!.message).toBe('Raw material row 1: enter a quantity')
    expect(issues[1]!.message).toBe('Raw material row 2: pick an item')
  })

  it('rejects the finished item as its own raw material', () => {
    const issues = validateManufacture({ ...base, raw: [{ stockItemId: CHAIR, qtyMilli: 1000 }] }, undefined, names)
    expect(issues).toEqual([{ code: 'raw_is_finished', row: 0, message: "Chair can't be a raw material of itself" }])
  })

  it('rejects (does not merge) a duplicated raw material', () => {
    const issues = validateManufacture(
      { ...base, raw: [{ stockItemId: STEEL, qtyMilli: 1000 }, { stockItemId: PAINT, qtyMilli: 1 }, { stockItemId: STEEL, qtyMilli: 2000 }] },
      undefined,
      names
    )
    expect(issues).toEqual([{ code: 'duplicate_raw', row: 2, message: 'Steel appears in rows 1 and 3 — combine them into one row' }])
  })

  it('labour and sale rate cannot be negative (zero is fine)', () => {
    expect(codes({ labourPaise: -1 })).toContain('bad_labour')
    expect(codes({ saleRatePaise: -1 })).toContain('bad_sale_rate')
    expect(codes({ labourPaise: 0, saleRatePaise: 0, profitPaise: -100000 }, 100000)).toEqual([])
  })

  it('profit must equal sale amount − (consumption + labour) to the paisa', () => {
    expect(codes({}, 100001)).toEqual(['profit_mismatch'])
    expect(codes({ profitPaise: base.profitPaise + 1 }, 100000)).toEqual(['profit_mismatch'])
    // structure-only check skips it
    expect(codes({ profitPaise: 1 })).toEqual([])
  })
})

describe('buildManufactureVoucher', () => {
  const ledgers = { labourExpenseLedgerId: 10, labourCreditLedgerId: 11 }

  it('one outward line per raw row, one inward line at Σ cost + labour, labour Dr/Cr', () => {
    const p = buildManufactureVoucher({ ...base, godownId: 5, raw: [{ ...base.raw[0]! }, { ...base.raw[1]!, godownId: 6 }] }, {
      voucherTypeId: 7, rawCosts: [80000, 20000], finishedName: 'Chair', ...ledgers
    })
    expect(p.narration).toBe('Manufactured 2 × Chair')
    expect(p.inventory.map((l) => [l.stockItemId, l.direction, l.qtyMilli, l.ratePaise, l.amount, l.godownId])).toEqual([
      [STEEL, 'out', 4000, 20000, 80000, 5],
      [PAINT, 'out', 500, 40000, 20000, 6],
      [CHAIR, 'in', 2000, 65000, 130000, 5]
    ])
    expect(p.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[10, 'dr', 30000], [11, 'cr', 30000]])
    expect(p.billRefs).toEqual([])
    expect(p.partyLedgerId).toBeNull()
  })

  it('no ledger lines when labour is already booked or zero; a custom narration is kept', () => {
    const booked = buildManufactureVoucher({ ...base, labourPosted: false }, { voucherTypeId: 7, rawCosts: [1, 2], finishedName: 'Chair', labourExpenseLedgerId: null, labourCreditLedgerId: null })
    expect(booked.lines).toEqual([])
    expect(booked.inventory[2]!.amount).toBe(30003)
    const zero = buildManufactureVoucher({ ...base, labourPaise: 0, narration: '  Batch 7 ' }, { voucherTypeId: 7, rawCosts: [1, 2], finishedName: 'Chair', ...ledgers })
    expect(zero.lines).toEqual([])
    expect(zero.narration).toBe('Batch 7')
  })

  it('refuses to post labour without ledgers', () => {
    expect(() =>
      buildManufactureVoucher(base, { voucherTypeId: 7, rawCosts: [1, 2], finishedName: 'Chair', labourExpenseLedgerId: null, labourCreditLedgerId: null })
    ).toThrow(/Labour ledgers/)
  })
})

describe('BOM scaling', () => {
  it('scales per-unit lines by quantity and back', () => {
    const bom = [{ componentId: STEEL, qtyMilliPerUnit: 2000 }, { componentId: PAINT, qtyMilliPerUnit: 250 }]
    expect(rowsFromBom(bom, 3000)).toEqual([{ stockItemId: STEEL, qtyMilli: 6000 }, { stockItemId: PAINT, qtyMilli: 750 }])
    expect(bomFromRows(rowsFromBom(bom, 3000), 3000)).toEqual(bom)
    expect(bomFromRows([{ stockItemId: STEEL, qtyMilli: 1 }], 3000)).toBeNull()
    expect(bomFromRows([], 1000)).toBeNull()
  })
})
