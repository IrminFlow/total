import { describe, it, expect } from 'vitest'
import { mulberry32, mixSeed, Rng, forAll, PropertyFailure, seedFromEnv } from './proptest'

describe('mulberry32', () => {
  it('gives the same sequence for the same seed, every time', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    const seqA = Array.from({ length: 50 }, () => a())
    const seqB = Array.from({ length: 50 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('gives a different sequence for a different seed', () => {
    const a = Array.from({ length: 20 }, mulberry32(1))
    const b = Array.from({ length: 20 }, mulberry32(2))
    expect(a).not.toEqual(b)
  })

  it('stays inside [0, 1)', () => {
    const r = mulberry32(0xdecaf)
    for (let i = 0; i < 5000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('spreads across the unit interval rather than clumping', () => {
    const r = mulberry32(7)
    const buckets = new Array(10).fill(0)
    for (let i = 0; i < 10000; i++) buckets[Math.floor(r() * 10)]++
    for (const b of buckets) expect(b).toBeGreaterThan(700)
  })
})

describe('mixSeed', () => {
  it('turns one seed into distinct per-run seeds', () => {
    const seeds = new Set(Array.from({ length: 500 }, (_, i) => mixSeed(99, i)))
    expect(seeds.size).toBe(500)
  })

  it('is a pure function of (seed, index)', () => {
    expect(mixSeed(4, 17)).toBe(mixSeed(4, 17))
    expect(mixSeed(4, 17)).not.toBe(mixSeed(5, 17))
  })
})

describe('Rng', () => {
  it('replays draw-for-draw from the same seed', () => {
    const draws = (): unknown[] => {
      const r = new Rng(2024)
      return [r.int(0, 100), r.bool(), r.pick(['a', 'b', 'c']), r.shuffle([1, 2, 3, 4, 5]), r.partition(1000, 3)]
    }
    expect(draws()).toEqual(draws())
  })

  it('keeps int() inside its inclusive bounds and reaches both ends', () => {
    const r = new Rng(11)
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 7)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(7)
      seen.add(v)
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7])
  })

  it('shuffles into a permutation without touching the caller’s array', () => {
    const r = new Rng(5)
    const input = [1, 2, 3, 4, 5, 6, 7, 8]
    for (let i = 0; i < 200; i++) {
      const out = r.shuffle(input)
      expect(out.slice().sort((a, b) => a - b)).toEqual(input)
    }
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('partitions a paise total into exactly that many positive parts that add back up', () => {
    const r = new Rng(808)
    for (let i = 0; i < 500; i++) {
      const total = r.int(5, 5_000_00)
      const parts = r.int(1, 5)
      const split = r.partition(total, parts)
      expect(split).toHaveLength(parts)
      expect(split.reduce((s, x) => s + x, 0)).toBe(total)
      for (const p of split) expect(p).toBeGreaterThan(0)
    }
  })
})

describe('forAll', () => {
  it('passes silently when the property holds for every case', () => {
    let cases = 0
    forAll(
      1,
      300,
      (r) => r.int(0, 1000),
      (n) => {
        cases++
        return n >= 0
      }
    )
    expect(cases).toBe(300)
  })

  it('reports the seed, the run index and the counterexample when a property fails', () => {
    let err: PropertyFailure | null = null
    try {
      forAll(
        42,
        200,
        (r) => r.int(0, 1000),
        (n) => n < 900,
        { name: 'numbers stay under 900' }
      )
    } catch (e) {
      err = e as PropertyFailure
    }
    expect(err).toBeInstanceOf(PropertyFailure)
    expect(err!.seed).toBe(42)
    expect(err!.counterexample as number).toBeGreaterThanOrEqual(900)
    expect(err!.message).toContain('numbers stay under 900')
    expect(err!.message).toContain('seed 42')
    expect(err!.message).toContain('run ')
  })

  it('finds the same counterexample again from the reported seed', () => {
    const run = (): PropertyFailure => {
      try {
        forAll(
          777,
          400,
          (r) => r.int(0, 10_000),
          (n) => n % 97 !== 0
        )
      } catch (e) {
        return e as PropertyFailure
      }
      throw new Error('expected a failure')
    }
    const first = run()
    const second = run()
    expect(second.run).toBe(first.run)
    expect(second.caseSeed).toBe(first.caseSeed)
    expect(second.counterexample).toEqual(first.counterexample)
  })

  it('treats a thrown assertion as a failure and keeps its message', () => {
    expect(() =>
      forAll(
        3,
        50,
        () => 1,
        () => {
          throw new Error('books do not balance')
        }
      )
    ).toThrow(/books do not balance/)
  })

  it('shrinks a counterexample down to the smallest still-failing case', () => {
    let err: PropertyFailure | null = null
    try {
      forAll(
        9,
        200,
        (r) => r.int(500, 1000),
        (n) => n < 600,
        { shrink: (n) => (n > 0 ? [n - 1] : []) }
      )
    } catch (e) {
      err = e as PropertyFailure
    }
    // Anything at or above 600 fails, so the minimum failing case is exactly 600.
    expect(err!.counterexample).toBe(600)
    expect(err!.message).toContain('shrunk in')
  })

  it('stops shrinking when the budget runs out rather than looping forever', () => {
    let err: PropertyFailure | null = null
    try {
      forAll(
        9,
        5,
        () => 1_000_000,
        () => false,
        { shrink: (n) => [n - 1], shrinkSteps: 10 }
      )
    } catch (e) {
      err = e as PropertyFailure
    }
    expect(err!.counterexample).toBe(1_000_000 - 10)
  })
})

describe('seedFromEnv', () => {
  const KEY = 'TOTAL_PROPTEST_SEED_SPEC'

  it('uses the fixed fallback when the variable is unset, so CI is deterministic', () => {
    delete process.env[KEY]
    expect(seedFromEnv(KEY, 20250824)).toBe(20250824)
  })

  it('takes an override so a soak run can explore a different space', () => {
    process.env[KEY] = '4242'
    expect(seedFromEnv(KEY, 1)).toBe(4242)
    process.env[KEY] = 'not a number'
    expect(seedFromEnv(KEY, 1)).toBe(1)
    delete process.env[KEY]
  })
})
