// The shared frame behind BarChart and LineChart: categorical x slots (months), a paise y axis
// with nice ticks and light gridlines, hover + keyboard focus on a slot with an exact-value
// tooltip, an aria-live readout, and a visually hidden data table for screen readers.
// Colours are theme tokens read at render through var(--t-*), so light/dark need no JS.
import { useId, useMemo, useState } from 'react'
import { formatPaise, formatPaiseCompact } from '@shared/money'
import { crisp, linearScale, nearestIndex, niceTicks, pointXs, stepIndex, type LinearScale } from '../../lib/charts/scale'
import { useChartWidth } from './useChartWidth'

export type ChartColor = 'blue' | 'amber' | 'dr' | 'cr' | 'ink' | 'muted'
export const chartColor = (c: ChartColor): string => `var(--t-${c})`

export interface ChartSeries {
  id: string
  label: string
  color: ChartColor
  /** Integer paise per slot; null = no data for that slot (drawn as a gap, not a zero). */
  values: (number | null)[]
}

export interface ChartCategory {
  key: string
  /** Axis label, e.g. "Apr". */
  label: string
  /** Tooltip / table label, e.g. "Apr 2026". */
  long: string
}

export interface SlotGeometry {
  width: number
  height: number
  plot: { x0: number; x1: number; y0: number; y1: number }
  y: LinearScale
  xs: number[]
  active: number | null
}

const PAD = { left: 52, right: 8, top: 8, bottom: 22 }

export function SlotChart({
  title,
  summary,
  categories,
  series,
  height,
  testId,
  includeZero = true,
  children
}: {
  /** Accessible name of the chart (also the hidden table's caption). */
  title: string
  /** One-sentence description of what the data says, for aria-label. */
  summary: string
  categories: ChartCategory[]
  series: ChartSeries[]
  height: number
  testId?: string
  includeZero?: boolean
  children: (g: SlotGeometry) => React.ReactNode
}): React.JSX.Element {
  const [ref, width] = useChartWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const liveId = useId()
  const n = categories.length

  const values = series.flatMap((s) => s.values.filter((v): v is number => v != null))
  const { ticks, domain } = useMemo(
    () => niceTicks(values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 0, 4, includeZero),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values.join(','), includeZero]
  )
  const plot = { x0: PAD.left, x1: Math.max(PAD.left + 10, width - PAD.right), y0: PAD.top, y1: height - PAD.bottom }
  const y = linearScale(domain, [plot.y1, plot.y0])
  const xs = pointXs(n, plot.x0, plot.x1)
  const active = hover ?? focus
  const lastWithData = (() => {
    for (let i = n - 1; i >= 0; i--) if (series.some((s) => s.values[i] != null)) return i
    return n - 1
  })()

  const readout = (i: number): string =>
    `${categories[i]?.long ?? ''}: ` +
    series.map((s) => `${s.label} ${s.values[i] == null ? 'no data' : formatPaise(s.values[i]!, { symbol: true })}`).join(', ')

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const next = stepIndex(e.key, focus ?? lastWithData, n)
    if (next == null) return
    e.preventDefault()
    e.stopPropagation()
    setFocus(next)
  }

  // Tooltip position: beside the slot, flipped left in the right half so it never clips.
  const tipLeft = active != null ? xs[active]! : 0
  const flip = active != null && tipLeft > width / 2

  return (
    <div ref={ref} className="relative w-full" data-testid={testId}>
      <div
        role="group"
        aria-label={`${title}. Use left and right arrow keys to read each month.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => setFocus((f) => f ?? lastWithData)}
        onBlur={() => setFocus(null)}
        className="rounded outline-none focus-visible:ring-2 focus-visible:ring-amber/60"
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={summary}
          className="block select-none"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const i = nearestIndex(xs, e.clientX - rect.left)
            setHover(i >= 0 ? i : null)
          }}
          onMouseLeave={() => setHover(null)}
        >
          <title>{title}</title>
          <desc>{summary}</desc>
          {/* Gridlines + y labels. The zero line is drawn stronger: it is the bars' baseline. */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={plot.x0}
                x2={plot.x1}
                y1={crisp(y(t))}
                y2={crisp(y(t))}
                stroke={t === 0 ? 'var(--t-muted)' : 'var(--t-line)'}
                strokeOpacity={t === 0 ? 0.6 : 1}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text x={plot.x0 - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--t-muted)" className="num">
                {formatPaiseCompact(t)}
              </text>
            </g>
          ))}
          {active != null && n > 0 && (
            <rect
              x={xs[active]! - (plot.x1 - plot.x0) / n / 2}
              y={plot.y0}
              width={(plot.x1 - plot.x0) / n}
              height={plot.y1 - plot.y0}
              fill="var(--t-panel2)"
              shapeRendering="crispEdges"
            />
          )}
          {children({ width, height, plot, y, xs, active })}
          {categories.map((c, i) => (
            <text
              key={c.key}
              x={xs[i]}
              y={height - 6}
              textAnchor="middle"
              fontSize={10}
              fill={active === i ? 'var(--t-ink)' : 'var(--t-muted)'}
            >
              {c.label}
            </text>
          ))}
        </svg>
      </div>
      {active != null && categories[active] && (
        <div
          role="presentation"
          data-testid={testId ? `${testId}-tooltip` : undefined}
          className="pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-md border border-line bg-panel px-2.5 py-1.5 text-[11.5px] shadow-md"
          style={flip ? { right: width - tipLeft + 10 } : { left: tipLeft + 10 }}
        >
          <p className="mb-0.5 font-medium text-ink">{categories[active].long}</p>
          {series.map((s) => (
            <p key={s.id} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: chartColor(s.color) }} />
                {s.label}
              </span>
              <span className="num text-ink">{s.values[active] == null ? '—' : formatPaise(s.values[active]!, { symbol: true })}</span>
            </p>
          ))}
        </div>
      )}
      <p id={liveId} aria-live="polite" className="sr-only">
        {focus != null ? readout(focus) : ''}
      </p>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            {series.map((s) => (
              <th key={s.id} scope="col">{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((c, i) => (
            <tr key={c.key}>
              <th scope="row">{c.long}</th>
              {series.map((s) => (
                <td key={s.id}>{s.values[i] == null ? '—' : formatPaise(s.values[i]!, { symbol: true })}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Legend row: colour key + label per series (consistent colours across every chart). */
export function ChartLegend({ series }: { series: Pick<ChartSeries, 'id' | 'label' | 'color'>[] }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted">
      {series.map((s) => (
        <span key={s.id} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: chartColor(s.color) }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}
