import { describe, expect, it } from 'vitest'
import {
  allocationComplete, bpsOfAmount, formatBps, FULL_BPS, parsePercent, splitByPercent, totalBps
} from './costSplit'

describe('splitByPercent', () => {
  it('splits a clean amount cleanly', () => {
    expect(splitByPercent(1_000_00, [4000, 3500, 2500])).toEqual([400_00, 350_00, 250_00])
  })

  it('always sums to the total, whatever the rounding wants to do', () => {
    // 1,00,000.33 across 40/35/25 — every share has a fractional paisa.
    const parts = splitByPercent(1_00_000_33, [4000, 3500, 2500])
    expect(parts.reduce((s, p) => s + p, 0)).toBe(1_00_000_33)
  })

  it('sums to the total across a hard case in every direction', () => {
    for (const total of [1, 2, 7, 99, 100, 12_345_67, 99_999_99]) {
      for (const bps of [[3333, 3333, 3334], [5000, 5000], [1667, 1667, 1666, 1667, 1667, 1666]]) {
        const parts = splitByPercent(total, bps)
        expect(parts.reduce((s, p) => s + p, 0)).toBe(total)
        expect(parts.every((p) => Number.isInteger(p))).toBe(true)
      }
    }
  })

  it('hands the leftover paise to the shares that came closest to earning them', () => {
    // 100 paise across three equal thirds: 33.33 each, so two shares get the extra paisa. Equal
    // fractions tie, and the tie goes to the earlier row.
    expect(splitByPercent(1_00, [3333, 3333, 3334])).toEqual([33, 33, 34])
    expect(splitByPercent(1_00, [3334, 3333, 3333])).toEqual([34, 33, 33])
  })

  it('is deterministic — reopening the modal cannot reshuffle the paise', () => {
    const once = splitByPercent(7_77_777_77, [1234, 4321, 4445])
    const twice = splitByPercent(7_77_777_77, [1234, 4321, 4445])
    expect(once).toEqual(twice)
  })

  it('splits a credit line the same way it splits a debit one', () => {
    const negative = splitByPercent(-1_00_000_33, [4000, 3500, 2500])
    expect(negative.reduce((s, p) => s + p, 0)).toBe(-1_00_000_33)
    expect(negative).toEqual(splitByPercent(1_00_000_33, [4000, 3500, 2500]).map((p) => -p))
  })

  it('returns what a partial allocation is worth rather than refusing it', () => {
    // Somebody halfway through typing has 40% + 35% and nothing else yet.
    const parts = splitByPercent(1_000_00, [4000, 3500])
    expect(parts).toEqual([400_00, 350_00])
    expect(allocationComplete([4000, 3500])).toBe(false)
  })

  it('handles the empty and zero cases without dividing by anything', () => {
    expect(splitByPercent(1_000_00, [])).toEqual([])
    expect(splitByPercent(0, [4000, 6000])).toEqual([0, 0])
    expect(splitByPercent(1_000_00, [0, FULL_BPS])).toEqual([0, 1_000_00])
  })
})

describe('allocationComplete / totalBps', () => {
  it('is true only at exactly 100%', () => {
    expect(allocationComplete([FULL_BPS])).toBe(true)
    expect(allocationComplete([4000, 3500, 2500])).toBe(true)
    expect(allocationComplete([4000, 3500, 2499])).toBe(false)
    expect(allocationComplete([4000, 3500, 2501])).toBe(false)
    expect(totalBps([4000, 3500, 2500])).toBe(FULL_BPS)
  })
})

describe('bpsOfAmount', () => {
  it('converts an existing amount allocation into percentages', () => {
    expect(bpsOfAmount(400_00, 1_000_00)).toBe(4000)
    expect(bpsOfAmount(1_000_00, 1_000_00)).toBe(FULL_BPS)
  })

  it('does not divide by a zero line', () => {
    expect(bpsOfAmount(100, 0)).toBe(0)
  })
})

describe('parsePercent', () => {
  it('reads what people type', () => {
    expect(parsePercent('40')).toBe(4000)
    expect(parsePercent('40%')).toBe(4000)
    expect(parsePercent(' 33.33 ')).toBe(3333)
    expect(parsePercent('0')).toBe(0)
    expect(parsePercent('100')).toBe(FULL_BPS)
  })

  it('refuses what is not a percentage of a line', () => {
    expect(parsePercent('')).toBeNull()
    expect(parsePercent('abc')).toBeNull()
    expect(parsePercent('-5')).toBeNull()
    expect(parsePercent('101')).toBeNull()
    // Finer than a hundredth of a percent is precision nobody allocates to.
    expect(parsePercent('33.333')).toBeNull()
  })
})

describe('formatBps', () => {
  it('trims the zeroes most splits do not need', () => {
    expect(formatBps(4000)).toBe('40%')
    expect(formatBps(4050)).toBe('40.5%')
    expect(formatBps(3333)).toBe('33.33%')
    expect(formatBps(0)).toBe('0%')
  })
})
