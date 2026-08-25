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

describe('a difference too big to be rounding', () => {
  // `Math.abs(diff) > limit` is what refuses a difference that is a mistake rather than a
  // rounding artefact. Without the Math.abs the comparison is `diff > limit`, which is false for
  // every NEGATIVE difference however large — so a credit-heavy voucher out by ₹500 would be
  // silently plugged with a ₹500 round-off line instead of refused. Only a negative overshoot
  // tells the two apart, and the suite only had positive ones (roadmap #327).
  it('refuses one, whichever side it falls on', () => {
    const over = ROUND_OFF_LIMIT_PAISE + 1
    expect(roundOffLine(over, 0)).toBeNull()
    expect(roundOffLine(0, over)).toBeNull()
    expect(roundOffLine(1000, 1000 + over)).toBeNull()
  })

  it('still plugs one that is exactly at the limit, on either side', () => {
    const at = ROUND_OFF_LIMIT_PAISE
    expect(roundOffLine(at, 0)).toEqual({ drCr: 'cr', amount: at })
    expect(roundOffLine(0, at)).toEqual({ drCr: 'dr', amount: at })
  })
})

