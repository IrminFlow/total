import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toPlainDate } from '@shared/dates'
import type { OwedParty } from '@shared/simple/reports'
import { owedListWhy } from '@shared/simple/explain'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { Button, Page } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { Choice, LoadError, ReportHeader, WhyLink, cardCls, money } from './parts'

type Side = 'receivable' | 'payable'
const SIDES: readonly Side[] = ['receivable', 'payable'] // i18n-technical
const PEOPLE = { name: 'simple-section', section: 'people' } as const // i18n-technical
const outstandingsOf = (side: Side): { name: 'outstandings'; side: Side } => ({ name: 'outstandings', side }) // i18n-technical
const statement = (ledgerId: number): { name: 'ledger-statement'; ledgerId: number } => ({ name: 'ledger-statement', ledgerId }) // i18n-technical

/**
 * WP 9.9 — Reports → Who owes me / Whom I owe, as on TODAY (simple:reports:owed — the
 * Outstandings allocation, advances included): the total with its "Why?", one row per customer /
 * supplier (open, past due, bills, oldest), a link to People and the Accountant view
 * (Outstandings on the same side). A row opens that person's statement.
 */
export function WhoOwes({ side: initial }: { side?: Side }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const today = useSession((s) => s.workingDate)
  const [side, setSide] = useState<Side>(initial ?? 'receivable') // i18n-technical
  const q = useQuery({ queryKey: ['simpleReports', 'owed', side, today], queryFn: () => api.simpleReports.owed(side, today) }) // i18n-technical
  const o = q.data
  const receivable = side === 'receivable'
  const title = receivable ? t('simple.reports.whoOwesMe') : t('simple.reports.whomIOwe')

  const columns = useMemo(
    () =>
      defineColumns<OwedParty>([
        { id: 'name', header: receivable ? t('simple.reports.owed.colCustomer') : t('simple.reports.owed.colSupplier'), kind: 'text', hideable: false, groupable: false, value: (r) => r.name }, // i18n-technical
        { id: 'pending', header: t('simple.reports.owed.colPending'), kind: 'money', value: (r) => r.pending, aggregate: 'sum', explainable: false }, // i18n-technical
        { id: 'overdue', header: t('simple.reports.owed.colOverdue'), kind: 'money', value: (r) => r.overdue || null, aggregate: 'sum', explainable: false }, // i18n-technical
        { id: 'bills', header: t('simple.reports.owed.colBills'), kind: 'number', value: (r) => r.bills, filterable: false }, // i18n-technical
        { id: 'oldest', header: t('simple.reports.owed.colOldest'), kind: 'number', value: (r) => r.oldestDays, text: (r) => t('simple.reports.owed.days', { days: r.oldestDays }), filterable: false } // i18n-technical
      ]),
    [t, receivable]
  )

  return (
    <Page data-testid="simple-report-owed" data-side={side}>
      <ReportHeader
        testId="owed"
        title={title}
        subtitle={t('simple.reports.owed.subtitle', { date: toPlainDate(o?.asOn ?? today) })}
        accountant={{ screen: outstandingsOf(side), hint: t('simple.reports.owed.accountant') }}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Choice
          label={title}
          value={side}
          options={SIDES.map((value) => ({ value, label: value === 'receivable' ? t('simple.reports.whoOwesMe') : t('simple.reports.whomIOwe') }))}
          onChange={setSide}
          testId="owed-side"
        />
        <Button data-testid="owed-people" onClick={() => nav.go(PEOPLE)}>
          {t('simple.reports.owed.people')}
        </Button>
      </div>
      {q.isError && <LoadError testId="owed" text={t('simple.reports.loadError')} onRetry={() => void q.refetch()} />}
      {o && (
        <section className={`${cardCls} mb-4`} data-testid="owed-total" data-paise={o.total}>
          <p className="num text-heading font-semibold text-ink">{money(o.total)}</p>
          <p className="mt-1 text-detail text-ink" data-testid="owed-sentence">
            {owedListWhy(o, t)}
          </p>
          <div className="mt-2">
            <WhyLink what={title} sentence={owedListWhy(o, t)} link={{ label: t('simple.reports.owed.accountant'), screen: outstandingsOf(side) }} testId="why-owed" />
          </div>
        </section>
      )}
      <section className="rounded-lg border border-line bg-panel shadow-elev-1">
        <DataTable
          testId="owed"
          columns={columns}
          rows={o?.parties ?? []}
          rowKey={(r) => r.ledgerId}
          rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
          loading={q.isLoading}
          toolbarFeatures={{ quickFilter: true, columns: false, groupBy: false, density: false, views: false }}
          empty={{ title: receivable ? t('simple.reports.owed.noneReceivable') : t('simple.reports.owed.nonePayable') }}
          onRowActivate={(r) => nav.go(statement(r.ledgerId))}
        />
      </section>
    </Page>
  )
}
