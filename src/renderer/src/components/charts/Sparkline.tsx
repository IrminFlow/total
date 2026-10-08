import { formatPaise } from '@shared/money'
import { linearScale, linePath } from '../../lib/charts/scale'
import { chartColor, type ChartColor } from './SlotChart'
import { useChartWidth } from './useChartWidth'

/**
 * A tiny trend line for stat tiles — no axes, the tile's own figure is the exact value. The
 * accessible name states the first and last points exactly; the last point is marked. Values are
 * integer paise; a flat series draws a flat line mid-height.
 */
export function Sparkline({
  values,
  label,
  color = 'ink',
  negativeColor,
  height = 28,
  testId,
  formatValue = (v: number) => formatPaise(v, { symbol: true })
}: {
  values: number[]
  /** What the series is, e.g. "Cash and bank, month-end, last 6 months". */
  label: string
  color?: ChartColor
  negativeColor?: ChartColor
  height?: number
  testId?: string
  /** Non-money series: how the accessible name states a value. Default: rupees from paise. */
  formatValue?: (v: number) => string
}): React.JSX.Element {
  const [ref, width] = useChartWidth<HTMLDivElement>(120)
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 0
  const pad = 3
  const x = linearScale([0, Math.max(1, values.length - 1)], [pad, width - pad])
  const y = linearScale([min, max], [height - pad, pad])
  const pts = values.map((v, i) => ({ x: values.length === 1 ? width / 2 : x(i), y: y(v) }))
  const last = values.at(-1)
  const aria =
    values.length === 0
      ? `${label}: no data`
      : `${label}: from ${formatValue(values[0]!)} to ${formatValue(last!)}`
  const lastColor = negativeColor && last != null && last < 0 ? negativeColor : color
  return (
    <div ref={ref} className="w-full" data-testid={testId}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={aria} className="block">
        <title>{aria}</title>
        {pts.length > 1 && (
          <path d={linePath(pts)} fill="none" stroke={chartColor(color)} strokeOpacity={0.75} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {pts.length > 0 && <circle cx={pts.at(-1)!.x} cy={pts.at(-1)!.y} r={2.5} fill={chartColor(lastColor)} />}
      </svg>
    </div>
  )
}
