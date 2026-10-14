import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { MessageKey } from '@shared/i18n'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { purchaseStatus, type PurchaseRow, type PurchaseStatus } from '@shared/simple/buy'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { Button, Page } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { recordSupplierPaymentScreen } from './recordSupplierPayment'

const STATUS_TEXT: Record<PurchaseStatus, MessageKey> = {
  paid: 'simple.purchases.status.paid',
  part: 'simple.purchases.status.part',
  due: 'simple.purchases.status.due',
  overdue: 'simple.purchases.status.overdue'
}
const STATUS_CLS: Record<PurchaseStatus, string> = {
  paid: 'border-success/50 bg-success-soft text-ink',
  part: 'border-amber/60 bg-amberbar/10 text-ink',
  due: 'border-line bg-panel2 text-ink',
  overdue: 'border-danger/50 bg-danger-soft text-danger'
}

function StatusChip({ status }: { status: PurchaseStatus }): React.JSX.Element {
  const t = useT()
  const label = t(STATUS_TEXT[status]) // i18n-technical: typed key table
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-caption ${STATUS_CLS[status]}`} data-testid="purchase-status" data-status={status}>
      {label}
    </span>
  )
}

const BUY_SCREEN = { name: 'simple-buy' } as const // i18n-technical
const editScreen = (voucherId: number): { name: 'voucher-entry'; voucherId: number } => ({ name: 'voucher-entry', voucherId }) // i18n-technical

/**
 * WP 9.3 — the purchase list: every supplier's bill of the working period with its supplier,
 * their bill number, total, what was paid and what is still to pay (the Outstandings allocation
 * as on today, from simple:purchases) and a status chip. A row opens the bill's simple view.
 */
export function PurchaseList({ billId }: { billId?: number }): React.JSX.Element {
  if (billId != null) return <PurchaseBillView billId={billId} />
  return <PurchaseTable />
}

function PurchaseTable(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const { from, to, workingDate } = useSession()
  const until = workingDate < to ? workingDate : to
  const { data, isLoading } = useQuery({ queryKey: ['simplePurchases', from, until, workingDate], queryFn: () => api.buy.purchases(from, until, workingDate) }) // i18n-technical
  const rows = data ?? []
  const columns = useMemo(
    () =>
      defineColumns<PurchaseRow>([
        { id: 'date', header: t('simple.purchases.col.date'), kind: 'date', value: (r) => r.date, text: (r) => toPlainDate(r.date), width: 130, groupable: false }, // i18n-technical
        {
          id: 'supplier', header: t('simple.purchases.col.supplier'), kind: 'text', hideable: false, groupable: false, // i18n-technical
          value: (r) => r.partyName
        },
        { id: 'billNo', header: t('simple.purchases.col.billNo'), kind: 'text', value: (r) => r.billNo ?? '', width: 130, groupable: false }, // i18n-technical
        { id: 'total', header: t('simple.purchases.col.total'), kind: 'money', value: (r) => r.total, aggregate: 'sum', explainable: false }, // i18n-technical
        { id: 'paid', header: t('simple.purchases.col.paid'), kind: 'money', value: (r) => r.paid, aggregate: 'sum', explainable: false }, // i18n-technical
        { id: 'due', header: t('simple.purchases.col.due'), kind: 'money', value: (r) => r.due, aggregate: 'sum', explainable: false }, // i18n-technical
        {
          id: 'status', header: t('simple.purchases.col.status'), kind: 'text', groupable: false, filterable: false, // i18n-technical
          value: (r) => t(STATUS_TEXT[purchaseStatus(r.total, r.due, r.overdueDays)]), // i18n-technical: typed key table
          cell: (r) => <StatusChip status={purchaseStatus(r.total, r.due, r.overdueDays)} />
        }
      ]),
    [t]
  )

  return (
    <Page data-testid="simple-purchases">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.purchases.title')}</h1>
          <p className="mt-1 text-detail text-muted">{t('simple.purchases.period', { from: toPlainDate(from), to: toPlainDate(until) })}</p>
        </div>
        <Button variant="primary" data-testid="btn-purchases-record" onClick={() => nav.go(BUY_SCREEN)}>
          {t('simple.purchases.record')}
        </Button>
      </div>
      <section className="rounded-lg border border-line bg-panel shadow-elev-1">
        <DataTable
          testId="simple-purchases"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.voucherId}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
          loading={isLoading}
          toolbarFeatures={{ quickFilter: true, columns: false, groupBy: false, density: false, views: false }}
          empty={{
            title: t('simple.purchases.empty'),
            action: (
              <Button variant="primary" data-testid="btn-purchases-empty-record" onClick={() => nav.go(BUY_SCREEN)}>
                {t('simple.purchases.record')}
              </Button>
            )
          }}
          totalsLabel={t('simple.buy.total')}
          onRowActivate={(r) => nav.go({ name: 'simple-purchases', billId: r.voucherId })} // i18n-technical
        />
      </section>
    </Page>
  )
}

function PurchaseBillView({ billId }: { billId: number }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const workingDate = useSession((s) => s.workingDate)
  const { data: bill, isLoading } = useQuery({ queryKey: ['simplePurchase', billId, workingDate], queryFn: () => api.buy.purchase(billId, workingDate) }) // i18n-technical
  const { data: setup } = useQuery({ queryKey: ['simpleBuySetup'], queryFn: api.buy.setup }) // i18n-technical
  const money = (p: number): string => formatPaise(p, { symbol: true })
  if (isLoading) return <Page data-testid="simple-purchase">{null}</Page>
  if (!bill) {
    return (
      <Page data-testid="simple-purchase">
        <button type="button" className="mb-3 text-detail text-blue hover:underline" onClick={() => nav.back()}>
          {t('simple.purchase.back')}
        </button>
        <p className="text-detail text-muted" data-testid="simple-purchase-missing">{t('simple.purchase.missing')}</p>
      </Page>
    )
  }
  const status = purchaseStatus(bill.total, bill.due, bill.overdueDays)
  return (
    <Page data-testid="simple-purchase" data-bill={bill.voucherId}>
      <button type="button" className="mb-3 text-detail text-blue hover:underline" data-testid="btn-purchase-back" onClick={() => nav.back()}>
        {t('simple.purchase.back')}
      </button>
      <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">
              {bill.billNo ? t('simple.purchase.heading', { billNo: bill.billNo }) : t('simple.purchase.headingNoNumber')}
            </h1>
            <p className="mt-1 text-detail text-muted">
              {t('simple.purchase.from', { name: bill.partyName })} · {t('simple.purchase.on', { date: toPlainDate(bill.date) })}
            </p>
          </div>
          <StatusChip status={status} />
        </div>

        <h2 className="mt-5 mb-2 text-subtitle font-semibold text-ink">{t('simple.purchase.items')}</h2>
        <ul className="divide-y divide-line" data-testid="simple-purchase-lines">
          {bill.items.map((l, i) => (
            <li key={i} className="flex items-baseline justify-between gap-4 py-1.5 text-body">
              <span className="min-w-0">
                <span className="text-ink">{l.name}</span>{' '}
                <span className="text-small text-muted">
                  {t('simple.purchase.qtyAt', { qty: formatQtyMilli(l.qtyMilli), unit: l.unit, rate: money(l.ratePaise) })}
                  {l.discountPaise > 0 && ` · ${t('simple.purchase.lessDiscount', { amount: money(l.discountPaise) })}`}
                </span>
              </span>
              <span className="num text-ink">{money(l.amount)}</span>
            </li>
          ))}
          {bill.amounts.map((a, i) => (
            <li key={`a${i}`} className="flex items-baseline justify-between gap-4 py-1.5 text-body">
              <span className="text-ink">{a.name}</span>
              <span className="num text-ink">{money(a.amount)}</span>
            </li>
          ))}
        </ul>
        {bill.note && <p className="mt-2 text-detail text-muted">{bill.note}</p>}
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 text-detail">
          {bill.tax > 0 && (
            <>
              <dt className="text-muted">{t('simple.buy.gstClaim')}</dt>
              <dd className="num text-right text-muted" data-testid="simple-purchase-tax">{money(bill.tax)}</dd>
            </>
          )}
          <dt className="text-lead font-semibold text-ink">{t('simple.buy.total')}</dt>
          <dd className="num text-right text-lead font-semibold text-ink" data-testid="simple-purchase-total" data-paise={bill.total}>
            {money(bill.total)}
          </dd>
        </dl>
        <p className="mt-3 text-body text-ink" data-testid="simple-purchase-due">
          {bill.due <= 0
            ? t('simple.purchase.paidAll')
            : bill.dueDate
              ? t('simple.purchase.dueBy', { amount: money(bill.due), date: toPlainDate(bill.dueDate) })
              : t('simple.purchase.due', { amount: money(bill.due) })}
          {bill.due > 0 && bill.paid > 0 && ` ${t('simple.purchase.paidSoFar', { amount: money(bill.paid) })}`}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {bill.due > 0 && (
            <Button variant="primary" data-testid="btn-purchase-record-payment" onClick={() => nav.go(recordSupplierPaymentScreen(bill, setup?.defaults.cash ?? null))}>
              {t('simple.purchase.recordPayment')}
            </Button>
          )}
          <Button data-testid="btn-purchase-edit" title={t('simple.purchase.editHint')} onClick={() => nav.go(editScreen(bill.voucherId))}>
            {t('simple.purchase.edit')}
          </Button>
        </div>
      </section>
    </Page>
  )
}
