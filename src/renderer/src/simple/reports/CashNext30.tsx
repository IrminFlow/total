import { useQuery } from '@tanstack/react-query'
import { toPlainDate } from '@shared/dates'
import type { CashFlowSource, CashItem, SimpleCash } from '@shared/simple/reports'
import { cashNext30Why, shortDate } from '@shared/simple/explain'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useSession } from '../../state/stores'
import { Page, SkeletonTiles } from '../../components/ui'
import { FigureTile, LoadError, ReportHeader, cardCls, money } from './parts'

const FORECAST = { name: 'cash-forecast' } as const // i18n-technical
const SOURCES: readonly CashFlowSource[] = ['customers', 'suppliers', 'taxes', 'loans', 'orders', 'other'] // i18n-technical

/**
 * WP 9.9 — Reports → Cash in the next 30 days: today's cash + bank, what the Cash forecast
 * (expected case) says comes in and goes out by then, the end balance and the lowest point, in
 * plain words (simple:reports:cash). The Accountant view is the full Cash forecast.
 */
export function CashNext30(): React.JSX.Element {
  const t = useT()
  const today = useSession((s) => s.workingDate)
  const q = useQuery({ queryKey: ['simpleReports', 'cash', today], queryFn: () => api.simpleReports.cash(today) }) // i18n-technical
  const c = q.data
  return (
    <Page data-testid="simple-report-cash">
      <ReportHeader
        testId="cash"
        title={t('simple.reports.cashNext30')}
        subtitle={c ? t('simple.reports.cash.subtitle', { from: toPlainDate(c.asOn), to: toPlainDate(c.until) }) : t('common.loading')}
        accountant={{ screen: FORECAST, hint: t('simple.reports.cash.accountant') }}
      />
      {q.isError && <LoadError testId="cash" text={t('simple.reports.loadError')} onRetry={() => void q.refetch()} />}
      {!c && !q.isError && <SkeletonTiles count={4} />}
      {c && <CashBody c={c} />}
    </Page>
  )
}

function CashBody({ c }: { c: SimpleCash }): React.JSX.Element {
  const t = useT()
  const why = cashNext30Why(c, t)
  const link = { label: t('simple.reports.cash.accountant'), screen: FORECAST }
  return (
    <>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <FigureTile id="cash-now" title={t('simple.reports.cash.now')} paise={c.now} why={why} link={link} />
        <FigureTile id="cash-in" title={t('simple.reports.cash.in')} paise={c.moneyIn} why={why} link={link} />
        <FigureTile id="cash-out" title={t('simple.reports.cash.out')} paise={c.moneyOut} why={why} link={link} />
        <FigureTile id="cash-end" emphasis title={t('simple.reports.cash.end', { date: shortDate(c.until, c.asOn) })} paise={c.end} why={why} link={link} />
      </ul>
      <p className="mt-3 text-detail text-ink" data-testid="cash-sentence">
        {why}
      </p>
      {c.warnings > 0 && <p className="mt-1 text-small text-muted">{t('simple.reports.cash.warnings')}</p>}
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Flows title={t('simple.reports.cash.incoming')} by={c.inBy} items={c.topIn} empty={t('simple.reports.cash.nothingIn')} asOn={c.asOn} testId="cash-incoming" />
        <Flows title={t('simple.reports.cash.outgoing')} by={c.outBy} items={c.topOut} empty={t('simple.reports.cash.nothingOut')} asOn={c.asOn} testId="cash-outgoing" />
      </div>
    </>
  )
}

function Flows({ title, by, items, empty, asOn, testId }: { title: string; by: SimpleCash['inBy']; items: CashItem[]; empty: string; asOn: string; testId: string }): React.JSX.Element {
  const t = useT()
  const parts = SOURCES.filter((s) => (by[s] ?? 0) > 0)
  return (
    <section className={cardCls} data-testid={testId}>
      <h2 className="text-subtitle font-semibold text-ink">{title}</h2>
      {parts.length === 0 && <p className="mt-2 text-detail text-muted">{empty}</p>}
      <ul className="mt-2 flex flex-col gap-1">
        {parts.map((s) => (
          <li key={s} className="flex items-baseline justify-between gap-3 text-body" data-testid={`${testId}-${s}`}>
            <span className="text-ink">{t('simple.reports.cash.source', { source: s })}</span>
            <span className="num text-ink">{money(by[s] ?? 0)}</span>
          </li>
        ))}
      </ul>
      {items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-0.5 border-t border-line pt-2">
          {items.map((i, n) => (
            <li key={n} className="flex items-baseline justify-between gap-3 text-small">
              <span className="min-w-0 truncate text-muted">
                {t('simple.reports.cash.item', { name: i.label || t('simple.reports.cash.source', { source: i.source }), date: shortDate(i.date, asOn) })}
              </span>
              <span className="num text-muted">{money(i.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
