import { describe, it, expect } from 'vitest'
import {
  apportionDiscount,
  applyInvoiceDiscount,
  discountFromPercent,
  InvoiceDiscountError
} from './invoiceDiscount'

describe('apportionDiscount (I-203 — an invoice-level discount lands on the lines)', () => {
  it('splits in proportion to line value', () => {
    expect(apportionDiscount([10_000, 30_000], 4_000)).toEqual([1_000, 3_000])
  })

  it('always adds back up to exactly the discount, however awkward the split', () => {
    // 100 paise across three equal lines is 33.33… each; the parts must still total 100.
    const parts = apportionDiscount([1_000, 1_000, 1_000], 100)
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100)
    expect(parts).toEqual([34, 33, 33])
  })

  it('hands the leftover paise to the largest remainders, ties broken by line order', () => {
    const parts = apportionDiscount([100, 100, 100, 100], 3)
    expect(parts).toEqual([1, 1, 1, 0])
    expect(parts.reduce((s, p) => s + p, 0)).toBe(3)
  })

  it('is stable — the same invoice apportions the same way every time', () => {
    const once = apportionDiscount([7_777, 3_333, 999], 501)
    const twice = apportionDiscount([7_777, 3_333, 999], 501)
    expect(once).toEqual(twice)
  })

  it('gives a zero-value line nothing, so no line can go negative', () => {
    const parts = apportionDiscount([0, 5_000, 0], 999)
    expect(parts[0]).toBe(0)
    expect(parts[2]).toBe(0)
    expect(parts[1]).toBe(999)
  })

  it('apportions a zero discount as all zeroes rather than refusing', () => {
    expect(apportionDiscount([100, 200], 0)).toEqual([0, 0])
  })

  it('refuses a discount larger than the invoice', () => {
    expect(() => apportionDiscount([1_000], 1_001)).toThrow(InvoiceDiscountError)
  })

  it('allows a discount of exactly the whole invoice', () => {
    expect(apportionDiscount([1_000, 1_000], 2_000)).toEqual([1_000, 1_000])
  })

  it('refuses a negative discount', () => {
    expect(() => apportionDiscount([1_000], -1)).toThrow('cannot be negative')
  })

  it('refuses a fractional paisa, which is not money', () => {
    expect(() => apportionDiscount([1_000], 10.5)).toThrow('whole number of paise')
  })

  it('refuses to discount an invoice whose lines are all zero', () => {
    expect(() => apportionDiscount([0, 0], 100)).toThrow('every line is zero')
  })

  it('handles an invoice with no lines at all as a zero discount', () => {
    expect(apportionDiscount([], 0)).toEqual([])
  })
})

describe('discountFromPercent', () => {
  it('turns a percentage of the bill into whole paise', () => {
    expect(discountFromPercent(100_000, 2)).toBe(2_000)
  })

  it('accepts a fractional rate but never returns a fractional paisa', () => {
    expect(Number.isInteger(discountFromPercent(33_333, 2.5))).toBe(true)
    expect(discountFromPercent(33_333, 2.5)).toBe(833)
  })

  it('refuses more than the whole bill', () => {
    expect(() => discountFromPercent(100, 101)).toThrow('exceed 100%')
  })
})

describe('applyInvoiceDiscount (folding it into the line discounts)', () => {
  it('adds to the line discount and reduces the line amount by the same paise', () => {
    const applied = applyInvoiceDiscount(
      [
        { amountPaise: 10_000, lineDiscountPaise: 500 },
        { amountPaise: 10_000, lineDiscountPaise: 0 }
      ],
      1_000
    )
    expect(applied.lines[0]).toEqual({ apportionedPaise: 500, totalDiscountPaise: 1_000, amountPaise: 9_500 })
    expect(applied.lines[1]).toEqual({ apportionedPaise: 500, totalDiscountPaise: 500, amountPaise: 9_500 })
  })

  it('reports back exactly what it apportioned, so the invoice total can be trusted', () => {
    const applied = applyInvoiceDiscount(
      [
        { amountPaise: 1_111, lineDiscountPaise: 0 },
        { amountPaise: 2_222, lineDiscountPaise: 0 },
        { amountPaise: 3_333, lineDiscountPaise: 0 }
      ],
      777
    )
    expect(applied.discountPaise).toBe(777)
    expect(applied.lines.reduce((s, l) => s + l.amountPaise, 0)).toBe(1_111 + 2_222 + 3_333 - 777)
  })
})
