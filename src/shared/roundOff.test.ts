import { describe, it, expect } from 'vitest'
import { isRoundingDifference, roundOffLine, ROUND_OFF_LIMIT_PAISE } from './roundOff'

describe('roundOffLine', () => {
  it('plugs a debit-heavy voucher with a credit', () => {
    expect(roundOffLine(100050, 100000)).toEqual({ drCr: 'cr', amount: 50 })
  })

  it('plugs a credit-heavy voucher with a debit', () => {
    expect(roundOffLine(100000, 100050)).toEqual({ drCr: 'dr', amount: 50 })
  })

  it('offers nothing on a balanced voucher', () => {
    expect(roundOffLine(100000, 100000)).toBeNull()
  })

  it('offers nothing on an empty voucher — nothing entered is not a rounding difference', () => {
    expect(roundOffLine(0, 0)).toBeNull()
  })

  it('refuses a difference of a rupee or more, which is a mistake and not arithmetic', () => {
    expect(roundOffLine(100100, 100000)).toBeNull()
    // The boundary itself is still arithmetic: 99 paise is the most rupee-rounding can produce.
    expect(roundOffLine(100000 + ROUND_OFF_LIMIT_PAISE, 100000)).toEqual({ drCr: 'cr', amount: 99 })
  })

  it('honours a caller-supplied limit', () => {
    expect(roundOffLine(100005, 100000, 3)).toBeNull()
    expect(roundOffLine(100003, 100000, 3)).toEqual({ drCr: 'cr', amount: 3 })
  })
})

describe('isRoundingDifference', () => {
  it('agrees with roundOffLine', () => {
    expect(isRoundingDifference(100050, 100000)).toBe(true)
    expect(isRoundingDifference(100000, 100000)).toBe(false)
    expect(isRoundingDifference(200000, 100000)).toBe(false)
  })
})
