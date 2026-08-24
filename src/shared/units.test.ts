import { describe, expect, it } from 'vitest'
import { describeConversion, parseQtyWithUnit, toAlt, toBase, validConversion } from './units'
import { AT_RISK_BUCKETS, daysToExpiry, EXPIRY_BUCKETS, expiryBucketOf, summariseExpiry } from './valuation'

describe('alternate units', () => {
  const box = { symbol: 'box', conversionMilli: 12_000 }

  it('converts both ways without a float touching a quantity', () => {
    expect(toBase(2_000, box.conversionMilli)).toBe(24_000)
    expect(toAlt(24_000, box.conversionMilli)).toBe(2_000)
    // A part box survives the round trip.
    expect(toAlt(toBase(1_500, box.conversionMilli), box.conversionMilli)).toBe(1_500)
  })

  it('refuses a conversion that would divide by zero or invert the stock', () => {
    expect(validConversion(0)).toBe(false)
    expect(validConversion(-12_000)).toBe(false)
    expect(validConversion(1.5)).toBe(false)
    expect(validConversion(12_000)).toBe(true)
    // An invalid conversion passes the quantity through rather than corrupting it.
    expect(toBase(2_000, 0)).toBe(2_000)
  })

  it('reads a bare number as base units', () => {
    expect(parseQtyWithUnit('24', 'pcs', box)).toEqual({ baseQtyMilli: 24_000, usedAlt: false })
    expect(parseQtyWithUnit('24 pcs', 'pcs', box)).toEqual({ baseQtyMilli: 24_000, usedAlt: false })
    expect(parseQtyWithUnit('2.5', 'kg', null)).toEqual({ baseQtyMilli: 2_500, usedAlt: false })
  })

  it('reads the alternate unit and converts it', () => {
    expect(parseQtyWithUnit('2 box', 'pcs', box)).toEqual({ baseQtyMilli: 24_000, usedAlt: true })
    expect(parseQtyWithUnit('2BOX', 'pcs', box)).toEqual({ baseQtyMilli: 24_000, usedAlt: true })
  })

  it('refuses a unit it does not know rather than guessing', () => {
    expect(parseQtyWithUnit('2 crate', 'pcs', box)).toBeNull()
    expect(parseQtyWithUnit('2 box', 'pcs', null)).toBeNull()
    expect(parseQtyWithUnit('', 'pcs', box)).toBeNull()
    expect(parseQtyWithUnit('two', 'pcs', box)).toBeNull()
    expect(parseQtyWithUnit('1 2 3', 'pcs', box)).toBeNull()
  })

  it('shows the conversion in words while it is being typed', () => {
    expect(describeConversion(2_000, 'pcs', box, 0)).toBe('2 box = 24 pcs')
  })
})

describe('expiry buckets and their value', () => {
  it('has a label for every bucket, worst first', () => {
    expect(EXPIRY_BUCKETS.map((b) => b.bucket)).toEqual(['expired', 'within30', 'within90', 'later', 'none'])
    for (const b of EXPIRY_BUCKETS) expect(b.label.length).toBeGreaterThan(0)
  })

  it('counts days to expiry, negative once past', () => {
    expect(daysToExpiry('2026-02-01', '2026-01-01')).toBe(31)
    expect(daysToExpiry('2025-12-25', '2026-01-01')).toBe(-7)
    expect(daysToExpiry(null, '2026-01-01')).toBeNull()
  })

  it('treats today as still usable', () => {
    expect(expiryBucketOf('2026-01-01', '2026-01-01')).toBe('within30')
    expect(expiryBucketOf('2025-12-31', '2026-01-01')).toBe('expired')
  })

  it('calls expired and the next ninety days at risk, and nothing beyond', () => {
    expect([...AT_RISK_BUCKETS].sort()).toEqual(['expired', 'within30', 'within90'])
    expect(AT_RISK_BUCKETS.has('later')).toBe(false)
    expect(AT_RISK_BUCKETS.has('none')).toBe(false)
  })

  it('keeps empty buckets so the table does not change shape month to month', () => {
    const summary = summariseExpiry([
      { bucket: 'expired', value: 100 },
      { bucket: 'expired', value: 50 },
      { bucket: 'later', value: 900 }
    ])
    expect(summary).toHaveLength(EXPIRY_BUCKETS.length)
    expect(summary.find((s) => s.bucket === 'expired')).toMatchObject({ value: 150, batches: 2 })
    expect(summary.find((s) => s.bucket === 'within30')).toMatchObject({ value: 0, batches: 0 })
  })
})
