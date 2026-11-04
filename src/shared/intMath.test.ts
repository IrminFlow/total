import { describe, expect, it } from 'vitest'
import { instalmentDate, mulDivRound } from './intMath'

describe('intMath', () => {
  it('instalmentDate keeps the day of month, clamped to short months', () => {
    expect(instalmentDate('2026-01-31', 1)).toBe('2026-02-28')
    expect(instalmentDate('2026-01-31', 2)).toBe('2026-03-31')
    expect(instalmentDate('2026-11-15', 3)).toBe('2027-02-15')
  })

  it('mulDivRound rounds half up exactly, symmetric for negatives', () => {
    expect(mulDivRound(5, 1, 2)).toBe(3)
    expect(mulDivRound(-5, 1, 2)).toBe(-3)
    expect(mulDivRound(9_000_000_000_000, 60_000, 1_200_000)).toBe(450_000_000_000)
  })
})
