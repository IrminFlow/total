import { describe, it, expect } from 'vitest'
import { buildGstr4, compositionRate, computeCmp08, COMPOSITION_CATEGORIES, type Cmp08 } from './composition'
import { formatPaise } from '../money'

const base = {
  category: 'trader' as const,
  outwardTurnover: 10_00_000_00, // Rs 10,00,000
  inwardReverseCharge: 0,
  reverseChargeTax: 0
}

describe('composition rates', () => {
  it('carries the three categories the scheme defines', () => {
    expect(COMPOSITION_CATEGORIES.map((c) => c.id)).toEqual(['trader', 'restaurant', 'service'])
  })

  it('reads the rate for each', () => {
    expect(compositionRate('trader')).toBe(1)
    expect(compositionRate('restaurant')).toBe(5)
    expect(compositionRate('service')).toBe(6)
  })
})

describe('CMP-08', () => {
  it('taxes turnover, not invoice tax', () => {
    // A composition dealer charges no tax to the customer; the liability is a slice of turnover.
    const c = computeCmp08(base)
    expect(formatPaise(c.cgst + c.sgst)).toBe('10,000.00')
    expect(c.ratePercent).toBe(1)
  })

  it('splits the tax so the halves always re-add to the whole', () => {
    // An odd total is where a naive half-each drops a paisa, and a statement that does not foot
    // is one the portal rejects.
    const odd = computeCmp08({ ...base, outwardTurnover: 33_333_33 })
    expect(odd.cgst + odd.sgst).toBe(Math.round((33_333_33 * 1) / 100))
    expect(Math.abs(odd.cgst - odd.sgst)).toBeLessThanOrEqual(1)
  })

  it('applies the restaurant and service rates', () => {
    expect(formatPaise(computeCmp08({ ...base, category: 'restaurant' }).totalPayable)).toBe('50,000.00')
    expect(formatPaise(computeCmp08({ ...base, category: 'service' }).totalPayable)).toBe('60,000.00')
  })

  it('adds reverse charge on top rather than into the turnover computation', () => {
    // The dealer owes this as a recipient, so it is not a percentage of their own turnover.
    const c = computeCmp08({ ...base, inwardReverseCharge: 1_00_000_00, reverseChargeTax: 18_000_00 })
    expect(c.cgst + c.sgst).toBe(10_000_00)
    expect(c.reverseChargeTax).toBe(18_000_00)
    expect(c.totalPayable).toBe(10_000_00 + 18_000_00)
  })

  it('includes interest and late fee in what is payable', () => {
    const c = computeCmp08({ ...base, interest: 500_00, lateFee: 200_00 })
    expect(c.totalPayable).toBe(10_000_00 + 500_00 + 200_00)
  })

  it('handles a nil quarter without inventing a liability', () => {
    const c = computeCmp08({ ...base, outwardTurnover: 0 })
    expect(c.totalPayable).toBe(0)
    expect(c.cgst).toBe(0)
    expect(c.sgst).toBe(0)
  })

  it('never produces a fraction of a paisa', () => {
    for (const turnover of [1, 7, 333_33, 99_999_99, 12_34_567_89]) {
      const c = computeCmp08({ ...base, outwardTurnover: turnover })
      expect(Number.isInteger(c.cgst) && Number.isInteger(c.sgst), String(turnover)).toBe(true)
    }
  })
})

describe('GSTR-4', () => {
  const quarter = (q: string, turnover: number): { quarter: string; cmp08: Cmp08 } => ({
    quarter: q,
    cmp08: computeCmp08({ ...base, outwardTurnover: turnover })
  })

  it('totals the four quarters', () => {
    const r = buildGstr4('2026-27', [
      quarter('Q1', 10_00_000_00),
      quarter('Q2', 20_00_000_00),
      quarter('Q3', 30_00_000_00),
      quarter('Q4', 40_00_000_00)
    ])
    expect(formatPaise(r.totalTurnover)).toBe('1,00,00,000.00')
    expect(formatPaise(r.totalCgst + r.totalSgst)).toBe('1,00,000.00')
    expect(r.missingQuarters).toEqual([])
  })

  it('reports a missing quarter instead of totalling three and looking complete', () => {
    const r = buildGstr4('2026-27', [quarter('Q1', 10_00_000_00), quarter('Q3', 10_00_000_00)])
    expect(r.missingQuarters).toEqual(['Q2', 'Q4'])
    expect(r.quarters).toHaveLength(2)
  })

  it('orders quarters chronologically however they were supplied', () => {
    const r = buildGstr4('2026-27', [quarter('Q3', 1), quarter('Q1', 1), quarter('Q4', 1), quarter('Q2', 1)])
    expect(r.quarters.map((q) => q.quarter)).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
  })

  it('an empty year is empty, not zero-and-complete', () => {
    const r = buildGstr4('2026-27', [])
    expect(r.totalPayable).toBe(0)
    expect(r.missingQuarters).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
  })
})
