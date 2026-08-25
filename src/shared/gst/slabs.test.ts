import { describe, expect, it } from 'vitest'
import { GST_SLAB_HISTORY, isNotifiedSlab, slabAdvice, slabsOn, structureChangedWithin } from './slabs'

describe('slabsOn', () => {
  it('serves the original schedule for a date before the rationalisation', () => {
    expect(slabsOn('2025-09-21').slabs).toContain(12)
    expect(slabsOn('2025-09-21').slabs).toContain(28)
  })

  it('serves the two-slab structure from 22 September 2025', () => {
    const set = slabsOn('2025-09-22')
    expect(set.slabs).toEqual([0, 0.25, 3, 5, 18, 40])
    expect(set.slabs).not.toContain(12)
  })

  it('serves the first entry for a date before GST existed rather than refusing', () => {
    // A user importing old books gets an answer instead of an exception; a pre-GST date has no
    // GST slab to be wrong about anyway.
    expect(slabsOn('2015-01-01')).toBe(GST_SLAB_HISTORY[0])
  })

  it('marks the rationalisation entry as unverified, because it is', () => {
    expect(slabsOn('2026-01-01').unverified).toBe(true)
    expect(slabsOn('2020-01-01').unverified).toBe(false)
  })
})

describe('isNotifiedSlab', () => {
  it('accepts 12% before the rationalisation and not after', () => {
    expect(isNotifiedSlab(12, '2025-09-21')).toBe(true)
    expect(isNotifiedSlab(12, '2025-09-22')).toBe(false)
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
    const advice = slabAdvice(28, '2026-01-01')
    expect(advice.message).toContain('2025-09-22')
    expect(advice.suggestions).toEqual([0.25, 3, 5, 18, 40])
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

  it('says nothing about an ordinary month', () => {
    expect(structureChangedWithin('2026-05-01', '2026-05-31')).toBeNull()
  })
})
