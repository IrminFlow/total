import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { RATIO_CATEGORIES, RATIO_DEFS, formatRatio, type RatioDef, type RatioKey, type RatioReport } from '@shared/ratios'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { reportsApi } from '../lib/reportsClient'
import { useSession, useToasts } from '../state/stores'
import { Button, DateInput, Page, PageHeader, Panel, SkeletonRows, TabBar } from '../components/ui'
import { OptionsExport } from '../components/ScreenOptions'
import { LineChart, Sparkline } from '../components/charts'
import { csvReport, printReport } from '../lib/reportExport'

const SOURCES: Record<string, string> = {
  '[S3]': 'Schedule III to the Companies Act, 2013 (Division I), ratio disclosures inserted by MCA notification G.S.R. 207(E), 24 March 2021',
  '[GN]': 'ICAI Guidance Note on Division I – Non Ind AS Schedule III to the Companies Act, 2013',
  '[FM]': 'ICAI study material, Financial Management — Ratio Analysis'
}

/** Ratios × 100 as integers for the shared chart frame (it scales integers). */
const scaled = (v: number | null): number | null => (v === null ? null : Math.round(v * 100))

function trendOf(report: RatioReport, key: RatioKey): (number | null)[] {
  return report.months.map((m) => scaled(m.ratios[key]))
}

/**
 * Analysis → Ratios (WP 6.2): liquidity, profitability, leverage, efficiency and working-capital
 * ratios for the period, each with its formula, a short explanation, its source and a monthly
 * trend. Inputs come from the balance sheet / P&L figures of the same books (computeRatioSet).
 */
export function RatiosScreen(): React.JSX.Element {
  const { from: sessionFrom, to: sessionTo } = useSession()
  const toast = useToasts()
  const [from, setFrom] = useState(sessionFrom)
  const [to, setTo] = useState(sessionTo)
  useEffect(() => {
    setFrom(sessionFrom)
    setTo(sessionTo)
  }, [sessionFrom, sessionTo])
  const { data, isPlaceholderData } = useQuery({ queryKey: ['ratios', from, to], queryFn: () => reportsApi.ratios(from, to), placeholderData: keepPreviousData, enabled: from <= to })
  const [category, setCategory] = useState<(typeof RATIO_CATEGORIES)[number]['id']>('liquidity')
  const [focus, setFocus] = useState<RatioKey>('currentRatio')
  const focusDef = RATIO_DEFS.find((d) => d.key === focus)!
  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`

  const exportRows = useMemo(
    () =>
      data
        ? RATIO_CATEGORIES.flatMap((c) => [
            { cells: [c.label, '', '', ''], bold: true },
            ...RATIO_DEFS.filter((d) => d.category === c.id).map((d) => ({ cells: [d.label, formatRatio(data.period.ratios[d.key], d.unit), d.formula, d.source], indent: 1 }))
          ])
        : [],
    [data]
  )
  const columns = [
    { label: 'Ratio', align: 'l' as const },
    { label: 'Value', align: 'r' as const },
    { label: 'Formula', align: 'l' as const },
    { label: 'Source', align: 'l' as const }
  ]
  const exportPdf = (): void => void printReport({ title: 'Ratio analysis', periodLabel, columns, rows: exportRows, footNote: Object.entries(SOURCES).map(([k, v]) => `${k} ${v}`).join(' · ') }, toast)
  const exportCsv = (): void => void csvReport(columns.map((c) => c.label), exportRows.map((r) => r.cells), 'ratios', toast)

  return (
    <Page width="wide">
      <PageHeader
        title="Ratio analysis"
        period={periodLabel}
        controls={
          <div className="flex items-center gap-2">
            {isPlaceholderData && <span className="text-caption text-muted" aria-live="polite">Updating…</span>}
            <DateInput value={from} context={from} onChange={setFrom} className="w-28" testId="input-ratios-from" ariaLabel="From date" />
            <span className="text-small text-muted" aria-hidden="true">→</span>
            <DateInput value={to} context={to} onChange={setTo} className="w-28" testId="input-ratios-to" ariaLabel="To date" />
          </div>
        }
        secondary={
          <>
            <Button variant="ghost" onClick={exportPdf} disabled={!data}>PDF</Button>
            <Button variant="ghost" onClick={exportCsv} disabled={!data}>CSV</Button>
          </>
        }
        options={{
          content: (
            <OptionsExport>
              <Button size="sm" onClick={exportPdf} data-testid="options-ratios-pdf">Export PDF</Button>
              <Button size="sm" onClick={exportCsv} data-testid="options-ratios-csv">Export CSV</Button>
            </OptionsExport>
          )
        }}
      />
      {!data ? (
        <Panel><SkeletonRows /></Panel>
      ) : (
        <div className={`grid grid-cols-[minmax(0,1fr)_380px] items-start gap-3 transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}>
          <Panel>
            <div className="border-b border-line px-4 pt-3">
              <TabBar screen="ratios" label="Ratio groups" tabs={RATIO_CATEGORIES.map((c) => ({ id: c.id, label: c.label }))} active={category} onSelect={(c) => setCategory(c)} />
            </div>
            <table className="ledger-table w-full" data-testid="rows-ratios">
              <thead>
                <tr>
                  <th className="text-left">Ratio</th>
                  <th className="text-right">Period</th>
                  <th className="text-left">Trend by month</th>
                  <th className="text-left">Formula</th>
                </tr>
              </thead>
              <tbody>
                {RATIO_DEFS.filter((d) => d.category === category).map((d) => (
                  <RatioRow key={d.key} def={d} report={data} active={d.key === focus} onFocus={() => setFocus(d.key)} />
                ))}
              </tbody>
            </table>
          </Panel>
          <div className="flex flex-col gap-3">
            <Panel className="p-4" data-testid="ratio-detail">
              <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">{RATIO_CATEGORIES.find((c) => c.id === focusDef.category)?.label}</p>
              <h2 className="mt-1 font-serif text-subtitle font-semibold">{focusDef.label}</h2>
              <p className="num mt-1 text-heading">{formatRatio(data.period.ratios[focus], focusDef.unit)}</p>
              <p className="mt-2 text-detail"><span className="text-muted">Formula: </span>{focusDef.formula}</p>
              <p className="mt-2 text-body-sm text-muted">{focusDef.explain}</p>
              <p className="mt-2 text-hint text-muted">Source: {focusDef.source.split(' ').map((s) => SOURCES[s]).join('; ')}</p>
              {data.months.length > 1 && (
                <div className="mt-3">
                  <LineChart
                    title={`${focusDef.label} by month`}
                    summary={`${focusDef.label} over ${data.months.length} months`}
                    categories={data.months.map((m) => ({ key: m.key, label: m.label.slice(0, 3), long: m.label }))}
                    series={[{ id: focus, label: focusDef.label, color: 'blue', values: trendOf(data, focus) }]}
                    formatValue={(v) => formatRatio(v / 100, focusDef.unit)}
                    formatTick={(v) => (focusDef.unit === 'days' ? String(Math.round(v / 100)) : (v / 100).toFixed(focusDef.unit === '%' ? 0 : 1))}
                    height={170}
                    testId="ratio-trend"
                  />
                </div>
              )}
            </Panel>
            <Panel className="p-4">
              <p className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Worked from</p>
              <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-small">
                {(
                  [
                    ['Net sales', data.inputs.sales], ['Net purchases', data.inputs.purchases], ['Gross profit', data.inputs.grossProfit], ['Net profit', data.inputs.netProfit],
                    ['Current assets', data.inputs.currentAssets], ['Current liabilities', data.inputs.currentLiabilities], ['Closing stock', data.inputs.closingStock],
                    ['Trade receivables', data.inputs.receivables], ['Trade payables', data.inputs.payables], ['Owners’ funds', data.inputs.equity], ['Borrowings', data.inputs.debt]
                  ] as [string, number][]
                ).map(([label, v]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted">{label}</dt>
                    <dd className="num text-right">{formatPaise(v)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-hint text-muted">Turnover and return figures are for the period, not annualised. Ratios with a zero denominator show “—”.</p>
            </Panel>
          </div>
        </div>
      )}
    </Page>
  )
}

function RatioRow({ def, report, active, onFocus }: { def: RatioDef; report: RatioReport; active: boolean; onFocus: () => void }): React.JSX.Element {
  const values = trendOf(report, def.key).map((v) => v ?? 0)
  return (
    <tr
      className={`kbar-row cursor-pointer ${active ? 'bg-panel2' : ''}`}
      data-active={active || undefined}
      data-ratio={def.key}
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onFocus()
        }
      }}
    >
      <td className="font-medium">{def.label}</td>
      <td className="num text-right">{formatRatio(report.period.ratios[def.key], def.unit)}</td>
      <td>{report.months.length > 1 ? <div className="w-32"><Sparkline values={values} label={`${def.label} by month`} height={24} color="blue" formatValue={(v) => formatRatio(v / 100, def.unit)} /></div> : <span className="text-muted">—</span>}</td>
      <td className="text-small text-muted">{def.formula}</td>
    </tr>
  )
}
