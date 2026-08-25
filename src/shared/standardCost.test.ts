import { describe, expect, it } from 'vitest'
import {
  extendCost,
  standardCostOn,
  summariseVariance,
  varianceBp,
  varianceOf,
  type VarianceLine
} from './standardCost'

describe('extendCost', () => {
  it('multiplies thousandths by a paise rate exactly', () => {
    expect(extendCost(1000, 25_000)).toBe(25_000) // 1 unit at ₹250
    expect(extendCost(2500, 10_000)).toBe(25_000) // 2.5 units at ₹100
  })

  it('rounds half away from zero rather than toward it', () => {
    // 1 thousandth at ₹5.00 is 0.5 paise.
    expect(extendCost(1, 500)).toBe(1)
    expect(extendCost(-1, 500)).toBe(-1)
  })

  it('stays exact where a double would not', () => {
    // 1,00,000 units at ₹1,00,000 → 10^16 milli-paise before the divide.
    expect(extendCost(100_000_000, 10_000_000)).toBe(1_000_000_000_000)
  })
})

describe('standardCostOn', () => {
  const rows = [
    { effectiveFrom: '2025-04-01', standardCost: 20_000 },
    { effectiveFrom: '2025-10-01', standardCost: 22_000 },
    { effectiveFrom: '2026-04-01', standardCost: 24_000 }
  ]

  it('answers with the standard in force on the day, not the latest one', () => {
    expect(standardCostOn(rows, '2025-09-30')).toBe(20_000)
    expect(standardCostOn(rows, '2025-10-01')).toBe(22_000)
    expect(standardCostOn(rows, '2026-01-15')).toBe(22_000)
  })

  it('a revision in October leaves September saying what it said', () => {
    // The whole reason this is a table and not a column.
    const beforeRevision = [rows[0]!]
    expect(standardCostOn(beforeRevision, '2025-09-15')).toBe(20_000)
    expect(standardCostOn(rows, '2025-09-15')).toBe(20_000)
  })

  it('is null before the first standard, rather than guessing the first one backwards', () => {
    expect(standardCostOn(rows, '2025-03-31')).toBeNull()
    expect(standardCostOn([], '2026-01-01')).toBeNull()
  })
})

describe('varianceOf', () => {
  it('splits a purchase into a pure price variance', () => {
    // 100 units standard ₹200; actually paid ₹21,000 for the hundred.
    const v = varianceOf({ actualQtyMilli: 100_000, actualCostPaise: 2_100_000, standardRatePaise: 20_000 })
    expect(v.standardCostPaise).toBe(2_000_000)
    expect(v.priceVariancePaise).toBe(100_000)
    expect(v.usageVariancePaise).toBe(0)
    expect(v.totalVariancePaise).toBe(100_000)
    expect(v.verdict).toBe('adverse')
  })

  it('splits an over-consumption into a pure usage variance', () => {
    // Standard says 100 units; 110 were consumed, all at exactly standard rate.
    const v = varianceOf({
      actualQtyMilli: 110_000,
      actualCostPaise: 2_200_000,
      standardRatePaise: 20_000,
      standardQtyMilli: 100_000
    })
    expect(v.priceVariancePaise).toBe(0)
    expect(v.usageVariancePaise).toBe(200_000)
    expect(v.totalVariancePaise).toBe(200_000)
  })

  it('splits a line that is wrong in both ways, and the two still add to the total', () => {
    const v = varianceOf({
      actualQtyMilli: 110_000,
      actualCostPaise: 2_420_000, // ₹220 a unit against a ₹200 standard
      standardRatePaise: 20_000,
      standardQtyMilli: 100_000
    })
    expect(v.priceVariancePaise).toBe(220_000)
    expect(v.usageVariancePaise).toBe(200_000)
    expect(v.totalVariancePaise).toBe(420_000)
    expect(v.priceVariancePaise + v.usageVariancePaise).toBe(v.totalVariancePaise)
  })

  it('calls buying under standard favourable', () => {
    const v = varianceOf({ actualQtyMilli: 100_000, actualCostPaise: 1_900_000, standardRatePaise: 20_000 })
    expect(v.totalVariancePaise).toBe(-100_000)
    expect(v.verdict).toBe('favourable')
  })

  it('says "on standard" rather than favourable when it is exactly right', () => {
    const v = varianceOf({ actualQtyMilli: 100_000, actualCostPaise: 2_000_000, standardRatePaise: 20_000 })
    expect(v.verdict).toBe('on standard')
  })

  it('the two components add to the total even where a rate does not divide evenly', () => {
    // ₹1,000 for 3 units is ₹333.3333… a unit. Deriving the actual RATE first and multiplying it
    // back up is what this rounds-once design exists to avoid; the identity has to hold anyway.
    const v = varianceOf({
      actualQtyMilli: 3000,
      actualCostPaise: 100_000,
      standardRatePaise: 30_000,
      standardQtyMilli: 2000
    })
    expect(v.priceVariancePaise + v.usageVariancePaise).toBe(v.totalVariancePaise)
    expect(v.totalVariancePaise).toBe(100_000 - 60_000)
  })

  it('treats a missing standard quantity as "no yardstick", not as zero', () => {
    // Omitting standardQtyMilli must not make the usage variance the whole cost.
    const v = varianceOf({ actualQtyMilli: 5000, actualCostPaise: 100_000, standardRatePaise: 20_000 })
    expect(v.usageVariancePaise).toBe(0)
  })
})

describe('summariseVariance', () => {
  const line = (over: Partial<VarianceLine>): VarianceLine => ({
    stockItemId: 1,
    name: 'Steel',
    actualQtyMilli: 100_000,
    standardQtyMilli: 100_000,
    standardRatePaise: 20_000,
    ...varianceOf({ actualQtyMilli: 100_000, actualCostPaise: 2_100_000, standardRatePaise: 20_000 }),
    ...over
  })

  it('adds the columns up to what is on screen', () => {
    const s = summariseVariance([line({}), line({ stockItemId: 2, name: 'Copper' })])
    expect(s.actualCostPaise).toBe(4_200_000)
    expect(s.standardCostPaise).toBe(4_000_000)
    expect(s.totalVariancePaise).toBe(200_000)
    expect(s.priceVariancePaise + s.usageVariancePaise).toBe(s.totalVariancePaise)
  })

  it('carries the items with no standard through rather than scoring them zero', () => {
    const s = summariseVariance([line({})], [{ stockItemId: 9, name: 'Packing', actualCostPaise: 50_000 }])
    expect(s.withoutStandard).toHaveLength(1)
    // And they are not silently folded into the totals, which would read as "on standard".
    expect(s.actualCostPaise).toBe(2_100_000)
  })
})

describe('varianceBp', () => {
  it('is basis points of the standard', () => {
    expect(varianceBp({ totalVariancePaise: 100_000, standardCostPaise: 2_000_000 })).toBe(500)
    expect(varianceBp({ totalVariancePaise: -100_000, standardCostPaise: 2_000_000 })).toBe(-500)
  })

  it('is null, not zero, when there is no standard to be a percentage of', () => {
    expect(varianceBp({ totalVariancePaise: 100_000, standardCostPaise: 0 })).toBeNull()
  })
})
