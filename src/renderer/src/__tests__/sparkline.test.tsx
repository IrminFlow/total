import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline, monthLabel } from '../components/Sparkline'

describe('monthLabel', () => {
  it('reads as a short month and year', () => {
    expect(monthLabel('2026-04')).toBe('Apr 26')
    expect(monthLabel('2025-12')).toBe('Dec 25')
  })
})

describe('Sparkline', () => {
  const series = (values: number[]): { month: string; value: number }[] =>
    values.map((value, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, value }))

  it('renders nothing at all when there is no series', () => {
    const { container } = render(<Sparkline points={[]} label="Cash" />)
    expect(container.firstChild).toBeNull()
  })

  it('draws a flat rule rather than a wandering line when nothing moved', () => {
    const { container } = render(<Sparkline points={series([0, 0, 0])} label="Cash" testId="s" />)
    expect(container.querySelector('polyline')).toBeNull()
    expect(container.querySelector('line')).not.toBeNull()
  })

  it('anchors the baseline at zero so a small movement cannot look dramatic', () => {
    const { container } = render(<Sparkline points={series([100, 101, 102])} label="Cash" testId="s" />)
    const pts = container.querySelector('polyline')!.getAttribute('points')!
    const ys = pts.split(' ').map((p) => Number(p.split(',')[1]))
    // Zero is the floor of the range, so three near-identical values sit near the top of the box
    // and barely differ — which is the honest picture.
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1)
  })

  it('is labelled for a screen reader', () => {
    const { getByRole } = render(<Sparkline points={series([1, 2])} label="Receivables" />)
    expect(getByRole('img').getAttribute('aria-label')).toBe('Receivables, last twelve months')
  })
})
