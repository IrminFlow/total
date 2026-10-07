import { linePath } from '../../lib/charts/scale'
import { chartColor, SlotChart, type ChartCategory, type ChartColor, type ChartSeries } from './SlotChart'

/** Line(s) over categorical slots with a point per value. `negativeColor` recolours points below
 *  zero (profit: dr-green above, cr-red below); the zero line comes from the shared frame. */
export function LineChart({
  title,
  summary,
  categories,
  series,
  height = 160,
  negativeColor,
  testId
}: {
  title: string
  summary: string
  categories: ChartCategory[]
  series: ChartSeries[]
  height?: number
  negativeColor?: ChartColor
  testId?: string
}): React.JSX.Element {
  return (
    <SlotChart title={title} summary={summary} categories={categories} series={series} height={height} testId={testId}>
      {({ y, xs, active }) =>
        series.map((s) => {
          const pts = s.values.map((v, i) => (v == null ? null : { x: xs[i]!, y: y(v) }))
          return (
            <g key={s.id} data-series={s.id}>
              <path d={linePath(pts)} fill="none" stroke={chartColor(s.color)} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) =>
                v == null ? null : (
                  <circle
                    key={i}
                    cx={xs[i]}
                    cy={y(v)}
                    r={active === i ? 4 : 2.5}
                    fill={chartColor(negativeColor && v < 0 ? negativeColor : s.color)}
                    stroke="var(--t-panel)"
                    strokeWidth={1}
                  />
                )
              )}
            </g>
          )
        })
      }
    </SlotChart>
  )
}
