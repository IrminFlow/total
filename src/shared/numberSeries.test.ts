import { describe, expect, it } from 'vitest'
import { describeGap, gapSize, numberGaps } from './numberSeries'

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
