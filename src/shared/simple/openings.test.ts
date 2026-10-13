// WP 8.7: the opening setup's pure half — figures in paise (no float), the difference sentence's
// kind, bill numbers for blank ones, step checks (negative amounts, duplicate names / bill
// numbers per party, bills after the start, quantities) and the payload the screen sends.
import { describe, expect, it } from 'vitest'
import {
  billNames, differenceKind, openingFigures, openingSteps, openingsPayload, openingsStepErrors, parseQtyText,
  simpleOpeningsSchema, stockLineRate, stockLineValue, type OpeningsDraft
} from './openings'

const empty = (): OpeningsDraft => ({ cash: { amount: null, base: null }, banks: [], overdrafts: [], customers: [], suppliers: [], items: [], others: [] })
const bill = (over: Partial<OpeningsDraft['customers'][number]['bills'][number]> = {}) => ({ key: 'b', ref: '', date: '', amount: 100_00, ...over })
const party = (name: string, bills: ReturnType<typeof bill>[], over: Partial<OpeningsDraft['customers'][number]> = {}) => ({ key: name, ledgerId: null, name, base: null, bills, ...over })

describe('opening figures (paise)', () => {
  it('stock value is quantity × rate, rounded half up to the paisa, in integers', () => {
    expect(stockLineValue(10_000, 1_200_00)).toBe(12_000_00)
    expect(stockLineValue(2_500, 45_00)).toBe(112_50)
    expect(stockLineValue(1, 1)).toBe(0) // 0.001 × ₹0.01
    expect(stockLineValue(500, 1)).toBe(1) // half a paisa rounds up
    expect(stockLineValue(333, 10)).toBe(3)
    expect(stockLineValue(9_000_000_000, 9_000_00)).toBe(8_100_000_000_000) // beyond float-safe products
    expect(stockLineRate(2_500, 112_50)).toBe(45_00)
    expect(stockLineRate(0, 500)).toBe(0)
  })

  it('have − owe is the difference; side decides, never the sign', () => {
    const f = openingFigures(simpleOpeningsSchema.parse({
      cash: { amount: 5_000_00 },
      banks: [{ name: 'HDFC', amount: 20_000_00 }],
      customers: [{ name: 'A', bills: [{ amount: 3_000_00 }, { amount: 1_500_00 }] }],
      suppliers: [{ name: 'B', bills: [{ amount: 8_000_00 }] }],
      items: [{ name: 'Rice', qtyMilli: 10_000, ratePaise: 1_200_00 }],
      others: [{ kind: 'loan_taken', name: 'Loan', amount: 10_000_00 }, { kind: 'fixed_asset', name: 'Fridge', amount: 15_000_00 }]
    }))
    expect(f).toEqual({ have: 56_500_00, owe: 18_000_00, difference: 38_500_00 })
    expect(differenceKind(f.difference)).toBe('more')
    expect(differenceKind(-1)).toBe('less')
    expect(differenceKind(0)).toBe('even')
  })
})

describe('opening validation', () => {
  it('the schema refuses negative amounts and duplicate bill numbers per party (case and spaces ignored)', () => {
    expect(simpleOpeningsSchema.safeParse({ cash: { amount: -1 } }).success).toBe(false)
    expect(simpleOpeningsSchema.safeParse({ cash: { amount: 0 }, banks: [{ name: 'X', amount: -500 }] }).success).toBe(false)
    expect(simpleOpeningsSchema.safeParse({ cash: { amount: 0 }, customers: [{ name: 'A', bills: [{ amount: -5 }] }] }).success).toBe(false)
    expect(simpleOpeningsSchema.safeParse({ cash: { amount: 0 }, items: [{ name: 'Rice', qtyMilli: -1, ratePaise: 0 }] }).success).toBe(false)
    const dup = simpleOpeningsSchema.safeParse({ cash: { amount: 0 }, customers: [{ name: 'A', bills: [{ ref: 'B-1', amount: 1 }, { ref: ' b-1', amount: 2 }] }] })
    expect(dup.success).toBe(false)
    expect(dup.error?.issues[0]?.path).toEqual(['customers', 0, 'bills', 1, 'ref'])
    // Two parties may each have a bill "1"; two blank numbers are fine (named for them).
    expect(simpleOpeningsSchema.safeParse({ cash: { amount: 0 }, customers: [{ name: 'A', bills: [{ ref: '1', amount: 1 }, { amount: 2 }, { amount: 3 }] }, { name: 'B', bills: [{ ref: '1', amount: 1 }] }] }).success).toBe(true)
    // The same party twice, or a new row without a name.
    expect(simpleOpeningsSchema.safeParse({ cash: { amount: 0 }, customers: [{ name: 'A', bills: [] }, { name: 'a', bills: [] }] }).success).toBe(false)
    expect(simpleOpeningsSchema.safeParse({ cash: { amount: 0 }, banks: [{ name: '', amount: 1 }] }).success).toBe(false)
  })

  it('step checks point at the field', () => {
    const d = empty()
    d.cash.amount = -100
    d.banks = [{ key: 'k', ledgerId: null, name: '', amount: 500, base: null }, { key: 'k2', ledgerId: null, name: '', amount: null, base: null }]
    expect(openingsStepErrors(d, 'money', '2026-04-01')).toEqual({ 'cash.amount': 'errors.openings.negative', 'banks.0.name': 'errors.openings.nameNeeded' })

    d.customers = [
      party('Sharma', [bill({ ref: 'B1' }), bill({ ref: 'b1' }), bill({ amount: null, ref: 'X' }), bill({ date: '2026-04-02' }), bill({ amount: -5 }), bill({ amount: null })]),
      party('sharma ', [bill()]),
      party('', [bill()])
    ]
    expect(openingsStepErrors(d, 'customers', '2026-04-01')).toEqual({
      'customers.0.bills.1.ref': 'errors.openings.duplicateBill',
      'customers.0.bills.2.amount': 'errors.openings.amountNeeded',
      'customers.0.bills.3.date': 'errors.openings.dateAfterStart',
      'customers.0.bills.4.amount': 'errors.openings.negative',
      'customers.1.name': 'errors.openings.duplicateName',
      'customers.2.name': 'errors.openings.nameNeeded'
    })
    // Another step's problems don't block this one.
    expect(openingsStepErrors(d, 'suppliers', '2026-04-01')).toEqual({})

    d.items = [
      { key: 'i', itemId: null, name: 'Rice', unitId: null, qty: 'ten', rate: 100, base: null },
      { key: 'j', itemId: null, name: 'Dal', unitId: null, qty: '', rate: 100, base: null },
      { key: 'k', itemId: null, name: 'Oil', unitId: null, qty: '-2', rate: -1, base: null },
      { key: 'l', itemId: null, name: '', unitId: null, qty: '', rate: null, base: null }
    ]
    expect(openingsStepErrors(d, 'stock', '2026-04-01')).toEqual({
      'items.0.qty': 'errors.openings.qtyInvalid',
      'items.1.qty': 'errors.openings.qtyNeeded',
      'items.2.qty': 'errors.openings.negative',
      'items.2.rate': 'errors.openings.negative'
    })
  })

  it('quantities: digits and one point, up to three decimals, as thousandths', () => {
    expect(parseQtyText('12')).toBe(12_000)
    expect(parseQtyText('2.5')).toBe(2_500)
    expect(parseQtyText('0.125')).toBe(125)
    expect(parseQtyText('.5')).toBe(500)
    expect(parseQtyText('1,200')).toBe(1_200_000)
    expect(parseQtyText('1.2345')).toBeNull()
    expect(parseQtyText('-2')).toBeNull()
    expect(parseQtyText('')).toBeNull()
  })
})

describe('bill numbers and the payload', () => {
  it('blank bill numbers become Opening, Opening 2 … skipping typed ones', () => {
    expect(billNames(['', 'B-1', ''])).toEqual(['Opening', 'B-1', 'Opening 2'])
    expect(billNames(['Opening', ''])).toEqual(['Opening', 'Opening 2'])
    expect(billNames(['opening 2', '', ''])).toEqual(['opening 2', 'Opening', 'Opening 3'])
    // In date order (blank date = the books-begin day), whatever order they were typed in.
    expect(billNames(['', '', 'X'], [null, '2026-03-01', '2026-02-01'], '2026-04-01')).toEqual(['Opening 2', 'Opening', 'X'])
  })

  it('"Opening (balance)" is reserved for the uncovered part of an opening', () => {
    expect(simpleOpeningsSchema.safeParse({ cash: { amount: 0 }, customers: [{ name: 'A', bills: [{ ref: ' Opening (Balance)', amount: 1 }] }] }).success).toBe(false)
    const d = empty()
    d.customers = [party('A', [bill({ ref: 'opening (balance)' })])]
    expect(openingsStepErrors(d, 'customers', '2026-04-01')).toEqual({ 'customers.0.bills.0.ref': 'errors.openings.reservedName' })
  })

  it('overdrafts are what you owe; the capital account rides with the payload', () => {
    const d = empty()
    d.overdrafts = [{ key: 'o', ledgerId: 4, name: 'SBI OD', amount: 3_000_00, base: -3_000_00 }, { key: 'p', ledgerId: null, name: '', amount: -1, base: null }]
    expect(openingsStepErrors(d, 'suppliers', '2026-04-01')).toEqual({ 'overdrafts.1.amount': 'errors.openings.negative', 'overdrafts.1.name': 'errors.openings.nameNeeded' })
    d.overdrafts = d.overdrafts.slice(0, 1)
    const p = simpleOpeningsSchema.parse(openingsPayload(d, -5, 9))
    expect(p.overdrafts).toEqual([{ ledgerId: 4, name: 'SBI OD', amount: 3_000_00, base: -3_000_00 }])
    expect(p.capitalLedgerId).toBe(9)
    expect(openingFigures(p)).toEqual({ have: 0, owe: 3_000_00, difference: -3_000_00 })
  })

  it('drops blank new rows, keeps loaded rows (so clearing one clears it) and parses quantities', () => {
    const d = empty()
    d.cash = { amount: 5_000_00, base: 0 }
    d.banks = [
      { key: 'a', ledgerId: 7, name: 'SBI', amount: null, base: 1_000_00 },
      { key: 'b', ledgerId: null, name: '', amount: null, base: null }
    ]
    d.customers = [party('Sharma', [bill({ ref: ' B-1 ', amount: 300_00 }), bill({ amount: null })]), party('', [bill({ amount: null })])]
    d.suppliers = [party('', [], { ledgerId: 9, base: -500_00 })]
    d.items = [{ key: 'i', itemId: null, name: 'Rice', unitId: 3, qty: '2.5', rate: 40_00, base: null }]
    const p = simpleOpeningsSchema.parse(openingsPayload(d, -123))
    expect(p.cash).toEqual({ amount: 5_000_00, base: 0 })
    expect(p.banks).toEqual([{ ledgerId: 7, name: 'SBI', amount: 0, base: 1_000_00 }])
    expect(p.customers).toEqual([{ ledgerId: null, name: 'Sharma', base: null, bills: [{ ref: 'B-1', date: null, amount: 300_00 }] }])
    expect(p.suppliers).toEqual([{ ledgerId: 9, name: '', base: -500_00, bills: [] }])
    expect(p.items).toEqual([{ itemId: null, name: 'Rice', unitId: 3, qtyMilli: 2_500, ratePaise: 40_00, base: null }])
    expect(p.confirmCapital).toBe(-123)
  })

  it('stock is a step only while stock is on', () => {
    expect(openingSteps(true)).toEqual(['money', 'customers', 'suppliers', 'stock', 'confirm'])
    expect(openingSteps(false)).toEqual(['money', 'customers', 'suppliers', 'confirm'])
  })
})
