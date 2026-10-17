import { useState } from 'react'
import { EmptyTeach } from '../help/EmptyTeach'
import { useQuery } from '@tanstack/react-query'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { BusinessDoing as Doing, ReportPeriodKind } from '@shared/simple/reports'
import {
  changeSentence, costWhy, doingCashWhy, doingCompareWhy, doingOwedWhy, doingResultWhy, expensesWhy, otherIncomeWhy, roundingWhy, profitOnGoodsWhy, salesCompareWhy
} from '@shared/simple/explain'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession, type Screen } from '../../state/stores'
import { Button, DateInput, Field, Page, SkeletonTiles } from '../../components/ui'
import { Choice, LoadError, ReportHeader, WhyLink, cardCls, money } from './parts'

const PNL = { name: 'profit-loss' } as const // i18n-technical
const OWED = { name: 'simple-reports', report: 'owed', side: 'receivable' } as const // i18n-technical

/**
 * WP 9.9 — "How is my business doing" (plan §3): for a period (this month / last month / this
 * FY / dates you pick), ONE column — sales, minus what the goods cost (stock at the start +
 * purchases − stock left), minus running costs, = profit — then cash + bank and who owes whom at
 * the period's end. Every figure is the P&L's own (simple:reports:doing); each line has its "Why?"
 * sentence; the Accountant view is the T-form P&L.
 */
export function BusinessDoing(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const today = useSession((s) => s.workingDate)
  const [period, setPeriod] = useState<ReportPeriodKind>('this-month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null)
  const query = period === 'custom' ? (custom ? { period, ...custom } : null) : { period }
  const q = useQuery({
    queryKey: ['simpleReports', 'doing', query, today], // i18n-technical
    queryFn: () => api.simpleReports.doing({ ...query!, today }),
    enabled: query != null,
    retry: false
  })
  const err = q.error ? mapError(q.error as CaughtError, { simple: true, t, fields: ['from', 'to'] }) : null // i18n-technical
  const d = q.data

  const options: { value: ReportPeriodKind; label: string }[] = [
    { value: 'this-month', label: t('simple.reports.period.thisMonth') },
    { value: 'last-month', label: t('simple.reports.period.lastMonth') },
    { value: 'this-year', label: t('simple.reports.period.thisYear') },
    { value: 'custom', label: t('simple.reports.period.custom') } // i18n-technical
  ]

  return (
    <Page data-testid="simple-report-doing">
      <ReportHeader
        testId="doing"
        title={t('simple.reports.howAmIDoing')}
        subtitle={d ? t('simple.reports.doing.subtitle', { from: toPlainDate(d.span.from, t.lang), to: toPlainDate(d.span.to, t.lang) }) : t('common.loading')}
        accountant={{ screen: d ? { ...PNL, from: d.span.from, to: d.span.to } : PNL, hint: t('simple.reports.doing.accountant') }}
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Choice label={t('simple.reports.period.label')} value={period} options={options} onChange={setPeriod} testId="doing-period" />
        {period === 'custom' && (
          <>
            <Field label={t('simple.reports.period.from')} name="from" error={err?.fields.from ?? null}>
              <DateInput testId="doing-from" allowEmpty value={from} context={today} onChange={setFrom} format={((d: string) => toPlainDate(d, t.lang))} />
            </Field>
            <Field label={t('simple.reports.period.to')} name="to" error={err?.fields.to ?? null}>
              <DateInput testId="doing-to" allowEmpty value={to} context={today} onChange={setTo} format={((d: string) => toPlainDate(d, t.lang))} />
            </Field>
            <Button variant="primary" data-testid="doing-show" disabled={!from || !to} onClick={() => setCustom({ from, to })}>
              {t('simple.reports.period.show')}
            </Button>
          </>
        )}
      </div>

      {q.isError && !err?.fields.to && !err?.fields.from && <LoadError testId="doing" text={t('simple.reports.loadError')} onRetry={() => void q.refetch()} />}
      {q.isLoading && query && <SkeletonTiles count={3} />}
      {d && d.empty && (
        <EmptyTeach
          testId="doing-empty"
          purpose={t('simple.reports.doing.empty')}
          action={{ label: t('simple.sales.makeBill'), testId: 'btn-doing-empty-sell', onClick: () => nav.go({ name: 'simple-sell' }) }} // i18n-technical
          help="reports" // i18n-technical
        />
      )}
      {d && !d.empty && <DoingBody d={d} />}
    </Page>
  )
}

function Line({
  id, op, label, paise, why, extra, strong, sub, link, unsigned
}: {
  /** WP 10.8: the label already says Loss — show the amount without its minus. */
  unsigned?: boolean
  id: string
  op: string
  label: string
  paise: number
  why: string
  extra?: string | null
  strong?: boolean
  sub?: string | null
  link?: { label: string; screen: Screen }
}): React.JSX.Element {
  return (
    <li className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 ${strong ? 'border-t-2 border-ink/70' : 'border-t border-line first:border-t-0'}`} data-testid={`doing-line-${id}`} data-paise={paise}>
      <span aria-hidden="true" className="num w-4 shrink-0 text-center text-muted">
        {op}
      </span>
      <span className={`min-w-0 flex-1 ${strong ? 'text-lead font-semibold text-ink' : 'text-body text-ink'}`}>
        {label}
        {sub && <span className="block text-small text-muted">{sub}</span>}
      </span>
      <span className={`num shrink-0 ${strong ? 'text-title font-semibold' : 'text-body'} ${paise < 0 ? 'text-cr' : 'text-ink'}`}>{money(unsigned ? Math.abs(paise) : paise)}</span>
      <span className="w-14 shrink-0 text-right"><WhyLink what={label} sentence={why} extra={extra} link={link} testId={`why-doing-${id}`} /></span>
    </li>
  )
}

function DoingBody({ d }: { d: Doing }): React.JSX.Element {
  const t = useT()
  const l = d.lines
  const result = l.profit < 0 ? 'loss' : 'profit' // i18n-technical
  const hasStock = l.openingStock !== 0 || l.closingStock !== 0
  const asOn = toPlainDate(d.asOn, t.lang)
  const tb = { name: 'trial-balance', asOn: d.asOn, ledgerIds: d.cash.ledgerIds } as const // i18n-technical
  // WP 10.2: every line's "Why?" opens the P&L for exactly the period it covers.
  const pnl = { label: t('simple.why.link.pnl', { from: toPlainDate(d.span.from, t.lang), to: toPlainDate(d.span.to, t.lang) }), screen: { name: 'profit-loss', from: d.span.from, to: d.span.to } as Screen } // i18n-technical
  return (
    <>
      <section className={cardCls} aria-label={t('simple.reports.howAmIDoing')}>
        <ul className="-my-1" data-testid="doing-column">
          <Line id="sales" op="" label={t('simple.reports.sales')} paise={l.sales} why={salesCompareWhy(d, t)} link={pnl} />
          <Line
            id="cost"
            op="−"
            label={t('simple.reports.costOfGoods')}
            paise={l.costOfGoods}
            why={costWhy(d, t)}
            link={pnl}
            sub={hasStock ? t('simple.reports.doing.costParts', { opening: money(l.openingStock), purchases: money(l.purchases), closing: money(l.closingStock) }) : null}
          />
          <Line id="goods" op="=" label={t('simple.reports.profitOnGoods')} paise={l.profitOnGoods} why={profitOnGoodsWhy(d, t)} link={pnl} />
          {l.otherIncome !== 0 && <Line id="other" op="+" label={t('simple.reports.otherIncome')} paise={l.otherIncome} why={otherIncomeWhy(d, t)} link={pnl} />}
          <Line id="expenses" op="−" label={t('simple.reports.expenses')} paise={l.expenses} why={expensesWhy(d, t)} link={pnl} />
          {!!l.rounding && <Line id="rounding" op={l.rounding < 0 ? '−' : '+'} unsigned label={t('common.rounding')} paise={l.rounding} why={roundingWhy(d, t)} link={pnl} />}
          <Line id="profit" op="=" strong unsigned label={t('simple.reports.doing.result', { result })} paise={l.profit} why={doingResultWhy(d, t)} extra={doingCompareWhy(d, t)} link={pnl} />
        </ul>
        <p className="mt-2 text-small text-muted" data-testid="doing-change">
          {changeSentence(l.profit, d.previousLines.profit, d.previous, t)}
        </p>
      </section>

      <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <li className={cardCls} data-testid="doing-cash" data-paise={d.cash.total}>
          <h2 className="text-small font-medium text-muted">{t('simple.reports.doing.cashTitle', { date: asOn })}</h2>
          <p className={`num mt-2 text-title font-semibold ${d.cash.total < 0 ? 'text-cr' : 'text-ink'}`}>{money(d.cash.total)}</p>
          <div className="mt-2">
            <WhyLink what={t('simple.reports.doing.cashTitle', { date: asOn })} sentence={doingCashWhy(d, t)} link={{ label: t('simple.reports.doing.linkCash'), screen: tb }} testId="why-doing-cash" />
          </div>
        </li>
        <li className={cardCls} data-testid="doing-owed">
          <h2 className="text-small font-medium text-muted">{t('simple.reports.doing.owedTitle', { date: asOn })}</h2>
          <dl className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <dt className="text-small text-muted">{t('simple.reports.doing.customersOwe')}</dt>
              <dd className="num text-lead font-semibold text-ink" data-testid="doing-receivable" data-paise={d.owed.receivable}>
                {money(d.owed.receivable)}
              </dd>
            </div>
            <div>
              <dt className="text-small text-muted">{t('simple.reports.doing.youOwe')}</dt>
              <dd className="num text-lead font-semibold text-ink" data-testid="doing-payable" data-paise={d.owed.payable}>
                {money(d.owed.payable)}
              </dd>
            </div>
          </dl>
          <div className="mt-2">
            <WhyLink what={t('simple.reports.doing.owedTitle', { date: asOn })} sentence={doingOwedWhy(d, t)} link={{ label: t('simple.reports.doing.linkOwed'), screen: OWED }} testId="why-doing-owed" />
          </div>
        </li>
      </ul>
    </>
  )
}
