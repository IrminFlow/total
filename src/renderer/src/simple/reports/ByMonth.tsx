import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toMonthLabel } from '@shared/dates'
import type { MonthBar, SimpleByMonth } from '@shared/simple/reports'
import { byMonthWhy } from '@shared/simple/explain'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useSession } from '../../state/stores'
import { Page, SkeletonTiles } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LoadError, ReportHeader, WhyLink, cardCls, money } from './parts'

const REGISTERS = { name: 'registers', tab: 'sales' } as const // i18n-technical
const NO_MAX = 'none' // i18n-technical: twelve rows, no inner scroll

/** Bar height in whole percent of the tallest bar (display only — the amounts stay paise). */
const pct = (paise: number, max: number): number => (max <= 0 || paise <= 0 ? 0 : Math.max(2, Math.round((paise * 100) / max)))

/**
 * WP 9.9 — Reports → Sales and purchases by month: twelve months of the Sales and Purchase
 * registers' taxable values (simple:reports:byMonth), as bars and as a table, with the "Why?"
 * sentence. The Accountant view is the Registers screen.
 */
export function ByMonth(): React.JSX.Element {
  const t = useT()
  const today = useSession((s) => s.workingDate)
  const q = useQuery({ queryKey: ['simpleReports', 'byMonth', today], queryFn: () => api.simpleReports.byMonth(today) }) // i18n-technical
  return (
    <Page data-testid="simple-report-by-month">
      <ReportHeader testId="by-month" title={t('simple.reports.byMonth')} subtitle={t('simple.reports.byMonth.subtitle')} accountant={{ screen: REGISTERS, hint: t('simple.reports.byMonth.accountant') }} />
      {q.isError && <LoadError testId="by-month" text={t('simple.reports.loadError')} onRetry={() => void q.refetch()} />}
      {!q.data && !q.isError && <SkeletonTiles count={2} />}
      {q.data && <Body b={q.data} />}
    </Page>
  )
}

function Body({ b }: { b: SimpleByMonth }): React.JSX.Element {
  const t = useT()
  const max = b.months.reduce((m, x) => Math.max(m, x.sales, x.purchases), 0)
  const why = byMonthWhy(b, t)
  const columns = useMemo(
    () =>
      defineColumns<MonthBar>([
        { id: 'month', header: t('simple.reports.byMonth.colMonth'), kind: 'text', groupable: false, value: (r) => r.month, text: (r) => toMonthLabel(r.month, 'long') }, // i18n-technical
        { id: 'sales', header: t('simple.reports.byMonth.sales'), kind: 'money', value: (r) => r.sales, aggregate: 'sum', explainable: false }, // i18n-technical
        { id: 'purchases', header: t('simple.reports.byMonth.purchases'), kind: 'money', value: (r) => r.purchases, aggregate: 'sum', explainable: false } // i18n-technical
      ]),
    [t]
  )
  return (
    <>
      <section className={cardCls}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-detail text-ink" data-testid="by-month-sentence">
            {why}
          </p>
          <WhyLink what={t('simple.reports.byMonth')} sentence={`${why} ${t('simple.reports.byMonth.note')}`} link={{ label: t('simple.reports.byMonth.accountant'), screen: REGISTERS }} testId="why-by-month" />
        </div>
        <div className="mt-3 flex items-center gap-4 text-small text-muted" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue" />
            {t('simple.reports.byMonth.sales')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber" />
            {t('simple.reports.byMonth.purchases')}
          </span>
        </div>
        <ul className="mt-2 grid h-48 grid-cols-12 items-end gap-1.5 border-b border-line" data-testid="by-month-bars" aria-label={t('simple.reports.byMonth')}>
          {b.months.map((m) => {
            const label = t('simple.reports.byMonth.bar', { month: toMonthLabel(m.month, 'long'), sales: money(m.sales), purchases: money(m.purchases) })
            return (
              <li key={m.month} className="flex h-full items-end justify-center gap-0.5" title={label} aria-label={label} data-testid={`by-month-bar-${m.month}`} data-sales={m.sales} data-purchases={m.purchases}>
                <span className="w-1/3 rounded-t-sm bg-blue" style={{ height: `${pct(m.sales, max)}%` }} />
                <span className="w-1/3 rounded-t-sm bg-amber" style={{ height: `${pct(m.purchases, max)}%` }} />
              </li>
            )
          })}
        </ul>
        <ul className="mt-1 grid grid-cols-12 gap-1.5 text-center text-caption text-muted" aria-hidden="true">
          {b.months.map((m) => (
            <li key={m.month}>{toMonthLabel(m.month)}</li>
          ))}
        </ul>
        <p className="mt-3 text-small text-muted">{t('simple.reports.byMonth.note')}</p>
      </section>
      <section className="mt-4 rounded-lg border border-line bg-panel shadow-elev-1">
        <DataTable
          testId="by-month"
          columns={columns}
          rows={[...b.months].reverse()}
          rowKey={(r) => r.month}
          toolbarFeatures={{ quickFilter: false, columns: false, groupBy: false, density: false, views: false }}
          maxHeight={NO_MAX}
        />
      </section>
    </>
  )
}
