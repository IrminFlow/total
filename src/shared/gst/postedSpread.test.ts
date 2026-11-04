import { describe, expect, it } from 'vitest'
import { spreadPosted } from './postedSpread'

describe('spreadPosted: the posted head over the lines, exact, never negative', () => {
  it('equal already: unchanged', () => {
    expect(spreadPosted([2708, 250], 2958)).toEqual([2708, 250])
  })
  it('a paisa more goes to the line with the largest share', () => {
    expect(spreadPosted([900, 10], 911)).toEqual([901, 10])
  })
  it('a paisa less comes off, never below zero', () => {
    expect(spreadPosted([0, 1], 0)).toEqual([0, 0])
    expect(spreadPosted([1, 1, 1], 1)).toEqual([0, 0, 1])
  })
  it('no computed tax: by the weights (the taxable values)', () => {
    expect(spreadPosted([0, 0], 1, [100, 300])).toEqual([0, 1])
  })
  it('always adds up to the target and stays ≥ 0 (random)', () => {
    let s = 7
    const rnd = (n: number): number => { s = (s * 48271) % 2147483647; return s % n }
    for (let k = 0; k < 500; k++) {
      const computed = Array.from({ length: 1 + rnd(4) }, () => rnd(5000))
      const target = Math.max(0, computed.reduce((a, b) => a + b, 0) + rnd(7) - 3)
      const out = spreadPosted(computed, target)
      expect(out.reduce((a, b) => a + b, 0)).toBe(target)
      expect(out.every((x) => x >= 0)).toBe(true)
    }
  })
})
