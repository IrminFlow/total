import { describe, it, expect } from 'vitest'
import { resolvePostedRates } from './postedRate'

const D = '2026-07-05'
// Before the 22 Sep 2025 change 12 % / 28 % are slabs of the date (rateTable.ts).
const OLD = '2025-07-05'

describe('resolvePostedRates', () => {
  it('rate-less line + posted CGST/SGST 18% -> 18 (a known slab)', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: null }], 18000, 'intra', D)).toEqual({ rates: [18], derived: true, offSlab: false })
  })
  it('inter-state IGST and 5% / 12%', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: null }], 18000, 'inter', D).rates).toEqual([18])
    expect(resolvePostedRates([{ taxable: 200000, rate: null }], 10000, 'intra', D).rates).toEqual([5])
    expect(resolvePostedRates([{ taxable: 200000, rate: null }], 24000, 'intra', OLD)).toEqual({ rates: [12], derived: true, offSlab: false })
  })
  it('a note dated after 22 Sep 2025 at an earlier slab (12% / 28%, its original bill) is not off-slab', () => {
    expect(resolvePostedRates([{ taxable: 10000, rate: null }], 1200, 'intra', D)).toEqual({ rates: [12], derived: true, offSlab: false })
    expect(resolvePostedRates([{ taxable: 10000, rate: null }], 2800, 'inter', D)).toEqual({ rates: [28], derived: true, offSlab: false })
  })
  it('keeps ledger rates; only the rate-less line takes the remainder (net of the rated lines\' tax)', () => {
    // 18% on 1,000 = 180 explained; 230 - 180 = 50 on the other 1,000 = 5%.
    const r = resolvePostedRates([{ taxable: 100000, rate: 18 }, { taxable: 100000, rate: null }], 23000, 'intra', D)
    expect(r.rates).toEqual([18, 5])
    // Not the whole tax over the rate-less value (230 / 1,000 = 23%).
    expect(r.offSlab).toBe(false)
  })
  it('an explicit 0% ledger (declared nil / exempt) is never given a rate', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: 18 }, { taxable: 100000, rate: 0 }], 23000, 'intra', D)).toEqual({
      rates: [18, 0], derived: false, offSlab: false
    })
    expect(resolvePostedRates([{ taxable: 100000, rate: 0 }], 18000, 'intra', D)).toEqual({ rates: [0], derived: false, offSlab: false })
  })
  it('no posted tax -> the ledger rates, untouched', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: null }], 0, 'intra', D)).toEqual({ rates: [0], derived: false, offSlab: false })
    expect(resolvePostedRates([{ taxable: 100000, rate: 12 }], 0, 'intra', D).rates).toEqual([12])
    expect(resolvePostedRates([{ taxable: 100000, rate: null }], -500, 'intra', D).rates).toEqual([0])
  })
  it('rated lines whose own tax explains the posting are untouched (a rounding remainder is not a rate)', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: 18 }, { taxable: 500, rate: null }], 18001, 'intra', D)).toEqual({
      rates: [18, 0], derived: false, offSlab: false
    })
    // Tax ledgers rounded to the rupee: 18% on 1,234.56 = 111.11 + 111.11, posted 111 + 111.
    expect(resolvePostedRates([{ taxable: 123456, rate: 18 }, { taxable: 5000, rate: null }], 22200, 'intra', D).rates).toEqual([18, 0])
  })
  it('tax rounded to the rupee per head still snaps to its slab (not off-slab)', () => {
    // 18% on 1,234.56: CGST 111.11 / SGST 111.11 -> posted 111 + 111 = 222.00 (22 paise short).
    expect(resolvePostedRates([{ taxable: 123456, rate: null }], 22200, 'intra', D)).toEqual({ rates: [18], derived: true, offSlab: false })
  })
  it('a sub-rupee round-off line in an income group keeps 0; the supply takes the rate', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: null }, { taxable: 30, rate: null }], 18000, 'intra', D)).toEqual({
      rates: [18, 0], derived: true, offSlab: false
    })
  })
  it('several rate-less lines at different true rates get one blended rate, flagged when it fits no slab', () => {
    // 1,000 at 5% (50) + 1,000 at 18% (180) = 230 on 2,000 = 11.5%.
    expect(resolvePostedRates([{ taxable: 100000, rate: null }, { taxable: 100000, rate: null }], 23000, 'intra', D)).toEqual({
      rates: [11.5, 11.5], derived: true, offSlab: true
    })
  })
  it('a posting that matches no slab is reported at the implied rate and flagged', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: null }], 3400, 'intra', D)).toEqual({ rates: [3.4], derived: true, offSlab: true })
    // Hand-edited: 18% tax + ₹50 typed on top.
    expect(resolvePostedRates([{ taxable: 100000, rate: null }], 23000, 'intra', D)).toEqual({ rates: [23], derived: true, offSlab: true })
  })
  it('the implied rate is exact on large amounts (no float overflow) and rounds half-up at 4 decimals', () => {
    // ₹5,000 crore taxable, ₹170.0017 crore tax -> 3.400034% -> 3.4
    expect(resolvePostedRates([{ taxable: 5_000_000_000_000, rate: null }], 170_001_700_000, 'inter', D).rates).toEqual([3.4])
    // 1/3 % -> 0.3333
    expect(resolvePostedRates([{ taxable: 300000, rate: null }], 1000, 'inter', D).rates).toEqual([0.3333])
  })
})
