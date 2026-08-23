import { describe, it, expect } from 'vitest'
import { periodKey, periodRange, periodLabel, periodBounds, PERIODS } from './period'

describe('periodKey', () => {
  it('months are the existing YYYY-MM key', () => {
    expect(periodKey('2026-04-01', 'month')).toBe('2026-04')
    expect(periodKey('2026-12-31', 'month')).toBe('2026-12')
  })

  it('quarters follow the Indian FY: Q1 is Apr-Jun', () => {
    expect(periodKey('2026-04-01', 'quarter')).toBe('2026-Q1')
    expect(periodKey('2026-06-30', 'quarter')).toBe('2026-Q1')
    expect(periodKey('2026-07-01', 'quarter')).toBe('2026-Q2')
    expect(periodKey('2026-09-30', 'quarter')).toBe('2026-Q2')
    expect(periodKey('2026-10-01', 'quarter')).toBe('2026-Q3')
    expect(periodKey('2026-12-31', 'quarter')).toBe('2026-Q3')
  })

  it('Jan-Mar is Q4 of the FY that started the previous April', () => {
    expect(periodKey('2027-01-01', 'quarter')).toBe('2026-Q4')
    expect(periodKey('2027-03-31', 'quarter')).toBe('2026-Q4')
  })

  it('the FY boundary flips the bucket', () => {
    expect(periodKey('2027-03-31', 'quarter')).toBe('2026-Q4')
    expect(periodKey('2027-04-01', 'quarter')).toBe('2027-Q1')
  })

  it('halves split the FY at September', () => {
    expect(periodKey('2026-04-01', 'half')).toBe('2026-H1')
    expect(periodKey('2026-09-30', 'half')).toBe('2026-H1')
    expect(periodKey('2026-10-01', 'half')).toBe('2026-H2')
    expect(periodKey('2027-03-31', 'half')).toBe('2026-H2')
  })

  it('years are the FY start year', () => {
    expect(periodKey('2026-04-01', 'year')).toBe('2026-FY')
    expect(periodKey('2027-03-31', 'year')).toBe('2026-FY')
    expect(periodKey('2027-04-01', 'year')).toBe('2027-FY')
  })

  it('keys sort chronologically as plain strings', () => {
    const keys = ['2027-04-01', '2026-04-01', '2027-01-15', '2026-10-02'].map((d) =>
      periodKey(d, 'quarter')
    )
    expect([...keys].sort()).toEqual(['2026-Q1', '2026-Q3', '2026-Q4', '2027-Q1'])
  })
})

describe('periodRange', () => {
  it('enumerates months inclusively', () => {
    expect(periodRange('2026-04-05', '2026-07-20', 'month')).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07'
    ])
  })

  it('enumerates quarters across an FY boundary', () => {
    expect(periodRange('2026-05-01', '2027-05-01', 'quarter')).toEqual([
      '2026-Q1',
      '2026-Q2',
      '2026-Q3',
      '2026-Q4',
      '2027-Q1'
    ])
  })

  it('a single day yields one bucket at every granularity', () => {
    for (const p of PERIODS) {
      expect(periodRange('2026-08-15', '2026-08-15', p)).toHaveLength(1)
    }
  })

  it('returns the from-bucket when to precedes from', () => {
    expect(periodRange('2026-08-01', '2026-01-01', 'month')).toEqual(['2026-08'])
  })

  it('is bounded so a bad range cannot hang the process', () => {
    expect(periodRange('1900-01-01', '2400-01-01', 'month').length).toBeLessThanOrEqual(1200)
  })
})

describe('periodLabel', () => {
  it('labels each granularity readably', () => {
    expect(periodLabel('2026-04', 'month')).toBe('Apr 2026')
    expect(periodLabel('2026-Q1', 'quarter')).toBe('Q1 FY2026-27')
    expect(periodLabel('2026-Q4', 'quarter')).toBe('Q4 FY2026-27')
    expect(periodLabel('2026-H2', 'half')).toBe('H2 FY2026-27')
    expect(periodLabel('2026-FY', 'year')).toBe('FY2026-27')
  })
})

describe('periodBounds', () => {
  it('bounds a month, including short and leap months', () => {
    expect(periodBounds('2026-04', 'month')).toEqual({ from: '2026-04-01', to: '2026-04-30' })
    expect(periodBounds('2027-02', 'month')).toEqual({ from: '2027-02-01', to: '2027-02-28' })
    expect(periodBounds('2028-02', 'month')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  it('bounds FY quarters, with Q4 crossing the calendar year', () => {
    expect(periodBounds('2026-Q1', 'quarter')).toEqual({ from: '2026-04-01', to: '2026-06-30' })
    expect(periodBounds('2026-Q3', 'quarter')).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(periodBounds('2026-Q4', 'quarter')).toEqual({ from: '2027-01-01', to: '2027-03-31' })
  })

  it('bounds halves and the full financial year', () => {
    expect(periodBounds('2026-H1', 'half')).toEqual({ from: '2026-04-01', to: '2026-09-30' })
    expect(periodBounds('2026-H2', 'half')).toEqual({ from: '2026-10-01', to: '2027-03-31' })
    expect(periodBounds('2026-FY', 'year')).toEqual({ from: '2026-04-01', to: '2027-03-31' })
  })

  it('round-trips: every date inside a bucket maps back to that bucket', () => {
    for (const p of PERIODS) {
      for (const d of ['2026-04-01', '2026-08-15', '2026-11-30', '2027-01-01', '2027-03-31']) {
        const key = periodKey(d, p)
        const b = periodBounds(key, p)
        expect(d >= b.from && d <= b.to, `${d} in ${key} (${p})`).toBe(true)
      }
    }
  })
})
