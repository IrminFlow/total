import { describe, expect, it } from 'vitest'
import {
  estimateEwayDistanceKm,
  haversineKm,
  MIN_ESTIMATED_KM,
  PIN_DISTANCE_DISCLAIMER,
  pinCoordinates,
  ROAD_CIRCUITY_FACTOR
} from './pinDistance'

/**
 * Every distance in this module is an approximation, so every assertion about one is a range.
 * Asserting an exact kilometre figure would only test that the approximation has not been
 * edited — it would pass whether or not the number is any good, and it would fail every time
 * someone improved a coordinate. The ranges below are wide enough to survive a better table and
 * narrow enough to catch a wrong one (a swapped lat/lon, a missing circuity factor, kilometres
 * that are really metres).
 */

describe('pinCoordinates', () => {
  it('refuses a PIN that is not six digits', () => {
    expect(pinCoordinates('')).toBeNull()
    expect(pinCoordinates('4000')).toBeNull() // too short
    expect(pinCoordinates('4000012')).toBeNull() // too long
    expect(pinCoordinates('40000A')).toBeNull() // letters
    expect(pinCoordinates('400 001')).toBeNull() // internal space
  })

  it('refuses a PIN in a range India Post never allotted', () => {
    expect(pinCoordinates('000001')).toBeNull() // 00 — below the allotted range
    expect(pinCoordinates('100001')).toBeNull() // 10 — Delhi starts at 11
    expect(pinCoordinates('290001')).toBeNull() // 29 — gap between UP and Rajasthan
    expect(pinCoordinates('545001')).toBeNull() // 54 — gap between Andhra and Karnataka
    expect(pinCoordinates('660001')).toBeNull() // 66 — gap between Tamil Nadu and Kerala
    expect(pinCoordinates('999999')).toBeNull() // 99 — Army Postal Service, no fixed place
  })

  it('resolves a known metro to district precision', () => {
    const mumbai = pinCoordinates('400001')
    expect(mumbai?.precision).toBe('district')
    expect(mumbai!.lat).toBeCloseTo(19.08, 1)
    expect(mumbai!.lon).toBeCloseTo(72.88, 1)
  })

  it('degrades to circle precision when the three-digit district is not in the table', () => {
    // 304 (Kishangarh/Nasirabad side of Rajasthan) is not a district we claim to know; 30 is an
    // allotted circle, so we answer with the circle rather than inventing a district coordinate.
    const some = pinCoordinates('304001')
    expect(some?.precision).toBe('circle')
    // ...and it must be the circle's coordinate, not any district's.
    expect(some).toEqual({ ...pinCoordinates('307001')!, precision: 'circle' })
  })
})

describe('haversineKm', () => {
  it('is zero for a point against itself', () => {
    expect(haversineKm({ lat: 19.076, lon: 72.8777 }, { lat: 19.076, lon: 72.8777 })).toBe(0)
  })

  it('gives roughly one degree of latitude as 111 km', () => {
    expect(haversineKm({ lat: 0, lon: 77 }, { lat: 1, lon: 77 })).toBeGreaterThan(110)
    expect(haversineKm({ lat: 0, lon: 77 }, { lat: 1, lon: 77 })).toBeLessThan(112)
  })
})

describe('estimateEwayDistanceKm', () => {
  it('returns null when either PIN cannot be resolved honestly', () => {
    expect(estimateEwayDistanceKm('abc', '110001')).toBeNull()
    expect(estimateEwayDistanceKm('400001', '')).toBeNull()
    expect(estimateEwayDistanceKm('400001', '545001')).toBeNull() // unallotted destination
  })

  it('returns the documented minimum, never zero, for the same PIN twice', () => {
    // An e-way bill with 0 km is rejected by the portal, and a move inside one sorting district
    // resolves to a single coordinate here, so the floor is load-bearing rather than cosmetic.
    const est = estimateEwayDistanceKm('400001', '400001')
    expect(est?.km).toBe(MIN_ESTIMATED_KM)
    expect(est?.km).toBeGreaterThan(0)
    expect(est?.approximate).toBe(true)
    expect(est?.basis).toContain('minimum')
  })

  it('returns the documented minimum for two PINs in the same sorting district', () => {
    const est = estimateEwayDistanceKm('400001', '400099')
    expect(est?.km).toBe(MIN_ESTIMATED_KM)
  })

  it('estimates a short hop within one postal circle', () => {
    // Chennai 600 to Puducherry 605, both in circle 60. Straight line ~135 km, road ~160.
    const est = estimateEwayDistanceKm('600001', '605001')
    expect(est!.km).toBeGreaterThan(100)
    expect(est!.km).toBeLessThan(250)
  })

  it('estimates a long inter-state haul inside a sane band', () => {
    // Mumbai 400001 to Delhi 110001. Great circle ~1150 km; the road is about 1,400 km.
    const est = estimateEwayDistanceKm('400001', '110001')
    expect(est!.km).toBeGreaterThan(1150)
    expect(est!.km).toBeLessThan(1700)
  })

  it('applies the road circuity factor rather than reporting the straight line', () => {
    const from = pinCoordinates('400001')!
    const to = pinCoordinates('110001')!
    const straight = haversineKm(from, to)
    expect(estimateEwayDistanceKm('400001', '110001')!.km).toBe(
      Math.round(straight * ROAD_CIRCUITY_FACTOR)
    )
    expect(estimateEwayDistanceKm('400001', '110001')!.km).toBeGreaterThan(straight)
  })

  it('is symmetric — A to B is B to A', () => {
    const there = estimateEwayDistanceKm('400001', '700001')
    const back = estimateEwayDistanceKm('700001', '400001')
    expect(there!.km).toBe(back!.km)
  })

  it('reports whole kilometres, because the portal field takes no decimals', () => {
    const est = estimateEwayDistanceKm('560001', '110001')
    expect(Number.isInteger(est!.km)).toBe(true)
  })

  it('always labels itself approximate and says which precision it used', () => {
    const district = estimateEwayDistanceKm('400001', '110001')
    expect(district!.approximate).toBe(true)
    expect(district!.basis).toContain('postal district')

    const circle = estimateEwayDistanceKm('304001', '110001')
    expect(circle!.approximate).toBe(true)
    expect(circle!.basis).toContain('postal circle')
  })
})

describe('PIN_DISTANCE_DISCLAIMER', () => {
  it('tells the user in plain words to confirm the number before filing', () => {
    expect(PIN_DISTANCE_DISCLAIMER).toMatch(/estimate/i)
    expect(PIN_DISTANCE_DISCLAIMER).toMatch(/straight-line/i)
    expect(PIN_DISTANCE_DISCLAIMER).toMatch(/postal district/i)
    expect(PIN_DISTANCE_DISCLAIMER).toMatch(/before you file/i)
    expect(PIN_DISTANCE_DISCLAIMER).toMatch(/validity/i)
  })
})
