import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, ExportGroup, Money, Panel, SectionTitle, useTableNav } from '../components/ui'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { addDays, toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { CashFlowRow } from '@shared/reportMath'
import type { ForecastSource } from '@shared/forecast'
import { TabBar } from '../components/TabBar'
import { useStickyTab } from '../lib/useStickyTab'

function Section({ title, rows, total, leadRow }: {
  title: string
  rows: CashFlowRow[]
  total: number
  leadRow?: { name: string; amount: number }
}): React.JSX.Element {
  return (
    <>
      <tr className="total-row">
        <td colSpan={2}>{title}</td>
      </tr>
      {leadRow && (
        <tr>
          <td className="pl-6">{leadRow.name}</td>
          <td className="r">
            <Money paise={leadRow.amount} />
          </td>
        </tr>
      )}
      {rows.map((r) => (
        <tr key={r.name}>
          <td className="pl-6">{r.name}</td>
          <td className="r">
            <Money paise={r.amount} />
          </td>
        </tr>
      ))}
      <tr className="font-medium">
        <td>Net cash from {title.toLowerCase()}</td>
        <td className="r">
          <Money paise={total} />
        </td>
      </tr>
    </>
  )
}

const TABS = ['statement', 'forecast'] as const

export function CashFlowScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab('cash-flow', TABS, 'statement')
  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <TabBar
            screen="cash-flow"
            tabs={[
              { id: 'statement', label: 'Statement' },
              { id: 'forecast', label: 'Forecast' }
            ]}
            active={tab}
            onSelect={setTab}
          />
        }
      >
        {tab === 'statement' ? 'Cash flow statement' : 'Cash forecast'}
      </SectionTitle>
      {tab === 'statement' ? <StatementTab /> : <ForecastTab />}
    </div>
  )
}

function StatementTab(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const { data } = useQuery({ queryKey: ['cashFlow', from, to], queryFn: () => api.reports.cashFlow(from, to) })

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const hasAnything =
    data && (data.netProfit !== 0 || data.operating.length > 0 || data.investing.length > 0 || data.financing.length > 0 || data.netChange !== 0)

  const exportColumns: PdfColumn[] = [
    { label: 'Particulars', align: 'l' },
    { label: 'Amount', align: 'r' }
  ]
  const money = (p: number): string => formatPaise(p, { zeroDash: false })
  const exportRows: PdfRow[] = data
    ? [
        { cells: ['Operating activities', ''], bold: true },
        { cells: ['Net profit', money(data.netProfit)], indent: 1 },
        ...data.operating.map((r) => ({ cells: [r.name, money(r.amount)], indent: 1 })),
        { cells: ['Net cash from operating activities', money(data.operatingTotal)], bold: true, rule: true },
        { cells: ['Investing activities', ''], bold: true },
        ...data.investing.map((r) => ({ cells: [r.name, money(r.amount)], indent: 1 })),
        { cells: ['Net cash from investing activities', money(data.investingTotal)], bold: true, rule: true },
        { cells: ['Financing activities', ''], bold: true },
        ...data.financing.map((r) => ({ cells: [r.name, money(r.amount)], indent: 1 })),
        { cells: ['Net cash from financing activities', money(data.financingTotal)], bold: true, rule: true },
        { cells: ['Net change in cash', money(data.netChange)], bold: true },
        { cells: ['Opening cash & bank', money(data.openingCash)] },
        { cells: ['Closing cash & bank', money(data.closingCash)], bold: true }
      ]
    : []

  return (
    <>
      <div className="mb-2 flex items-center justify-end gap-2">
            <span className="num text-small text-muted">{periodLabel}</span>
            <ExportGroup
              items={[
                {
                  label: 'PDF',
                  testId: 'cash-flow-pdf',
                  onClick: () => void printReport({ title: 'Cash flow statement', periodLabel, columns: exportColumns, rows: exportRows }, toast)
                },
                {
                  label: 'CSV',
                  testId: 'cash-flow-csv',
                  onClick: () => void csvReport(exportColumns.map((c) => c.label), exportRows.map((r) => r.cells), 'cash-flow', toast)
                }
              ]}
            />
      </div>
      <Panel className="card-fit overflow-y-auto">
        {!data || !hasAnything ? (
          <EmptyState title="No cash movement in this period" hint="Post vouchers, then come back" />
        ) : (
          <table className="ledger-table" data-testid="cash-flow-table">
            <tbody>
              <Section
                title="Operating activities"
                rows={data.operating}
                total={data.operatingTotal}
                leadRow={{ name: 'Net profit', amount: data.netProfit }}
              />
              <Section title="Investing activities" rows={data.investing} total={data.investingTotal} />
              <Section title="Financing activities" rows={data.financing} total={data.financingTotal} />
              <tr className="total-row">
                <td>Net change in cash</td>
                <td className="r">
                  <Money paise={data.netChange} />
                </td>
              </tr>
              <tr>
                <td className="text-muted">Opening cash &amp; bank</td>
                <td className="r">
                  <Money paise={data.openingCash} />
                </td>
              </tr>
              <tr className="font-medium">
                <td>Closing cash &amp; bank</td>
                <td className="r">
                  <Money paise={data.closingCash} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
}

/** How far ahead the forecast looks by default: thirteen weeks, the quarter a bank asks about. */
const FORECAST_DAYS = 90

const SOURCE_LABEL: Record<ForecastSource, string> = {
  receivable: 'Bill in',
  payable: 'Bill out',
  pdc: 'PDC',
  recurring: 'Recurring'
}

/**
 * The forecast.
 *
 * Built only from open bills, post-dated cheques and recurring templates — no trend line, no
 * growth assumption. Every row can be opened, which is the difference between a forecast a bank
 * can be shown and one that has to be defended.
 *
 * Two closing lines per week, not one: "contracted" counts only bills and cheques, "with
 * recurring" adds the templates. A recurring payment against a supplier bill would otherwise be
 * counted twice, and stating both is more honest than picking one and hoping.
 */
function ForecastTab(): React.JSX.Element {
  const toast = useToasts()
  const today = todayISO()
  const to = addDays(today, FORECAST_DAYS)
  const { data, isLoading } = useQuery({
    queryKey: ['cashForecast', today, to],
    queryFn: () => api.reports.cashForecast(today, to)
  })
  const [openWeek, setOpenWeek] = useState<string | null>(null)
  // The weeks fold open to show what is due in them. ↑↓ picks a week, Enter and Space (A17)
  // open it — the same thing the click does.
  const buckets = data?.buckets ?? []
  const toggleWeek = (b: { from: string }): void => setOpenWeek((cur) => (cur === b.from ? null : b.from))
  const weeks = useTableNav(buckets, { rowId: (b) => b.from, onEnter: toggleWeek, onToggle: toggleWeek })

  const columns: PdfColumn[] = [
    { label: 'Week', align: 'l' },
    { label: 'In', align: 'r' },
    { label: 'Out', align: 'r' },
    { label: 'Net', align: 'r' },
    { label: 'Closing (contracted)', align: 'r' },
    { label: 'Closing (with recurring)', align: 'r' }
  ]
  const exportRows: PdfRow[] = (data?.buckets ?? []).map((b) => ({
    cells: [
      `${toDisplayDate(b.from)} – ${toDisplayDate(b.to)}`,
      formatPaise(b.inflow, { zeroDash: true }),
      formatPaise(b.outflow, { zeroDash: true }),
      formatPaise(b.net, { zeroDash: true }),
      formatPaise(b.closingContracted, { zeroDash: true }),
      formatPaise(b.closing, { zeroDash: true })
    ]
  }))
  const periodLabel = `${toDisplayDate(today)} → ${toDisplayDate(to)}`

  if (isLoading || !data) return <Panel className="p-5 text-body-sm text-muted">Working out what is due…</Panel>

  return (
    <>
      <div className="mb-2 flex items-center justify-end gap-2">
        <span className="num text-small text-muted">{periodLabel}</span>
        <ExportGroup
          items={[
            {
              label: 'PDF',
              testId: 'btn-forecast-pdf',
              onClick: () => void printReport({ title: 'Cash forecast', periodLabel, columns, rows: exportRows }, toast)
            },
            {
              label: 'CSV',
              testId: 'btn-forecast-csv',
              onClick: () => void csvReport(columns.map((c) => c.label), exportRows.map((r) => r.cells), 'cash-forecast', toast)
            }
          ]}
        />
      </div>

      <div className="mb-3 grid grid-cols-4 gap-3">
        <Figure label="Cash and bank today" value={data.openingCash} />
        <Figure label="Expected in" value={data.totalIn} />
        <Figure label="Expected out" value={data.totalOut} />
        <Figure label="Lowest point" value={data.lowestBalance} warn={data.lowestBalance < 0} />
      </div>

      {data.shortfallDate && (
        <p className="mb-3 text-body-sm text-cr" data-testid="forecast-shortfall">
          On current commitments the balance goes negative in the week ending {toDisplayDate(data.shortfallDate)}.
        </p>
      )}

      <Panel className="card-fit overflow-y-auto">
        {data.buckets.every((b) => b.items.length === 0) ? (
          <EmptyState
            title="Nothing is due in the next thirteen weeks"
            hint="The forecast is built from open bills, post-dated cheques and recurring templates — there are none."
          />
        ) : (
          <table className="ledger-table" data-testid="rows-forecast">
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col" className="r w-36">In</th>
                <th scope="col" className="r w-36">Out</th>
                <th scope="col" className="r w-36">Net</th>
                <th scope="col" className="r w-40">Closing (contracted)</th>
                <th scope="col" className="r w-40">With recurring</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b, i) => (
                <Fragment key={b.from}>
                  <tr
                    {...weeks.rowProps(i, b)}
                    aria-expanded={openWeek === b.from}
                    data-testid={`forecast-week-${b.from}`}
                  >
                    <td>
                      <span className="mr-1.5 inline-block w-3 text-muted">{openWeek === b.from ? '▾' : '▸'}</span>
                      {toDisplayDate(b.from)} – {toDisplayDate(b.to)}
                      {b.items.length > 0 && (
                        <span className="ml-2 text-hint text-muted">
                          {b.items.length} item{b.items.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </td>
                    {/* Plain signed rupees, not the Dr/Cr the ledgers use: this is a bank
                        balance forecast, and "79,682.50 Cr" is not how anyone reads "you are
                        79,682.50 short". */}
                    <td className="r">
                      <Money paise={b.inflow} />
                    </td>
                    <td className="r">
                      <Money paise={b.outflow} />
                    </td>
                    <td className={`r ${b.net < 0 ? 'text-cr' : ''}`}>
                      <Money paise={b.net} />
                    </td>
                    <td className={`r ${b.closingContracted < 0 ? 'text-cr' : ''}`}>
                      <Money paise={b.closingContracted} />
                    </td>
                    <td className={`r font-medium ${b.closing < 0 ? 'text-cr' : ''}`}>
                      <Money paise={b.closing} />
                    </td>
                  </tr>
                  {openWeek === b.from &&
                    b.items.map((item, i) => (
                      <tr key={`${item.label}-${i}`} className="text-muted">
                        <td className="pl-9">
                          <span className="mr-2 rounded-md bg-panel2 px-1.5 py-0.5 text-label">
                            {SOURCE_LABEL[item.source]}
                          </span>
                          {item.label}
                          {item.certainty === 'expected' && (
                            <span className="ml-2 rounded-md bg-accent/15 px-1.5 py-0.5 text-label text-accent">expected</span>
                          )}
                        </td>
                        <td colSpan={2} className={`r ${item.amount < 0 ? 'text-cr' : 'text-dr'}`}>
                          <Money paise={item.amount} />
                        </td>
                        <td colSpan={3} className="num text-hint">
                          {toDisplayDate(item.date)}
                        </td>
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
}

function Figure({ label, value, warn = false }: { label: string; value: number; warn?: boolean }): React.JSX.Element {
  return (
    <Panel className="px-4 py-3">
      <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">{label}</p>
      <p className={`num mt-1.5 text-title font-medium ${warn ? 'text-cr' : ''}`}>
        <Money paise={value} />
      </p>
    </Panel>
  )
}
