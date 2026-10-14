import { describe, it, expect } from 'vitest'
import { resolvePostedRates } from './postedRate'

const D = '2026-07-05'

describe('resolvePostedRates', () => {
  it('rate-less line + posted CGST/SGST 18% -> 18 (a known slab)', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: 0 }], 18000, 'intra', D)).toEqual({ rates: [18], derived: true, offSlab: false })
  })
  it('inter-state IGST and 5% / 12%', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: 0 }], 18000, 'inter', D).rates).toEqual([18])
    expect(resolvePostedRates([{ taxable: 200000, rate: 0 }], 10000, 'intra', D).rates).toEqual([5])
    expect(resolvePostedRates([{ taxable: 200000, rate: 0 }], 24000, 'intra', D).rates).toEqual([12])
  })
  it('keeps ledger rates; only the rate-less line takes the remainder', () => {
    const r = resolvePostedRates([{ taxable: 100000, rate: 18 }, { taxable: 100000, rate: 0 }], 23000, 'intra', D)
    expect(r.rates).toEqual([18, 5])
  })
  it('no posted tax -> the ledger rates, untouched', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: 0 }], 0, 'intra', D)).toEqual({ rates: [0], derived: false, offSlab: false })
    expect(resolvePostedRates([{ taxable: 100000, rate: 12 }], 0, 'intra', D).rates).toEqual([12])
  })
  it('rated lines whose own tax explains the posting are untouched (a rounding remainder is not a rate)', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: 18 }, { taxable: 500, rate: 0 }], 18001, 'intra', D)).toEqual({
      rates: [18, 0], derived: false, offSlab: false
    })
  })
  it('a posting that matches no slab is reported at the implied rate and flagged', () => {
    expect(resolvePostedRates([{ taxable: 100000, rate: 0 }], 3400, 'intra', D)).toEqual({ rates: [3.4], derived: true, offSlab: true })
  })
})
