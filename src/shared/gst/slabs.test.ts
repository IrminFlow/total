import { describe, expect, it } from 'vitest'
import { GST_SLAB_HISTORY, isNotifiedSlab, slabAdvice, slabsOn, structureChangedWithin } from './slabs'

describe('slabsOn', () => {
  it('serves the original schedule for a date before the rationalisation', () => {
    expect(slabsOn('2025-09-21').slabs).toContain(12)
    expect(slabsOn('2025-09-21').slabs).toContain(28)
  })

  it('serves the rationalised schedule from 22 September 2025', () => {
    // Notn. 9/2025-Integrated Tax (Rate) dated 17 Sep 2025, in supersession of 1/2017-IT(R),
    // w.e.f. 22 Sep 2025, notifies SEVEN rates: 5 (Sch I), 18 (II), 40 (III), 3 (IV), 0.25 (V),
    // 1.50 (VI) and 28 (VII). "Two principal slabs" is the press description, not the schedule.
    const set = slabsOn('2025-09-22')
    expect(set.slabs).toEqual([0, 0.25, 1.5, 3, 5, 18, 28, 40])
    expect(set.slabs).not.toContain(12)
  })

  it('keeps 28% alive after the rationalisation — Schedule VII survived it', () => {
    // Schedule VII - 28% of Notn. 9/2025-IT(R) carries pan masala and tobacco (2106 90 20, 2401,
    // 2402, 2403, 2404 11 00, 2404 19 00). Reporting 28% as withdrawn on 22 Sep 2025 would tell a
    // cigarette wholesaler its own rate no longer exists.
    expect(isNotifiedSlab(28, '2025-09-22')).toBe(true)
    expect(slabAdvice(28, '2025-09-22').message).toBeNull()
  })

  it('carries the 1.5% diamond slab from 18 July 2022, not from 2017', () => {
    // Notn. 6/2022-Central Tax (Rate) dated 13 Jul 2022 inserted "Schedule VII - 0.75%" into
    // 1/2017-CT(R) (= 1.5% GST) for cut and polished diamonds, w.e.f. 18 Jul 2022.
    expect(isNotifiedSlab(1.5, '2022-07-17')).toBe(false)
    expect(isNotifiedSlab(1.5, '2022-07-18')).toBe(true)
    expect(isNotifiedSlab(1.5, '2026-01-01')).toBe(true)
  })

  it('never claims 6% is a slab — that is the CGST half of 12%', () => {
    // Notn. 8/2021-CT(R) amends "Schedule II - 6%" of 1/2017-CT(R). 6% there is the CENTRAL tax
    // rate; the GST slab is 12%. This table is in full GST percent throughout.
    for (const date of ['2021-10-01', '2025-09-21', '2026-01-01']) {
      expect(isNotifiedSlab(6, date)).toBe(false)
    }
  })

  it('serves the first entry for a date before GST existed rather than refusing', () => {
    // A user importing old books gets an answer instead of an exception; a pre-GST date has no
    // GST slab to be wrong about anyway.
    expect(slabsOn('2015-01-01')).toBe(GST_SLAB_HISTORY[0])
  })

  it('no longer marks any entry unverified — every one now names its notification', () => {
    for (const set of GST_SLAB_HISTORY) {
      expect(set.unverified).toBe(false)
      expect(set.notification).toMatch(/Notn\./)
    }
  })
})

describe('isNotifiedSlab', () => {
  it('accepts 12% before the rationalisation and not after', () => {
    expect(isNotifiedSlab(12, '2025-09-21')).toBe(true)
    expect(isNotifiedSlab(12, '2025-09-22')).toBe(false)
  })

  it('accepts 40% only from the rationalisation', () => {
    expect(isNotifiedSlab(40, '2025-09-21')).toBe(false)
    expect(isNotifiedSlab(40, '2025-09-22')).toBe(true)
  })

  it('keeps the special rates through the change', () => {
    for (const date of ['2020-01-01', '2026-01-01']) {
      expect(isNotifiedSlab(0.25, date)).toBe(true)
      expect(isNotifiedSlab(3, date)).toBe(true)
    }
  })
})

describe('slabAdvice', () => {
  it('says nothing when the rate is in force', () => {
    expect(slabAdvice(18, '2026-01-01').message).toBeNull()
  })

  it('names the date a withdrawn slab was withdrawn on', () => {
    const advice = slabAdvice(12, '2026-01-01')
    expect(advice.message).toContain('2025-09-22')
    expect(advice.suggestions).toEqual([0.25, 1.5, 3, 5, 18, 28, 40])
  })

  it('reports a rate that was never a slab differently from one that was withdrawn', () => {
    expect(slabAdvice(7, '2026-01-01').message).toContain('not a notified slab')
    expect(slabAdvice(7, '2026-01-01').message).not.toContain('withdrawn')
  })
})

describe('structureChangedWithin', () => {
  it('flags the return period that straddles the rationalisation', () => {
    // September 2025's GSTR-1 legitimately shows one HSN at two rates. Without this it looks
    // like a data-entry error.
    expect(structureChangedWithin('2025-09-01', '2025-09-30')?.effectiveFrom).toBe('2025-09-22')
  })

  it('flags July 2022, when the diamond slab appeared', () => {
    expect(structureChangedWithin('2022-07-01', '2022-07-31')?.effectiveFrom).toBe('2022-07-18')
  })

  it('says nothing about an ordinary month', () => {
    expect(structureChangedWithin('2026-05-01', '2026-05-31')).toBeNull()
  })
})
