// In-house SVG charts (WP 1.10b) — no chart dependency. Pure geometry lives in
// lib/charts/scale.ts; money is formatted only via @shared/money, dates via @shared/dates.
export { BarChart } from './BarChart'
export { LineChart } from './LineChart'
export { Sparkline } from './Sparkline'
export { ChartLegend, chartColor, type ChartCategory, type ChartColor, type ChartSeries } from './SlotChart'
