import { describe, expect, it } from 'vitest'
import {
  checkRateHistory,
  describeRateChange,
  hasRateHistoryErrors,
  normalizeRateHistory,
  rateChangedWithin,
  rateOn,
  splitByRatePeriods,
  validateRateHistory,
  type RateChange,
  type RateHistory
} from './rateHistory'

const change = (effectiveFrom: string, ratePercent: number, cessPercent = 0, note: string | null = null): RateChange => ({
  effectiveFrom,
  ratePercent,
  cessPercent,
  note
})

/** A real item: 28% at rollout, 18% from Nov 2017, 5% from the 22-Sep-2025 rationalisation. */
const history: RateHistory = [
  change('2017-07-01', 28, 0, '1/2017-CTR'),
  change('2017-11-15', 18, 0, '41/2017-CTR'),
  change('2025-09-22', 5, 0, '9/2025-CTR')
]

describe('rateOn', () => {
  it('returns null for an empty history — no rate is not zero-rated', () => {
    expect(rateOn([], '2025-09-22')).toBeNull()
  })

  it('returns null before the first change, because the item had no rate yet', () => {
    // Not 0: "nobody told us" and "the Council notified nil" are different answers, and
    // collapsing the first into the second ships an unpriced item tax-free.
    expect(rateOn(history, '2017-06-30')).toBeNull()
  })

  it('applies a change ON its effective date — the boundary is inclusive', () => {
    // A notification "with effect from 22-09-2025" applies to an invoice dated the 22nd,
    // not from the 23rd.
    expect(rateOn(history, '2025-09-22')?.ratePercent).toBe(5)
    expect(rateOn(history, '2025-09-21')?.ratePercent).toBe(18)
  })

  it('holds a single change in force for every later date', () => {
    const one = [change('2020-01-01', 12)]
    expect(rateOn(one, '2019-12-31')).toBeNull()
    expect(rateOn(one, '2020-01-01')?.ratePercent).toBe(12)
    expect(rateOn(one, '2099-12-31')?.ratePercent).toBe(12)
  })

  it('reads an unsorted history correctly', () => {
    const scrambled = [history[2]!, history[0]!, history[1]!]
    expect(rateOn(scrambled, '2018-04-01')?.ratePercent).toBe(18)
  })
})

describe('normalizeRateHistory', () => {
  it('sorts ascending by effective date', () => {
    const scrambled = [history[2]!, history[0]!, history[1]!]
    expect(normalizeRateHistory(scrambled).map((c) => c.effectiveFrom)).toEqual([
      '2017-07-01',
      '2017-11-15',
      '2025-09-22'
    ])
  })

  it('keeps two changes on the same date, with the later entry last so it wins', () => {
    // A same-day duplicate is a correction; the correction is the entry typed second.
    // It is kept rather than dropped so validation can still report it.
    const dup = [change('2025-09-22', 12, 0, 'typo'), change('2025-09-22', 5, 0, 'corrected')]
    const sorted = normalizeRateHistory(dup)
    expect(sorted).toHaveLength(2)
    expect(sorted[1]!.note).toBe('corrected')
    expect(rateOn(dup, '2025-09-22')?.ratePercent).toBe(5)
  })

  it('does not mutate the input', () => {
    const input = [history[2]!, history[0]!]
    normalizeRateHistory(input)
    expect(input[0]!.effectiveFrom).toBe('2025-09-22')
  })
})

describe('validateRateHistory', () => {
  it('rejects an empty history', () => {
    const problems = checkRateHistory([])
    expect(problems).toHaveLength(1)
    expect(problems[0]!.severity).toBe('error')
    expect(validateRateHistory([])[0]).toMatch(/^Error: No rate has been recorded/)
  })

  it('accepts a clean history with nothing to say', () => {
    expect(validateRateHistory(history)).toEqual([])
    expect(hasRateHistoryErrors(history)).toBe(false)
  })

  it('rejects duplicate effective dates', () => {
    const dup = [change('2025-09-22', 5), change('2025-09-22', 18)]
    const problems = checkRateHistory(dup)
    expect(problems.some((p) => p.severity === 'error' && /Two rate changes are dated 22-Sep-25/.test(p.message))).toBe(true)
    expect(hasRateHistoryErrors(dup)).toBe(true)
  })

  it('warns about an out-of-slab rate but does not reject it', () => {
    // 12% stopped being a notified slab on 22-Sep-2025, but the Council has notified odd rates
    // before — an app that refuses to record reality is worse than one that queries it.
    const odd = [change('2025-10-01', 12, 0, 'as per supplier invoice')]
    const problems = checkRateHistory(odd)
    expect(problems).toHaveLength(1)
    expect(problems[0]!.severity).toBe('warning')
    expect(problems[0]!.message).toMatch(/not a notified slab/)
    expect(hasRateHistoryErrors(odd)).toBe(false)
    expect(validateRateHistory(odd)[0]).toMatch(/^Warning: /)
  })

  it('accepts a rate that was a slab on its own effective date, even if it is not one now', () => {
    // 28% was correct in 2017. Judging an old rate by today's slabs would flag every history.
    expect(checkRateHistory([change('2017-07-01', 28)])).toEqual([])
  })

  it('rejects a negative cess', () => {
    const bad = [change('2025-09-22', 5, -1)]
    const problems = checkRateHistory(bad)
    expect(problems.some((p) => p.severity === 'error' && /cess is never negative/.test(p.message))).toBe(true)
    expect(hasRateHistoryErrors(bad)).toBe(true)
  })

  it('rejects a negative rate', () => {
    expect(hasRateHistoryErrors([change('2025-09-22', -5)])).toBe(true)
  })

  it('rejects a malformed effective date', () => {
    expect(hasRateHistoryErrors([change('22-09-2025', 5)])).toBe(true)
  })
})

describe('splitByRatePeriods', () => {
  it('gives exactly one sub-period when no change falls inside the period', () => {
    const parts = splitByRatePeriods(history, '2025-08-01', '2025-08-31')
    expect(parts).toEqual([{ from: '2025-08-01', to: '2025-08-31', rate: history[1] }])
    expect(rateChangedWithin(history, '2025-08-01', '2025-08-31')).toBe(false)
  })

  it('splits a period containing a rate change into two sub-periods at the change date', () => {
    const parts = splitByRatePeriods(history, '2025-09-01', '2025-09-30')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ from: '2025-09-01', to: '2025-09-21', rate: history[1] })
    expect(parts[1]).toEqual({ from: '2025-09-22', to: '2025-09-30', rate: history[2] })
    expect(rateChangedWithin(history, '2025-09-01', '2025-09-30')).toBe(true)
  })

  it('reports no rate for a period entirely before any change', () => {
    expect(splitByRatePeriods(history, '2017-04-01', '2017-06-30')).toEqual([
      { from: '2017-04-01', to: '2017-06-30', rate: null }
    ])
  })

  it('reports the last change for a period entirely after it', () => {
    expect(splitByRatePeriods(history, '2026-04-01', '2026-06-30')).toEqual([
      { from: '2026-04-01', to: '2026-06-30', rate: history[2] }
    ])
  })

  it('treats a change starting exactly on the period start as one sub-period', () => {
    // Inclusive boundary again: the new rate covers the whole period, so there is nothing to cut.
    expect(splitByRatePeriods(history, '2025-09-22', '2025-09-30')).toEqual([
      { from: '2025-09-22', to: '2025-09-30', rate: history[2] }
    ])
  })

  it('splits a period containing two changes into three sub-periods', () => {
    const parts = splitByRatePeriods(history, '2017-06-01', '2017-12-31')
    expect(parts.map((p) => [p.from, p.to, p.rate?.ratePercent ?? null])).toEqual([
      ['2017-06-01', '2017-06-30', null],
      ['2017-07-01', '2017-11-14', 28],
      ['2017-11-15', '2017-12-31', 18]
    ])
  })

  it('never emits an empty sub-period for same-day duplicates', () => {
    const dup = [change('2025-01-01', 18), change('2025-06-01', 12, 0, 'typo'), change('2025-06-01', 5, 0, 'corrected')]
    const parts = splitByRatePeriods(dup, '2025-05-01', '2025-06-30')
    expect(parts).toHaveLength(2)
    expect(parts[1]!.rate?.ratePercent).toBe(5)
  })

  it('returns nothing when the period is inverted', () => {
    expect(splitByRatePeriods(history, '2025-09-30', '2025-09-01')).toEqual([])
  })

  it('covers the period exactly, with no gap and no overlap', () => {
    const parts = splitByRatePeriods(history, '2017-01-01', '2026-12-31')
    expect(parts[0]!.from).toBe('2017-01-01')
    expect(parts.at(-1)!.to).toBe('2026-12-31')
    for (let i = 1; i < parts.length; i++) {
      const prevEnd = new Date(`${parts[i - 1]!.to}T00:00:00Z`).getTime()
      const thisStart = new Date(`${parts[i]!.from}T00:00:00Z`).getTime()
      expect(thisStart - prevEnd).toBe(86_400_000)
    }
  })
})

describe('describeRateChange', () => {
  it('describes the first rate an item is given', () => {
    expect(describeRateChange(null, change('2017-07-01', 28, 0, '1/2017-CTR'))).toBe(
      'GST set to 28% with effect from 01-Jul-17 (1/2017-CTR).'
    )
  })

  it('describes a reduction, citing the notification', () => {
    expect(describeRateChange(history[1]!, history[2]!)).toBe(
      'GST reduced from 18% to 5% with effect from 22-Sep-25 (9/2025-CTR).'
    )
  })

  it('describes a rise', () => {
    expect(describeRateChange(change('2020-01-01', 5), change('2021-01-01', 12))).toBe(
      'GST raised from 5% to 12% with effect from 01-Jan-21.'
    )
  })

  it('mentions cess when it moves', () => {
    expect(describeRateChange(change('2020-01-01', 28, 0), change('2021-01-01', 28, 12, '5/2020-CTR'))).toBe(
      'cess 0% → 12% with effect from 01-Jan-21 (5/2020-CTR).'
    )
  })

  it('says so when a change re-states the same rate', () => {
    expect(describeRateChange(change('2020-01-01', 18), change('2021-01-01', 18))).toBe(
      'Rate re-stated at 18% with effect from 01-Jan-21.'
    )
  })
})
