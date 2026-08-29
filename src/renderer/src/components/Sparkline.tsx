import { useState } from 'react'
import { formatPaise } from '@shared/money'

/**
 * A twelve-month trend, drawn as an inline SVG polyline. No chart library — the Gateway's cash
 * panel has drawn its own line this way since v0.3, and this is the same idea shrunk to fit under
 * a tile.
 *
 * The baseline is zero rather than the series minimum. A tile sparkline is read in half a second,
 * and a line that fills the box whether the movement was ten rupees or ten lakh is a line that
 * says nothing — worse, it implies volatility that is not there. Anchoring at zero means the
 * shape is honest even when nobody reads the numbers.
 */
export function Sparkline({
  points,
  label,
  testId
}: {
  points: { month: string; value: number }[]
  label: string
  testId?: string
}): React.JSX.Element | null {
  const w = 100
  const h = 18
  const [hover, setHover] = useState<number | null>(null)

  if (points.length === 0) return null
  const values = points.map((p) => p.value)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1
  const xAt = (i: number): number => (points.length > 1 ? (i / (points.length - 1)) * w : w / 2)
  const yAt = (i: number): number => h - ((points[i]!.value - min) / range) * h

  // A flat series (every month identical, usually all zero) has no shape to draw; a rule at the
  // baseline says "nothing happened" more clearly than a line wandering through rounding noise.
  const flat = max === min
  const readout = hover !== null ? points[hover] : null

  return (
    <div className="relative mt-1.5">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="h-4 w-full text-blue/70"
        data-testid={testId}
        role="img"
        aria-label={`${label}, last twelve months`}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(frac * (points.length - 1)))))
        }}
        onMouseLeave={() => setHover(null)}
      >
        {flat ? (
          <line x1={0} y1={h - 1} x2={w} y2={h - 1} stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ) : (
          <polyline
            points={points.map((_, i) => `${xAt(i).toFixed(2)},${yAt(i).toFixed(2)}`).join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {readout && (
        <span className="num pointer-events-none absolute -top-4 right-0 rounded-md bg-panel2 px-1 text-label text-muted">
          {monthLabel(readout.month)} {formatPaise(readout.value, { zeroDash: true })}
        </span>
      )}
    </div>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-04' → 'Apr 26'. */
export function monthLabel(month: string): string {
  const m = Number(month.slice(5, 7))
  return `${MONTHS[m - 1] ?? month} ${month.slice(2, 4)}`
}
