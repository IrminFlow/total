import { barRect, bandLayout } from '../../lib/charts/scale'
import { chartColor, SlotChart, type ChartCategory, type ChartSeries } from './SlotChart'

/** Grouped vertical bars per category (e.g. sales vs purchases by month). Bars always start at a
 *  zero baseline; negative values hang below it. Flat fills, no gradients, no 3D. */
export function BarChart({
  title,
  summary,
  categories,
  series,
  height = 180,
  testId
}: {
  title: string
  summary: string
  categories: ChartCategory[]
  series: ChartSeries[]
  height?: number
  testId?: string
}): React.JSX.Element {
  return (
    <SlotChart title={title} summary={summary} categories={categories} series={series} height={height} testId={testId}>
      {({ plot, y, active }) => {
        const outer = bandLayout(categories.length, plot.x0, plot.x1, 0.28)
        const inner = series.length > 0 ? outer.band / series.length : 0
        return categories.map((c, i) =>
          series.map((s, k) => {
            const v = s.values[i]
            if (v == null || v === 0) return null
            const { y: top, height: h } = barRect(v, y)
            const x = outer.x(i) + k * inner
            return (
              <rect
                key={`${c.key}-${s.id}`}
                data-series={s.id}
                x={Math.round(x) + 0.5}
                y={Math.round(top)}
                width={Math.max(1, Math.round(inner) - 1)}
                height={Math.max(1, Math.round(h))}
                rx={1.5}
                fill={chartColor(s.color)}
                opacity={active == null || active === i ? 1 : 0.55}
                className="motion-safe:transition-opacity"
              />
            )
          })
        )
      }}
    </SlotChart>
  )
}
