import { describe, expect, it } from 'vitest'
import {
  FX_GAIN_LOSS_LEDGER,
  RATE_SCALE,
  fcMinorFor,
  formatFc,
  formatRate,
  inrPaiseFor,
  parseRate,
  revaluationEffect,
  revaluationNarration,
  revalue
} from './fx'

describe('inrPaiseFor', () => {
  it('converts a whole dollar at a four-decimal rate', () => {
    // USD 1.00 at ₹83.4525 = ₹83.4525 → 8345.25 paise → 8345.
    expect(inrPaiseFor(100, 83_452_500, 2)).toBe(8345)
  })

  it('converts a real invoice without drifting', () => {
    // USD 1,200.00 at ₹83.4525 = ₹1,00,143.00 exactly.
    expect(inrPaiseFor(120_000, 83_452_500, 2)).toBe(10_014_300)
  })

  it('stays exact past the point a double would not', () => {
    // USD 10,00,000.00 × 83.4525 — the product of the two integers is ~8.3e15, over 2^53 once
    // multiplied out in paise. BigInt is the reason this is the right answer and not a near one.
    expect(inrPaiseFor(100_000_000, 83_452_500, 2)).toBe(8_345_250_000)
  })

  it('rounds half away from zero, in both directions', () => {
    // 1 cent at ₹83.4550 is 8.3455 paise; at 83.4450 it is 8.3445.
    expect(inrPaiseFor(1, 83_455_000, 2)).toBe(83)
    expect(inrPaiseFor(-1, 83_455_000, 2)).toBe(-83)
    // Exactly a half paisa goes away from zero, so a credit and a debit of the same size stay
    // equal and opposite — rounding half-up would make them differ by a paisa and unbalance a
    // revaluation journal.
    expect(inrPaiseFor(5, 1_000_000, 3)).toBe(1) // 0.005 major × ₹1 = 0.5 paise → 1
    expect(inrPaiseFor(-5, 1_000_000, 3)).toBe(-1)
  })

  it('honours a currency with no minor unit at all', () => {
    // JPY has zero decimals: 1,000 yen at ₹0.5612 is ₹561.20.
    expect(inrPaiseFor(1000, 561_200, 0)).toBe(56_120)
  })

  it('refuses a non-integer amount rather than rounding one in silence', () => {
    expect(() => inrPaiseFor(1.5, 83_452_500, 2)).toThrow(/integers/)
  })
})

describe('fcMinorFor', () => {
  it('is the inverse of inrPaiseFor at a clean rate', () => {
    expect(fcMinorFor(10_014_300, 83_452_500, 2)).toBe(120_000)
  })

  it('refuses a zero rate', () => {
    expect(() => fcMinorFor(100, 0, 2)).toThrow(/zero/)
  })
})

describe('parseRate', () => {
  it('reads the forms a rate is actually typed in', () => {
    expect(parseRate('83.4525')).toBe(83_452_500)
    expect(parseRate('83')).toBe(83 * RATE_SCALE)
    expect(parseRate('1,234.5')).toBe(1_234_500_000)
    expect(parseRate(' 0.5 ')).toBe(500_000)
    expect(parseRate('.5')).toBe(500_000)
  })

  it('refuses a seventh decimal instead of rounding it away', () => {
    expect(parseRate('83.45251234')).toBeNull()
  })

  it('refuses nonsense, blanks and zero', () => {
    expect(parseRate('')).toBeNull()
    expect(parseRate('.')).toBeNull()
    expect(parseRate('abc')).toBeNull()
    expect(parseRate('0')).toBeNull()
    expect(parseRate('-5')).toBeNull()
  })
})

describe('formatRate / formatFc', () => {
  it('keeps four decimals and trims beyond them', () => {
    expect(formatRate(83_452_500)).toBe('83.4525')
    expect(formatRate(83_000_000)).toBe('83.0000')
    expect(formatRate(83_452_510)).toBe('83.45251')
  })

  it('groups a foreign amount in threes, not in lakhs', () => {
    expect(formatFc(120_000_00, 2)).toBe('120,000.00')
    expect(formatFc(120_000, 2, 'USD')).toBe('USD 1,200.00')
    expect(formatFc(-120_000, 2, 'USD')).toBe('-USD 1,200.00')
    expect(formatFc(1000, 0, 'JPY')).toBe('JPY 1,000')
  })
})

describe('revalue', () => {
  it('debits an asset that is worth more rupees, and calls it a gain', () => {
    // USD 10,000 booked at ₹82.00 = ₹8,20,000; closing rate ₹83.50 = ₹8,35,000.
    const r = revalue({ fcMinor: 1_000_000, bookPaise: 82_000_000, closingRateMicro: 83_500_000, decimals: 2 })
    expect(r.restatedPaise).toBe(83_500_000)
    expect(r.differencePaise).toBe(1_500_000)
    expect(r.ledgerSide).toBe('dr')
    expect(r.effect).toBe('gain')
    expect(r.isNil).toBe(false)
  })

  it('credits an asset that is worth fewer rupees, and calls it a loss', () => {
    const r = revalue({ fcMinor: 1_000_000, bookPaise: 84_000_000, closingRateMicro: 83_500_000, decimals: 2 })
    expect(r.differencePaise).toBe(-500_000)
    expect(r.ledgerSide).toBe('cr')
    expect(r.effect).toBe('loss')
  })

  it('reads a liability correctly from the same sign rule', () => {
    // A supplier owed USD 5,000, booked at ₹82 (a credit: −₹4,10,000 dr-positive). The rupee
    // weakens to ₹83.50, so the debt costs more: the liability is credited and the loss debited.
    const r = revalue({ fcMinor: -500_000, bookPaise: -41_000_000, closingRateMicro: 83_500_000, decimals: 2 })
    expect(r.restatedPaise).toBe(-41_750_000)
    expect(r.differencePaise).toBe(-750_000)
    expect(r.ledgerSide).toBe('cr')
    expect(r.effect).toBe('loss')
  })

  it('and a liability that shrank is a gain, with no special case for nature', () => {
    const r = revalue({ fcMinor: -500_000, bookPaise: -41_750_000, closingRateMicro: 82_000_000, decimals: 2 })
    expect(r.differencePaise).toBe(750_000)
    expect(r.ledgerSide).toBe('dr')
    expect(r.effect).toBe('gain')
  })

  it('reports nil when the rate has not moved, so nothing gets posted', () => {
    const r = revalue({ fcMinor: 1_000_000, bookPaise: 83_500_000, closingRateMicro: 83_500_000, decimals: 2 })
    expect(r.isNil).toBe(true)
    expect(r.effect).toBe('none')
    expect(r.differencePaise).toBe(0)
  })

  it('revaluing twice at the same rate posts once — the restated figure is the new book value', () => {
    const first = revalue({ fcMinor: 1_000_000, bookPaise: 82_000_000, closingRateMicro: 83_500_000, decimals: 2 })
    const second = revalue({
      fcMinor: 1_000_000,
      bookPaise: first.restatedPaise,
      closingRateMicro: 83_500_000,
      decimals: 2
    })
    expect(second.isNil).toBe(true)
  })

  it('a nil balance revalues to nothing whatever the rate does', () => {
    const r = revalue({ fcMinor: 0, bookPaise: 0, closingRateMicro: 99_000_000, decimals: 2 })
    expect(r.isNil).toBe(true)
  })
})

describe('revaluationEffect', () => {
  it('is the sign, and only the sign', () => {
    expect(revaluationEffect(1)).toBe('gain')
    expect(revaluationEffect(-1)).toBe('loss')
    expect(revaluationEffect(0)).toBe('none')
  })
})

describe('revaluationNarration', () => {
  it('says the balance, the rate and the date, so the day book explains itself', () => {
    const text = revaluationNarration({
      ledgerName: 'HSBC USD Current',
      code: 'USD',
      fcMinor: 1_000_000,
      decimals: 2,
      rateMicro: 83_500_000,
      asOn: '2026-03-31'
    })
    expect(text).toContain('HSBC USD Current')
    expect(text).toContain('USD 10,000.00')
    expect(text).toContain('83.5000')
    expect(text).toContain('2026-03-31')
  })
})

describe('FX_GAIN_LOSS_LEDGER', () => {
  it('names the account once so no two call sites can spell it differently', () => {
    expect(FX_GAIN_LOSS_LEDGER).toBe('Exchange Gain / Loss (Unrealised)')
  })
})
