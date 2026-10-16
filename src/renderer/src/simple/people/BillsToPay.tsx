import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { billTiming, type BillToPay } from '@shared/simple/people'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { DataTable, defineColumns } from '../../components/table'
import { moneyOutScreen } from '../money/moneyLinks'
import { Pill } from './Pill'
import { WhyLink } from '../reports/parts'
import { billsToPayWhy } from '@shared/simple/explain'

const WEEK = 'week' // i18n-technical
const MONTH = 'month' // i18n-technical
/** The tiles' "Why?" link: every open supplier bill, party by party (Outstandings, payable side). */
const PAYABLES = { name: 'outstandings', side: 'payable' } as const // i18n-technical

/**
 * WP 9.8 — People → Bills to pay: every supplier's open bill as on today (the Outstandings
 * allocation, simple:people:billsToPay), most late first, with what falls due this week (to
 * Sunday) and this month — late bills included — and what is already late. "Pay" opens Money out
 * for that supplier, what is still due and that bill (ticked). No payment run here.
 */
export function BillsToPay(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const workingDate = useSession((s) => s.workingDate)
  const canPay = useSession((s) => s.user == null || s.user.role !== 'viewer') // i18n-technical
  const { data, isLoading } = useQuery({ queryKey: ['simpleBillsToPay', workingDate], queryFn: () => api.simplePeople.billsToPay(workingDate) }) // i18n-technical
  const money = (p: number): string => formatPaise(p, { symbol: true })
  const today = data?.today ?? workingDate
  const columns = useMemo(
    () =>
      defineColumns<BillToPay>([
        { id: 'supplier', header: t('simple.people.col.supplier'), kind: 'text', hideable: false, value: (b) => b.party }, // i18n-technical
        { id: 'bill', header: t('simple.people.col.bill'), kind: 'text', width: 110, groupable: false, value: (b) => b.name }, // i18n-technical
        { id: 'date', header: t('simple.people.col.date'), kind: 'date', width: 120, groupable: false, value: (b) => b.date, text: (b) => toPlainDate(b.date, t.lang) }, // i18n-technical
        { id: 'due', header: t('simple.people.col.due'), kind: 'date', width: 120, groupable: false, value: (b) => b.dueDate ?? b.date, text: (b) => toPlainDate(b.dueDate ?? b.date, t.lang) }, // i18n-technical
        { id: 'pending', header: t('simple.people.col.pending'), kind: 'money', value: (b) => b.pending, aggregate: 'sum', explainable: false }, // i18n-technical
        {
          id: 'when', header: t('simple.people.col.when'), kind: 'text', groupable: false, filterable: false, // i18n-technical
          value: (b) => billTiming(b, today, t),
          cell: (b) => (
            <Pill tone={b.overdueDays > 0 ? 'danger' : 'neutral'} testId="bill-when" data={String(b.overdueDays)}>
              {billTiming(b, today, t)}
            </Pill>
          )
        }
      ]),
    [t, today]
  )
  return (
    <>
      {data && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3" data-testid="bills-to-pay-totals">
          <Tile label={t('simple.people.toPay.week', { date: toPlainDate(data.weekEnd, t.lang) })} amount={money(data.dueThisWeek)} testId="bills-due-week" paise={data.dueThisWeek}>
            <WhyLink what={t('simple.people.toPay.week', { date: toPlainDate(data.weekEnd, t.lang) })} sentence={billsToPayWhy(data, WEEK, t)} link={{ label: t('simple.why.link.outstandings'), screen: PAYABLES }} testId="why-bills-due-week" />
          </Tile>
          <Tile label={t('simple.people.toPay.month', { date: toPlainDate(data.monthEnd, t.lang) })} amount={money(data.dueThisMonth)} testId="bills-due-month" paise={data.dueThisMonth}>
            <WhyLink what={t('simple.people.toPay.month', { date: toPlainDate(data.monthEnd, t.lang) })} sentence={billsToPayWhy(data, MONTH, t)} link={{ label: t('simple.why.link.outstandings'), screen: PAYABLES }} testId="why-bills-due-month" />
          </Tile>
          <Tile label={t('simple.people.toPay.late')} amount={money(data.late)} testId="bills-late" paise={data.late} danger={data.late > 0} />
        </div>
      )}
      <section className="rounded-lg border border-line bg-panel shadow-elev-1">
        <DataTable
          testId="simple-bills-to-pay"
          columns={columns}
          rows={data?.bills ?? []}
          rowKey={(b) => `${b.ledgerId}|${b.voucherId ?? b.name}`}
          rowAttrs={(b) => ({ 'data-party': b.ledgerId, 'data-bill': b.name, 'data-pending': b.pending })}
          loading={isLoading}
          toolbarFeatures={{ quickFilter: true, columns: false, groupBy: false, density: false, views: false }}
          empty={{ title: t('simple.people.toPay.empty') }}
          totalsLabel={t('simple.sales.col.total')}
          onRowActivate={(b) => nav.go({ name: 'simple-person', id: b.ledgerId })} // i18n-technical
          trailing={(b) =>
            canPay ? (
              <button
                type="button"
                className="text-small font-medium text-blue hover:underline"
                data-testid="btn-bill-pay"
                onClick={() => nav.go(moneyOutScreen({ party: b.ledgerId, amount: b.pending, bill: b.name, billId: b.voucherId }))}
              >
                {t('simple.people.pay')}
              </button>
            ) : null
          }
          trailingWidth={60}
        />
      </section>
    </>
  )
}

function Tile({ label, amount, testId, paise, danger = false, children }: { label: string; amount: string; testId: string; paise: number; danger?: boolean; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" data-testid={testId} data-paise={paise}>
      <div className="text-detail text-muted">{label}</div>
      <div className={`num mt-1 text-lead font-semibold ${danger ? 'text-danger' : 'text-ink'}`}>{amount}</div>
      {children && <div className="mt-1">{children}</div>}
    </div>
  )
}
