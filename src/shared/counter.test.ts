import { describe, it, expect } from 'vitest'
import {
  changeBreakdown,
  countDenominations,
  priceCart,
  priceLine,
  reconcileDrawer,
  settleTender,
  type CartLineInput
} from './counter'

const line = (over: Partial<CartLineInput> = {}): CartLineInput => ({
  stockItemId: 1,
  name: 'Parle-G 200g',
  code: 'PG200',
  qtyMilli: 1000,
  ratePaise: 10000,
  gstRate: 18,
  ...over
})

describe('pricing a counter line', () => {
  it('adds tax on top of an exclusive rate', () => {
    const l = priceLine(line(), 'intra', 'exclusive')
    expect(l.taxablePaise).toBe(10000)
    expect(l.gst.cgst).toBe(900)
    expect(l.gst.sgst).toBe(900)
    expect(l.totalPaise).toBe(11800)
  })

  it('backs tax out of a shelf price, so the customer pays the number on the label', () => {
    const l = priceLine(line({ ratePaise: 11800 }), 'intra', 'inclusive')
    expect(l.taxablePaise).toBe(10000)
    expect(l.totalPaise).toBe(11800)
    expect(l.gst.cgst + l.gst.sgst).toBe(1800)
  })

  it('puts a rounding paisa on the tax, never on the shelf price', () => {
    // 99.00 inclusive of 18% backs out to 83.8983…, which cannot be split evenly.
    const l = priceLine(line({ ratePaise: 9900 }), 'intra', 'inclusive')
    expect(l.totalPaise).toBe(9900)
    expect(l.taxablePaise + l.gst.cgst + l.gst.sgst + l.gst.igst + l.gst.cess).toBe(9900)
  })

  it('splits an inter-state supply as IGST', () => {
    const l = priceLine(line(), 'inter', 'exclusive')
    expect(l.gst.igst).toBe(1800)
    expect(l.gst.cgst).toBe(0)
  })

  it('prices a fractional quantity without a float touching the amount', () => {
    const l = priceLine(line({ qtyMilli: 1500, ratePaise: 3333 }), 'intra', 'exclusive')
    expect(l.grossPaise).toBe(5000) // 1.5 x 33.33 = 49.995 -> 50.00
    expect(Number.isInteger(l.taxablePaise)).toBe(true)
  })

  it('takes the discount off before tax, not after', () => {
    const l = priceLine(line({ discountPaise: 1000 }), 'intra', 'exclusive')
    expect(l.taxablePaise).toBe(9000)
    expect(l.gst.cgst).toBe(810)
  })

  it('flags a line sold under what the stock cost, and says by how much', () => {
    const l = priceLine(line({ ratePaise: 8000, costPaise: 9000 }), 'intra', 'exclusive')
    expect(l.belowCost).toBe(true)
    expect(l.belowCostBy).toBe(1000)
  })

  it('says nothing about cost when the item has never been bought', () => {
    // Null is not zero: an item with no purchase history cannot be sold below a cost nobody knows.
    const l = priceLine(line({ ratePaise: 1, costPaise: null }), 'intra', 'exclusive')
    expect(l.belowCost).toBe(false)
  })
})

describe('pricing a cart', () => {
  it('groups taxable value by rate, which is how the voucher posts', () => {
    const c = priceCart(
      [line({ gstRate: 18 }), line({ stockItemId: 2, gstRate: 5, ratePaise: 20000 }), line({ stockItemId: 3, gstRate: 18 })],
      'intra',
      'exclusive'
    )
    expect(c.byRate.map((b) => b.gstRate)).toEqual([5, 18])
    expect(c.byRate.find((b) => b.gstRate === 18)!.taxable).toBe(20000)
  })

  it('rounds the payable to the rupee and reports the difference', () => {
    const c = priceCart([line({ ratePaise: 9999 })], 'intra', 'exclusive')
    expect(c.payablePaise % 100).toBe(0)
    expect(c.payablePaise - c.netPaise).toBe(c.roundOffPaise)
  })

  it('an empty cart is payable zero rather than an error', () => {
    const c = priceCart([], 'intra', 'exclusive')
    expect(c.payablePaise).toBe(0)
    expect(c.byRate).toEqual([])
  })
})

describe('tender and change', () => {
  it('gives change out of cash', () => {
    const t = settleTender(11800, [{ mode: 'cash', amountPaise: 20000 }])
    expect(t.changePaise).toBe(8200)
    expect(t.cashInDrawerPaise).toBe(11800)
    expect(t.shortPaise).toBe(0)
  })

  it('never settles a card overpayment out of the till', () => {
    const t = settleTender(10000, [{ mode: 'card', amountPaise: 15000 }])
    expect(t.changePaise).toBe(0)
    expect(t.cashInDrawerPaise).toBe(0)
  })

  it('splits a part-cash part-card tender', () => {
    const t = settleTender(50000, [
      { mode: 'cash', amountPaise: 20000 },
      { mode: 'upi', amountPaise: 30000 }
    ])
    expect(t.changePaise).toBe(0)
    expect(t.cashInDrawerPaise).toBe(20000)
  })

  it('reports what is still owed when the tender falls short', () => {
    const t = settleTender(50000, [{ mode: 'cash', amountPaise: 20000 }])
    expect(t.shortPaise).toBe(30000)
  })

  it('separates credit from money', () => {
    const t = settleTender(50000, [{ mode: 'credit', amountPaise: 50000 }])
    expect(t.creditPaise).toBe(50000)
    expect(t.cashInDrawerPaise).toBe(0)
    expect(t.shortPaise).toBe(0)
  })

  it('breaks change into notes a cashier actually has', () => {
    const b = changeBreakdown(8200)
    expect(countDenominations(b)).toBe(8200)
    expect(b[0]!.denomination).toBe(5000)
  })
})

describe('the drawer', () => {
  const movements = {
    openingFloatPaise: 200000,
    cashSalesPaise: 500000,
    cashRefundsPaise: 20000,
    payoutsPaise: 100000,
    payinsPaise: 0
  }

  it('expects float plus sales less refunds and payouts', () => {
    const r = reconcileDrawer(movements, null)
    expect(r.expectedPaise).toBe(580000)
    expect(r.status).toBe('open')
  })

  it('calls a short drawer short, with a signed variance', () => {
    const r = reconcileDrawer(movements, 575000)
    expect(r.variancePaise).toBe(-5000)
    expect(r.status).toBe('short')
  })

  it('a drawer that is over is a different problem from one that is short', () => {
    expect(reconcileDrawer(movements, 585000).status).toBe('over')
    expect(reconcileDrawer(movements, 580000).status).toBe('balanced')
  })

  it('counts a drawer from its notes and coins', () => {
    expect(countDenominations([{ denomination: 50000, count: 11 }, { denomination: 2000, count: 15 }])).toBe(580000)
  })
})
