// Pure geometry for the in-house SVG charts (components/charts) — scales, "nice" ticks, band
// layout, paths and hit-testing. No React, no DOM: unit-tested in scale.test.ts. Values are
// integer paise; only pixel coordinates are fractional.

export interface LinearScale {
  (v: number): number
  domain: [number, number]
  range: [number, number]
}

/** Maps [d0, d1] onto [r0, r1]. A zero-width domain maps everything to the middle of the range. */
export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0
  const f = ((v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))) as LinearScale
  f.domain = domain
  f.range = range
  return f
}

/** A 1/2/5 × 10ⁿ step (integer, ≥ 1) giving roughly `count` intervals over `span`. */
export function niceStep(span: number, count: number): number {
  if (span <= 0 || count <= 0) return 1
  const raw = span / count
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const m = raw / pow
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  return Math.max(1, Math.round(nice * pow))
}

/**
 * Nice y-axis ticks covering [min, max]. `includeZero` (bars: always) widens the domain to 0 so
 * the baseline is real. Returns integer tick values (paise) ascending, and the padded domain.
 */
export function niceTicks(
  min: number,
  max: number,
  count = 4,
  includeZero = true
): { ticks: number[]; domain: [number, number] } {
  let lo = includeZero ? Math.min(0, min) : min
  let hi = includeZero ? Math.max(0, max) : max
  if (lo === hi) {
    // A flat (or empty) series still needs an axis: one step above (or around) the value.
    if (lo === 0) hi = 100_00
    else if (lo > 0) lo = includeZero ? 0 : lo - Math.abs(lo) / 2
    else hi = includeZero ? 0 : hi + Math.abs(hi) / 2
  }
  const step = niceStep(hi - lo, count)
  const start = Math.floor(lo / step) * step
  const end = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let t = start; t <= end; t += step) ticks.push(t)
  return { ticks, domain: [start, end] }
}

/** Evenly spaced bands for `n` categories across [x0, x1]; `padding` is the gap fraction. */
export function bandLayout(n: number, x0: number, x1: number, padding = 0.3): { band: number; step: number; x: (i: number) => number; center: (i: number) => number } {
  const step = n > 0 ? (x1 - x0) / n : 0
  const band = step * (1 - padding)
  return {
    band,
    step,
    x: (i) => x0 + i * step + (step - band) / 2,
    center: (i) => x0 + i * step + step / 2
  }
}

/** Point positions for a line over `n` slots: centred in each band (aligns with bar charts). */
export function pointXs(n: number, x0: number, x1: number): number[] {
  const { center } = bandLayout(n, x0, x1, 0)
  return Array.from({ length: n }, (_, i) => center(i))
}

/** SVG path through the defined points; a null value breaks the line (a gap, not a zero). */
export function linePath(points: ({ x: number; y: number } | null)[]): string {
  let d = ''
  let pen = false
  for (const p of points) {
    if (!p) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${round2(p.x)},${round2(p.y)}`
    pen = true
  }
  return d
}

/** Index of the slot whose x is nearest `x` (hover hit-testing); -1 for no slots. */
export function nearestIndex(xs: number[], x: number): number {
  let best = -1
  let bestD = Infinity
  xs.forEach((px, i) => {
    const d = Math.abs(px - x)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/** Snap a coordinate to the half-pixel so 1px strokes render crisp at 1x (and 2x). */
export function crisp(v: number): number {
  return Math.round(v) + 0.5
}

/** Keyboard step for a focused point: ←/→ move, Home/End jump; clamps; null for other keys. */
export function stepIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  if (key === 'ArrowRight') return Math.min(count - 1, current + 1)
  if (key === 'ArrowLeft') return Math.max(0, current - 1)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** Bar rectangle from the zero baseline: negative values hang below it. */
export function barRect(value: number, y: LinearScale): { y: number; height: number } {
  const y0 = y(0)
  const yv = y(value)
  return { y: Math.min(y0, yv), height: Math.abs(yv - y0) }
}

const round2 = (v: number): number => Math.round(v * 100) / 100
