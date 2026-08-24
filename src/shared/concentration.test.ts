import { describe, expect, it } from 'vitest'
import { concentration, HHI_HIGH, SINGLE_PARTY_WARN } from './concentration'

describe('concentration', () => {
  it('says nothing about an empty book', () => {
    expect(concentration([])).toMatchObject({ top1: 0, top3: 0, hhi: 0, partyCount: 0, warning: null })
    expect(concentration([0, 0])).toMatchObject({ partyCount: 0, warning: null })
  })

  it('reports a single party as the whole of it', () => {
    const c = concentration([1000])
    expect(c.top1).toBe(1)
    expect(c.hhi).toBe(1)
    expect(c.level).toBe('concentrated')
    expect(c.partyCount).toBe(1)
  })

  it('reads ten equal parties as diversified', () => {
    const c = concentration(Array.from({ length: 10 }, () => 100))
    expect(c.top1).toBeCloseTo(0.1)
    expect(c.top3).toBeCloseTo(0.3)
    expect(c.hhi).toBeCloseTo(0.1)
    expect(c.level).toBe('diversified')
    expect(c.warning).toBeNull()
  })

  it('names a dominant single party', () => {
    // 60/10/10/10/10: the top-3 rule alone would also fire, but the sentence should be about
    // the one party, which is the actual risk.
    const c = concentration([600, 100, 100, 100, 100])
    expect(c.top1).toBeCloseTo(0.6)
    expect(c.level).toBe('concentrated')
    expect(c.warning).toMatch(/largest party is 60%/)
  })

  it('names the top three when no single party dominates', () => {
    // 20/20/20/10/10/10/10 — nobody over 25%, but the top three are 60%.
    const c = concentration([200, 200, 200, 100, 100, 100, 100])
    expect(c.top1).toBeLessThan(SINGLE_PARTY_WARN)
    expect(c.top3).toBeCloseTo(0.6)
    expect(c.warning).toMatch(/three largest parties are 60%/)
  })

  it('sorts before taking the top, so input order cannot change the answer', () => {
    const a = concentration([100, 600, 100, 100, 100])
    const b = concentration([600, 100, 100, 100, 100])
    expect(a.top1).toBeCloseTo(b.top1)
    expect(a.hhi).toBeCloseTo(b.hhi)
  })

  it('drops negatives rather than netting them off', () => {
    // A customer who returned more than they bought is not a share of turnover, and letting them
    // offset a real customer would understate exactly the exposure this exists to surface.
    const c = concentration([1000, -400, 1000])
    expect(c.partyCount).toBe(2)
    expect(c.top1).toBeCloseTo(0.5)
  })

  it('distinguishes two books with the same top three but different tails', () => {
    // Top-3 is blind to the shape of the tail; HHI is not, which is why both are reported.
    const shortTail = concentration([50, 50, 50, 25, 25])
    const longTail = concentration([50, 50, 50, ...Array.from({ length: 10 }, () => 5)])
    expect(shortTail.top3).toBeCloseTo(0.75)
    expect(longTail.top3).toBeCloseTo(0.75)
    expect(longTail.hhi).toBeLessThan(shortTail.hhi)
  })

  it('puts the HHI boundary where the conventional one is', () => {
    // Four equal parties is an HHI of exactly 0.25, the conventional "highly concentrated" line.
    const c = concentration([25, 25, 25, 25])
    expect(c.hhi).toBeCloseTo(HHI_HIGH)
    expect(c.level).toBe('concentrated')
  })

  it('mentions a book that is only two or three parties, even when they are equal', () => {
    // Three equal parties gives top1 33%, which the single-party rule already catches. Two
    // parties at 50/50 does too. The count sentence is for the case neither rule reaches.
    expect(concentration([100, 100, 100]).warning).toMatch(/largest party is 33%/)
  })

  it('never produces a share above 1 or below 0', () => {
    for (const amounts of [[1], [1, 2, 3], [7, 7, 7, 7, 7, 1]]) {
      const c = concentration(amounts)
      expect(c.top1).toBeGreaterThan(0)
      expect(c.top1).toBeLessThanOrEqual(1)
      expect(c.top3).toBeLessThanOrEqual(1.0000001)
      expect(c.hhi).toBeLessThanOrEqual(1)
    }
  })
})
