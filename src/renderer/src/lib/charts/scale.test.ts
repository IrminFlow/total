import { describe, expect, it } from 'vitest'
import { bandLayout, barRect, crisp, linePath, linearScale, nearestIndex, niceStep, niceTicks, pointXs, stepIndex } from './scale'

describe('linearScale', () => {
  it('maps the domain onto the range (inverted y axes too)', () => {
    const y = linearScale([0, 100], [200, 0])
    expect(y(0)).toBe(200)
    expect(y(100)).toBe(0)
    expect(y(50)).toBe(100)
  })
  it('a zero-width domain lands mid-range instead of dividing by zero', () => {
    expect(linearScale([5, 5], [0, 10])(5)).toBe(5)
  })
})

describe('niceStep / niceTicks', () => {
  it('steps are 1/2/5 × 10ⁿ', () => {
    expect(niceStep(100, 4)).toBe(50)
    expect(niceStep(1000, 4)).toBe(500)
    expect(niceStep(7, 4)).toBe(2)
    expect(niceStep(0, 4)).toBe(1)
  })
  it('bars: the domain always includes zero and the ticks cover the data', () => {
    const { ticks, domain } = niceTicks(1_234_500, 9_870_000, 4)
    expect(domain[0]).toBe(0)
    expect(ticks[0]).toBe(0)
    expect(ticks.at(-1)!).toBeGreaterThanOrEqual(9_870_000)
    expect(ticks.every((t) => Number.isInteger(t))).toBe(true)
  })
  it('negative values extend below zero', () => {
    const { ticks } = niceTicks(-300_000, 800_000, 4)
    expect(ticks[0]).toBeLessThanOrEqual(-300_000)
    expect(ticks).toContain(0)
  })
  it('an all-zero series still gets an axis', () => {
    const { ticks, domain } = niceTicks(0, 0)
    expect(domain[1]).toBeGreaterThan(0)
    expect(ticks.length).toBeGreaterThan(1)
  })
  it('without includeZero a flat positive series gets room around it', () => {
    const { domain } = niceTicks(500, 500, 4, false)
    expect(domain[0]).toBeLessThan(500)
    expect(domain[1]).toBeGreaterThanOrEqual(500)
  })
})

describe('bands, points, paths', () => {
  it('bandLayout centres bands with padding', () => {
    const b = bandLayout(4, 0, 400, 0.5)
    expect(b.step).toBe(100)
    expect(b.band).toBe(50)
    expect(b.x(0)).toBe(25)
    expect(b.center(3)).toBe(350)
  })
  it('pointXs align with band centres', () => {
    expect(pointXs(2, 0, 100)).toEqual([25, 75])
  })
  it('linePath breaks at nulls', () => {
    expect(linePath([{ x: 0, y: 1 }, { x: 10, y: 2 }, null, { x: 30, y: 4 }])).toBe('M0,1L10,2M30,4')
    expect(linePath([])).toBe('')
  })
  it('barRect hangs negatives below the baseline', () => {
    const y = linearScale([-100, 100], [200, 0])
    expect(barRect(50, y)).toEqual({ y: 50, height: 50 })
    expect(barRect(-50, y)).toEqual({ y: 100, height: 50 })
  })
  it('nearestIndex, crisp, stepIndex', () => {
    expect(nearestIndex([10, 20, 30], 24)).toBe(1)
    expect(nearestIndex([], 5)).toBe(-1)
    expect(crisp(10.2)).toBe(10.5)
    expect(stepIndex('ArrowRight', 2, 3)).toBe(2)
    expect(stepIndex('ArrowLeft', 0, 3)).toBe(0)
    expect(stepIndex('End', 0, 3)).toBe(2)
    expect(stepIndex('Enter', 0, 3)).toBeNull()
  })
})
