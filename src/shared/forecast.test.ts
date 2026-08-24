import { describe, expect, it } from 'vitest'
import { buildForecast, type ForecastItem } from './forecast'

const bill = (date: string, amount: number, label = 'bill'): ForecastItem => ({
  date,
  amount,
  source: amount > 0 ? 'receivable' : 'payable',
  certainty: 'contracted',
  label
})

const expected = (date: string, amount: number): ForecastItem => ({
  date,
  amount,
  source: 'recurring',
  certainty: 'expected',
  label: 'rent'
})

describe('buildForecast', () => {
  it('buckets by week and runs the balance forward', () => {
    const f = buildForecast({
      from: '2026-04-01',
      to: '2026-04-28',
      openingCash: 100_00,
      items: [bill('2026-04-03', 50_00), bill('2026-04-10', -30_00)]
    })
    expect(f.buckets).toHaveLength(4)
    expect(f.buckets[0]!.from).toBe('2026-04-01')
    expect(f.buckets[0]!.to).toBe('2026-04-07')
    expect(f.buckets[0]!.closing).toBe(150_00)
    expect(f.buckets[1]!.closing).toBe(120_00)
    expect(f.closingCash).toBe(120_00)
    expect(f.totalIn).toBe(50_00)
    expect(f.totalOut).toBe(-30_00)
  })

  it('puts an overdue bill in the first bucket — it is due now, not on its printed date', () => {
    const f = buildForecast({
      from: '2026-04-01',
      to: '2026-04-14',
      openingCash: 0,
      items: [bill('2026-01-09', -500_00, 'ancient')]
    })
    expect(f.buckets[0]!.items.map((i) => i.label)).toEqual(['ancient'])
    expect(f.buckets[0]!.outflow).toBe(-500_00)
  })

  it('drops items after the window rather than quietly counting them', () => {
    const f = buildForecast({
      from: '2026-04-01',
      to: '2026-04-07',
      openingCash: 0,
      items: [bill('2026-06-01', 900_00)]
    })
    expect(f.closingCash).toBe(0)
    expect(f.buckets[0]!.items).toHaveLength(0)
  })

  it('reports the first date the balance goes negative', () => {
    const f = buildForecast({
      from: '2026-04-01',
      to: '2026-04-21',
      openingCash: 10_00,
      items: [bill('2026-04-09', -25_00)]
    })
    expect(f.shortfallDate).toBe('2026-04-14')
    expect(f.lowestBalance).toBe(-15_00)
  })

  it('keeps a contracted-only line beside the one that includes expectations', () => {
    const f = buildForecast({
      from: '2026-04-01',
      to: '2026-04-07',
      openingCash: 0,
      items: [bill('2026-04-02', 100_00), expected('2026-04-03', -40_00)]
    })
    expect(f.buckets[0]!.closing).toBe(60_00)
    expect(f.buckets[0]!.closingContracted).toBe(100_00)
  })

  it('a single-day window is one bucket, not none', () => {
    const f = buildForecast({ from: '2026-04-01', to: '2026-04-01', openingCash: 5_00, items: [bill('2026-04-01', 1_00)] })
    expect(f.buckets).toHaveLength(1)
    expect(f.buckets[0]!.from).toBe('2026-04-01')
    expect(f.buckets[0]!.to).toBe('2026-04-01')
    expect(f.closingCash).toBe(6_00)
  })

  it('an empty period reports the opening balance rather than nothing', () => {
    const f = buildForecast({ from: '2026-04-01', to: '2026-04-28', openingCash: 42_00, items: [] })
    expect(f.closingCash).toBe(42_00)
    expect(f.lowestBalance).toBe(42_00)
    expect(f.shortfallDate).toBeNull()
    expect(f.buckets.every((b) => b.items.length === 0)).toBe(true)
  })

  it('an inverted window produces no buckets and does not invent a balance', () => {
    const f = buildForecast({ from: '2026-04-10', to: '2026-04-01', openingCash: 7_00, items: [bill('2026-04-05', 1_00)] })
    expect(f.buckets).toEqual([])
    expect(f.closingCash).toBe(7_00)
  })

  it('flags a shortfall that exists before anything is forecast at all', () => {
    const f = buildForecast({ from: '2026-04-01', to: '2026-04-07', openingCash: -1, items: [] })
    expect(f.shortfallDate).toBe('2026-04-01')
  })

  it('the last bucket is clipped to the window end, so the period label cannot overstate', () => {
    const f = buildForecast({ from: '2026-04-01', to: '2026-04-10', openingCash: 0, items: [] })
    expect(f.buckets).toHaveLength(2)
    expect(f.buckets[1]!.to).toBe('2026-04-10')
  })

  it('zero-amount items never appear', () => {
    const f = buildForecast({ from: '2026-04-01', to: '2026-04-07', openingCash: 0, items: [bill('2026-04-02', 0)] })
    expect(f.buckets[0]!.items).toHaveLength(0)
  })
})
