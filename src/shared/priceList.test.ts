import { describe, expect, it } from 'vitest'
import { listOn, planRevision, rateOn, revisedRate, roundPrice, versionsOf, type DatedRate } from './priceList'

const RATES: DatedRate[] = [
  { stockItemId: 1, rate: 10_000, effectiveFrom: '2025-04-01' },
  { stockItemId: 2, rate: 20_000, effectiveFrom: '2025-04-01' },
  { stockItemId: 1, rate: 11_000, effectiveFrom: '2025-10-01' },
  { stockItemId: 3, rate: 5_000, effectiveFrom: '2026-01-01' }
]

describe('rateOn', () => {
  it('answers with the rate in force, not the newest one', () => {
    expect(rateOn(RATES, 1, '2025-09-30')).toBe(10_000)
    expect(rateOn(RATES, 1, '2025-10-01')).toBe(11_000)
    expect(rateOn(RATES, 1, '2026-06-01')).toBe(11_000)
  })

  it('is null before the item was ever priced, rather than reaching backwards', () => {
    expect(rateOn(RATES, 3, '2025-12-31')).toBeNull()
    expect(rateOn(RATES, 99, '2026-01-01')).toBeNull()
  })

  it('a rate changed in October leaves September answering what it answered', () => {
    // The credit note raised in November against a September invoice.
    expect(rateOn(RATES, 1, '2025-09-15')).toBe(10_000)
  })
})

describe('listOn', () => {
  it('is the whole list as it stood, one rate per item', () => {
    expect([...listOn(RATES, '2025-09-30')]).toEqual([
      [1, 10_000],
      [2, 20_000]
    ])
  })

  it('picks up the revision and the newly-priced item on their dates', () => {
    const list = listOn(RATES, '2026-01-01')
    expect(list.get(1)).toBe(11_000)
    expect(list.get(2)).toBe(20_000)
    expect(list.get(3)).toBe(5_000)
  })

  it('is empty before the first version', () => {
    expect(listOn(RATES, '2025-03-31').size).toBe(0)
  })
})

describe('versionsOf', () => {
  it('groups the rates into versions, newest first, counting only what changed', () => {
    const v = versionsOf(RATES, '2026-06-01')
    expect(v.map((x) => x.effectiveFrom)).toEqual(['2026-01-01', '2025-10-01', '2025-04-01'])
    expect(v[0]!.itemCount).toBe(1)
    expect(v.at(-1)!.itemCount).toBe(2)
  })

  it('calls a version dated in the future staged rather than in force', () => {
    const v = versionsOf(RATES, '2025-12-31')
    expect(v.find((x) => x.effectiveFrom === '2026-01-01')!.inForce).toBe(false)
    expect(v.find((x) => x.effectiveFrom === '2025-10-01')!.inForce).toBe(true)
  })

  it('answers as on a past date, so a report run for March describes March', () => {
    const v = versionsOf(RATES, '2025-05-01')
    expect(v.filter((x) => x.inForce)).toHaveLength(1)
  })
})

describe('roundPrice', () => {
  it('rounds to the nearest rupee or ten, and leaves paise alone', () => {
    expect(roundPrice(10_549, 'paise')).toBe(10_549)
    expect(roundPrice(10_549, 'rupee')).toBe(10_500)
    expect(roundPrice(10_550, 'rupee')).toBe(10_600)
    expect(roundPrice(10_549, 'ten')).toBe(11_000)
  })

  it('rounds a negative away from zero, so it cannot creep toward it', () => {
    expect(roundPrice(-10_550, 'rupee')).toBe(-10_600)
  })
})

describe('revisedRate', () => {
  it('is the single-division form the plan uses', () => {
    expect(revisedRate(10_000, 500)).toBe(10_500)
    expect(revisedRate(10_333, 500, 'rupee')).toBe(10_800)
    expect(revisedRate(10_333, 500, 'ten')).toBe(11_000)
  })
})

describe('planRevision', () => {
  const base = [
    { stockItemId: 1, rate: 10_000 },
    { stockItemId: 2, rate: 20_000 }
  ]

  it('raises the whole list by a percentage', () => {
    const plan = planRevision({ base, effectiveFrom: '2026-04-01', changeBp: 500 })
    expect(plan.errors).toEqual([])
    expect(plan.rows).toEqual([
      { stockItemId: 1, fromRate: 10_000, rate: 10_500, effectiveFrom: '2026-04-01' },
      { stockItemId: 2, fromRate: 20_000, rate: 21_000, effectiveFrom: '2026-04-01' }
    ])
  })

  it('cuts it too', () => {
    const plan = planRevision({ base, effectiveFrom: '2026-04-01', changeBp: -250 })
    expect(plan.rows[0]!.rate).toBe(9_750)
  })

  it('rounds once, not twice', () => {
    // ₹103.33 +5% is ₹108.4965, which is ₹108 to the rupee. Rounding to paise first gives
    // ₹108.50, and ₹108.50 to the rupee is ₹109 — a rupee out, from one extra rounding.
    const plan = planRevision({
      base: [{ stockItemId: 1, rate: 10_333 }],
      effectiveFrom: '2026-04-01',
      changeBp: 500,
      rounding: 'rupee'
    })
    expect(plan.rows[0]!.rate).toBe(10_800)
  })

  it('leaves out the items the user negotiated separately', () => {
    const plan = planRevision({ base, effectiveFrom: '2026-04-01', changeBp: 500, skip: [2] })
    expect(plan.rows.map((r) => r.stockItemId)).toEqual([1])
  })

  it('records only what moved, so a version reads as a revision', () => {
    const plan = planRevision({
      base: [
        // ₹10,000 + 0.01% is ₹10,001 — a whole rupee, so this one is a real revision.
        { stockItemId: 1, rate: 1_000_000 },
        // ₹100 + 0.01% is ₹100.01 → still ₹100 to the rupee, so there is nothing to record.
        { stockItemId: 2, rate: 10_000 }
      ],
      effectiveFrom: '2026-04-01',
      changeBp: 1,
      rounding: 'rupee'
    })
    expect(plan.rows.map((r) => r.stockItemId)).toEqual([1])
  })

  it('says so when nothing at all would change, instead of writing an empty version', () => {
    const plan = planRevision({ base, effectiveFrom: '2026-04-01', changeBp: 0 })
    expect(plan.rows).toEqual([])
    expect(plan.errors[0]).toContain('Nothing would change')
  })

  it('refuses a change that would price the list at or below nothing', () => {
    expect(planRevision({ base, effectiveFrom: '2026-04-01', changeBp: -10_000 }).errors[0]).toContain('100%')
  })

  it('refuses to let rounding turn a ten-paise item into a free one', () => {
    const plan = planRevision({
      base: [{ stockItemId: 1, rate: 10 }],
      effectiveFrom: '2026-04-01',
      changeBp: 100,
      rounding: 'rupee'
    })
    expect(plan.rows).toEqual([])
    expect(plan.errors[0]).toContain('price at nothing')
  })

  it('refuses a fractional percentage rather than storing a float', () => {
    expect(planRevision({ base, effectiveFrom: '2026-04-01', changeBp: 5.5 }).errors[0]).toContain('basis points')
  })

  it('says there is nothing to revise when the level has no rates yet', () => {
    expect(planRevision({ base: [], effectiveFrom: '2026-04-01', changeBp: 500 }).errors[0]).toContain('no price list')
  })
})
