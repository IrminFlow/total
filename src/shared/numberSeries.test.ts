import { describe, expect, it } from 'vitest'
import { describeGap, expandSeriesPattern, gapSize, numberGaps, seriesHasFyToken } from './numberSeries'

describe('numberGaps', () => {
  it('finds nothing in an unbroken series', () => {
    expect(numberGaps([1, 2, 3, 4, 5])).toEqual([])
  })

  it('finds a single missing number', () => {
    expect(numberGaps([1, 2, 4, 5])).toEqual([{ from: 3, to: 3 }])
  })

  it('collapses a run of missing numbers into one gap', () => {
    // "7 to 19 are missing" is a sentence someone can act on; thirteen rows are a wall.
    expect(numberGaps([6, 20])).toEqual([{ from: 7, to: 19 }])
  })

  it('finds several separate gaps', () => {
    expect(numberGaps([1, 3, 4, 8])).toEqual([
      { from: 2, to: 2 },
      { from: 5, to: 7 }
    ])
  })

  it('starts from the series own lowest number, not from 1', () => {
    // A book started mid-year from a previous system legitimately begins at 214; reporting
    // 1–213 as missing on day one would make the check something to ignore.
    expect(numberGaps([214, 215, 216])).toEqual([])
    expect(numberGaps([214, 216])).toEqual([{ from: 215, to: 215 }])
  })

  it('does not care about input order', () => {
    expect(numberGaps([8, 1, 4, 3])).toEqual([
      { from: 2, to: 2 },
      { from: 5, to: 7 }
    ])
  })

  it('tolerates duplicates, which are a different problem', () => {
    // Duplicate numbers are caught by the duplicate-number guard at save time; here they must
    // simply not manufacture a phantom gap.
    expect(numberGaps([1, 1, 2, 2, 3])).toEqual([])
  })

  it('ignores zero and negatives, which are not series numbers', () => {
    expect(numberGaps([0, 1, 2])).toEqual([])
    expect(numberGaps([-5, 1, 2])).toEqual([])
  })

  it('answers empty for a series too short to have a gap', () => {
    expect(numberGaps([])).toEqual([])
    expect(numberGaps([7])).toEqual([])
  })
})

describe('gapSize and describeGap', () => {
  it('counts and words a single missing number', () => {
    const gap = { from: 7, to: 7 }
    expect(gapSize(gap)).toBe(1)
    expect(describeGap(gap)).toBe('7')
  })

  it('counts and words a run', () => {
    const gap = { from: 7, to: 19 }
    expect(gapSize(gap)).toBe(13)
    expect(describeGap(gap)).toBe('7 to 19')
  })
})

describe('financial-year series patterns', () => {
  it('expands the FY tokens from the voucher date', () => {
    expect(expandSeriesPattern('INV/{FY}/', '2024-06-15')).toBe('INV/2024-25/')
    expect(expandSeriesPattern('INV/{YY}-', '2024-06-15')).toBe('INV/24-')
    expect(expandSeriesPattern('{YYYY}/', '2024-06-15')).toBe('2024/')
  })

  it('reads the year from the FINANCIAL year, not the calendar year', () => {
    // 31 March 2025 is still 2024-25; 1 April 2025 is not.
    expect(expandSeriesPattern('{FY}', '2025-03-31')).toBe('2024-25')
    expect(expandSeriesPattern('{FY}', '2025-04-01')).toBe('2025-26')
  })

  it('pads a two-digit start year across the century', () => {
    expect(expandSeriesPattern('{YY}', '2005-05-01')).toBe('05')
  })

  it('leaves a pattern with no token exactly as it is', () => {
    expect(expandSeriesPattern('INV-', '2024-06-15')).toBe('INV-')
    expect(seriesHasFyToken('INV-')).toBe(false)
    expect(seriesHasFyToken('INV/{FY}/')).toBe(true)
  })

  it('expands every occurrence, not just the first', () => {
    expect(expandSeriesPattern('{YY}-{YY}', '2024-06-15')).toBe('24-24')
  })
})
