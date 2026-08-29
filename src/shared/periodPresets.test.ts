import { describe, it, expect } from 'vitest'
import { matchingPreset, periodPresets } from './periodPresets'

const on = (today: string): Record<string, { from: string; to: string }> =>
  Object.fromEntries(periodPresets(today).map((p) => [p.id, { from: p.from, to: p.to }]))

describe('periodPresets', () => {
  it('this month runs from the first to the last day of the calendar month', () => {
    expect(on('2026-08-25')['this-month']).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    // February, and a leap one, because a month length taken from a constant is where this breaks.
    expect(on('2028-02-11')['this-month']).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  it('last month steps back across a year boundary', () => {
    expect(on('2026-01-04')['last-month']).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(on('2026-03-31')['last-month']).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('this quarter is the statutory quarter — Q1 is April to June', () => {
    expect(on('2026-05-02')['this-quarter']).toEqual({ from: '2026-04-01', to: '2026-06-30' })
    // January is Q4 of the financial year that began the previous April.
    expect(on('2026-01-20')['this-quarter']).toEqual({ from: '2026-01-01', to: '2026-03-31' })
  })

  it('the financial year runs April to March, and March belongs to the year before', () => {
    expect(on('2026-08-25')['this-fy']).toEqual({ from: '2026-04-01', to: '2027-03-31' })
    expect(on('2026-03-31')['this-fy']).toEqual({ from: '2025-04-01', to: '2026-03-31' })
    expect(on('2026-04-01')['this-fy']).toEqual({ from: '2026-04-01', to: '2027-03-31' })
  })

  it('the previous financial year is the whole one before it', () => {
    expect(on('2026-08-25')['last-fy']).toEqual({ from: '2025-04-01', to: '2026-03-31' })
    expect(on('2026-03-31')['last-fy']).toEqual({ from: '2024-04-01', to: '2025-03-31' })
  })

  it('year to date starts at the financial year and stops today', () => {
    expect(on('2026-08-25')['ytd']).toEqual({ from: '2026-04-01', to: '2026-08-25' })
    expect(on('2026-02-09')['ytd']).toEqual({ from: '2025-04-01', to: '2026-02-09' })
  })

  it('labels the financial years it offers', () => {
    const presets = periodPresets('2026-08-25')
    expect(presets.find((p) => p.id === 'this-fy')!.label).toContain('2026-27')
    expect(presets.find((p) => p.id === 'last-fy')!.label).toContain('2025-26')
  })

  it('gives every preset a unique key that occurs in its own label', () => {
    const presets = periodPresets('2026-08-25')
    const keys = presets.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const p of presets) {
      expect(p.key, p.id).toMatch(/^[A-Z]$/)
      expect(p.label.toUpperCase(), p.id).toContain(p.key)
    }
  })

  it('never produces a range that runs backwards', () => {
    for (const today of ['2026-01-01', '2026-03-31', '2026-04-01', '2026-12-31', '2028-02-29']) {
      for (const p of periodPresets(today)) {
        expect(p.from <= p.to, `${today} ${p.id}`).toBe(true)
      }
    }
  })
})

describe('matchingPreset', () => {
  const presets = periodPresets('2026-08-25')

  it('recognises a range the user picked earlier', () => {
    expect(matchingPreset(presets, '2026-04-01', '2027-03-31')?.id).toBe('this-fy')
  })

  it('says nothing about a hand-typed range', () => {
    expect(matchingPreset(presets, '2026-04-07', '2026-04-09')).toBeUndefined()
  })
})
