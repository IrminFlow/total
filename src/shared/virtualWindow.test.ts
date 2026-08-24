import { describe, expect, it } from 'vitest'
import { rowWindow } from './virtualWindow'

describe('rowWindow', () => {
  it('renders nothing for an empty list', () => {
    expect(rowWindow({ count: 0, rowHeight: 28, scrollTop: 0, viewportHeight: 600 })).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0
    })
  })

  it('renders the whole of a list shorter than the viewport, with no spacers', () => {
    const w = rowWindow({ count: 5, rowHeight: 28, scrollTop: 0, viewportHeight: 600 })
    expect(w.start).toBe(0)
    expect(w.end).toBe(5)
    expect(w.padTop).toBe(0)
    expect(w.padBottom).toBe(0)
  })

  it('spacer heights always account for every unrendered row', () => {
    const w = rowWindow({ count: 30_000, rowHeight: 28, scrollTop: 28 * 5000, viewportHeight: 600 })
    expect(w.padTop).toBe(w.start * 28)
    expect(w.padBottom).toBe((30_000 - w.end) * 28)
    expect(w.padTop + (w.end - w.start) * 28 + w.padBottom).toBe(30_000 * 28)
  })

  it('renders far fewer rows than the list holds', () => {
    const w = rowWindow({ count: 30_000, rowHeight: 28, scrollTop: 0, viewportHeight: 600 })
    expect(w.end - w.start).toBeLessThan(60)
  })

  it('clamps a scroll position past the end — a filter can shrink the list under the scrollbar', () => {
    const w = rowWindow({ count: 10, rowHeight: 28, scrollTop: 99_999, viewportHeight: 600 })
    expect(w.start).toBeLessThanOrEqual(9)
    expect(w.end).toBe(10)
    expect(w.padBottom).toBe(0)
  })

  it('renders a first screenful when the container has not been measured yet', () => {
    const w = rowWindow({ count: 1000, rowHeight: 28, scrollTop: 0, viewportHeight: 0 })
    expect(w.end).toBeGreaterThan(20)
  })

  it('treats a zero row height as unmeasurable rather than dividing by it', () => {
    expect(rowWindow({ count: 100, rowHeight: 0, scrollTop: 0, viewportHeight: 600 })).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0
    })
  })

  it('overscans above the fold so a fast scroll shows no blank band', () => {
    const w = rowWindow({ count: 1000, rowHeight: 20, scrollTop: 20 * 100, viewportHeight: 400, overscan: 10 })
    expect(w.start).toBe(90)
  })

  it('never returns a negative start at the top of the list', () => {
    const w = rowWindow({ count: 1000, rowHeight: 20, scrollTop: 0, viewportHeight: 400, overscan: 50 })
    expect(w.start).toBe(0)
  })
})
