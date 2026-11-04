import { describe, expect, it } from 'vitest'
import { parseQtyText } from './qty'
import { computeInvoice, emptyInvoiceState, type InvoiceContext } from './voucherEdit'
import { buildStockLinesPayload, emptyStockLinesState, blankStockLineRow } from './voucherEdit/stockLines'

describe('parseQtyText — typed quantities, integer thousandths (bug hunt 2026-11)', () => {
  it('reads Indian and western digit grouping ("1,500" was read as 1)', () => {
    expect(parseQtyText('1,500')).toBe(1_500_000)
    expect(parseQtyText('1,50,000')).toBe(150_000_000)
    expect(parseQtyText('12,345.5')).toBe(12_345_500)
    expect(parseQtyText(' 2.5 ')).toBe(2_500)
    expect(parseQtyText('.5')).toBe(500)
    expect(parseQtyText('3.')).toBe(3_000)
  })
  it('never goes through floats: 0.1 + 0.2-style values and long decimals round half-up exactly', () => {
    expect(parseQtyText('1.005')).toBe(1_005)
    expect(parseQtyText('2.0005')).toBe(2_001)
    expect(parseQtyText('2.0004')).toBe(2_000)
    expect(parseQtyText('9007199254740.991')).toBe(9_007_199_254_740_991)
  })
  it('0 is a quantity (a count); blank and junk are null', () => {
    expect(parseQtyText('0')).toBe(0)
    expect(parseQtyText('')).toBeNull()
    expect(parseQtyText('   ')).toBeNull()
    expect(parseQtyText('abc')).toBeNull()
    expect(parseQtyText('1,5')).toBeNull()
    expect(parseQtyText('-2')).toBeNull()
    expect(parseQtyText('2 Nos')).toBeNull()
    expect(parseQtyText('.')).toBeNull()
    expect(parseQtyText('99999999999999999')).toBeNull()
  })
  it('a comma typed for a decimal point is refused, never read 100x too large (review #192)', () => {
    expect(parseQtyText('1,50')).toBeNull()
    expect(parseQtyText('12,34')).toBeNull()
    expect(parseQtyText('1,500,00')).toBeNull()
    expect(parseQtyText('1,500,000')).toBe(1_500_000_000)
    expect(parseQtyText('12,34,567')).toBe(1_234_567_000)
  })
})

describe('stock lines refuse an unreadable quantity (review #192)', () => {
  const state = (qtyText: string, isAbsolute: boolean) => ({
    ...emptyStockLinesState('2026-08-01'),
    rows: [{ ...blankStockLineRow('in'), itemId: 1, qtyText, isAbsolute }]
  })
  it.each(['abc', '-2', '1,5', '2 Nos', '1e3', ''])('count row "%s" is an error, not a count of 0', (t) => {
    expect(buildStockLinesPayload(state(t, true), { voucherTypeId: 1 }).ok).toBe(false)
  })
  it('a count of 0 typed as 0 is still a count', () => {
    expect(buildStockLinesPayload(state('0', true), { voucherTypeId: 1 }).ok).toBe(true)
  })
})

describe('the invoice editor reads a grouped quantity', () => {
  const ctx: InvoiceContext = {
    kind: 'sales', companyStateCode: '27', gstRegistrationType: 'regular',
    items: new Map([[1, { gstRate: 0, cessRate: null }]]), ledgers: new Map([[10, { stateCode: '27', gstRate: null }]])
  }
  it('1,500 x ₹2 = ₹3,000 (was 1 x ₹2)', () => {
    const c = computeInvoice({ ...emptyInvoiceState('2026-08-01'), partyId: 10, accountId: 20, rows: [{ itemId: 1, qtyText: '1,500', rate: 200, discount: null, godownId: null, batchId: null }] }, ctx)
    expect(c.detail.map((d) => [d.qtyMilli, d.amount])).toEqual([[1_500_000, 300_000]])
  })
})
