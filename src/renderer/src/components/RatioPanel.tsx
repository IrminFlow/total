import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { Money, Panel } from './ui'
import { toDisplayDate } from '@shared/dates'
import type { RatioReport } from '@shared/reports'

/**
 * The ratio panel, with its workings.
 *
 * Every ratio here is a division, and every division has a denominator that can be zero — a
 * company with no stock has no inventory turnover, one with no capital has no gearing. Those
 * come back as null from `computeRatios` and are rendered as an em dash with the reason on
 * hover, never as 0 and never as ∞: a ratio that cannot be computed and a ratio that happens to
 * be zero mean opposite things, and a bank reading the printout cannot tell them apart.
 */
export function RatioPanel({ fyFrom, asOn }: { fyFrom: string; asOn: string }): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['ratios', fyFrom, asOn], queryFn: () => api.reports.ratios(fyFrom, asOn) })

  if (!data) return <Panel className="p-4 text-body-sm text-muted">Loading ratios…</Panel>

  const r = data.ratios
  const rows: { label: string; value: number | null; suffix?: string; why: string }[] = [
    { label: 'Current ratio', value: r.currentRatio, why: 'Current assets ÷ current liabilities' },
    { label: 'Quick ratio', value: r.quickRatio, why: 'Current assets less stock ÷ current liabilities' },
    { label: 'Debt / equity', value: r.debtEquity, why: 'Borrowings ÷ capital and reserves, including this year’s profit' },
    { label: 'Inventory turnover', value: r.inventoryTurnover, suffix: '×', why: 'Cost of goods sold ÷ average stock' },
    { label: 'Debtor days', value: r.debtorDays, suffix: 'd', why: 'Receivables ÷ sales × days in the period' },
    { label: 'Creditor days', value: r.creditorDays, suffix: 'd', why: 'Payables ÷ purchases × days in the period' },
    { label: 'Gross margin', value: r.grossMarginPct, suffix: '%', why: 'Gross profit ÷ sales' },
    { label: 'Net margin', value: r.netMarginPct, suffix: '%', why: 'Net profit ÷ sales' }
  ]

  return (
    <Panel className="p-4" data-testid="panel-ratios">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Ratios</p>
        <span className="num text-hint text-muted">
          {toDisplayDate(data.from)} → {toDisplayDate(data.asOn)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
        {rows.map((row) => (
          <div key={row.label} className="border-b border-line/40 py-1.5" title={row.why}>
            <p className="text-hint text-muted">{row.label}</p>
            <p className="num text-body font-medium" data-testid={`ratio-${slug(row.label)}`}>
              {row.value === null ? (
                <span className="text-muted" title="Not computable — the denominator is nil">
                  –
                </span>
              ) : (
                `${row.value}${row.suffix ?? ''}`
              )}
            </p>
          </div>
        ))}
      </div>
      <Workings inputs={data.inputs} />
    </Panel>
  )
}

function Workings({ inputs }: { inputs: RatioReport['inputs'] }): React.JSX.Element {
  const figures: [string, number][] = [
    ['Current assets', inputs.currentAssets],
    ['Current liabilities', inputs.currentLiabilities],
    ['Stock', inputs.stock],
    ['Receivables', inputs.receivables],
    ['Payables', inputs.payables],
    ['Borrowings', inputs.borrowings],
    ['Equity', inputs.equity],
    ['Sales', inputs.sales],
    ['Purchases', inputs.purchases],
    ['Gross profit', inputs.grossProfit],
    ['Net profit', inputs.netProfit]
  ]
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-hint text-muted">Figures behind these</summary>
      <div className="mt-2 grid grid-cols-2 gap-x-6 sm:grid-cols-3">
        {figures.map(([label, value]) => (
          <div key={label} className="flex justify-between border-b border-line/30 py-1 text-hint">
            <span className="text-muted">{label}</span>
            <Money paise={value} />
          </div>
        ))}
      </div>
    </details>
  )
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
