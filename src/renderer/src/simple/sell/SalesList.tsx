import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { MessageKey } from '@shared/i18n'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { saleStatus, type SaleRow, type SaleStatus } from '@shared/simple/sell'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { Button, Page } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { recordPaymentScreen } from './recordPayment'
import { returnScreen, useReturnable } from '../returns/returnable'

const STATUS_TEXT: Record<SaleStatus, MessageKey> = {
  paid: 'simple.sales.status.paid',
  part: 'simple.sales.status.part',
  due: 'simple.sales.status.due',
  overdue: 'simple.sales.status.overdue',
  returned: 'simple.sales.status.returned'
}
const STATUS_CLS: Record<SaleStatus, string> = {
  paid: 'border-success/50 bg-success-soft text-ink',
  part: 'border-amber/60 bg-amberbar/10 text-ink',
  due: 'border-line bg-panel2 text-ink',
  overdue: 'border-danger/50 bg-danger-soft text-danger',
  returned: 'border-line bg-panel2 text-muted'
}

function StatusChip({ status }: { status: SaleStatus }): React.JSX.Element {
  const t = useT()
  const label = t(STATUS_TEXT[status]) // i18n-technical: typed key table
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-caption ${STATUS_CLS[status]}`} data-testid="sale-status" data-status={status}>
      {label}
    </span>
  )
}

/** WP 9.5: a bill with returns against it — "Returned ₹118.00". */
function ReturnedChip({ amount }: { amount: number }): React.JSX.Element {
  const t = useT()
  return (
    <span className="inline-block rounded-full border border-line bg-panel2 px-2 py-0.5 text-caption text-muted" data-testid="sale-returned" data-paise={amount}>
      {t('simple.returns.chip', { amount: formatPaise(amount, { symbol: true }) })}
    </span>
  )
}

const SELL_SCREEN = { name: 'simple-sell' } as const // i18n-technical
const SALE_SIDE = 'sale' as const // i18n-technical
const editScreen = (voucherId: number): { name: 'voucher-entry'; voucherId: number } => ({ name: 'voucher-entry', voucherId }) // i18n-technical

/**
 * WP 9.2 — the sales list: every bill of the working period with its customer, total, what was
 * paid and what is still due (the Outstandings allocation as on today, from simple:sales) and a
 * status chip. A row opens the bill's simple view; Print uses the existing invoice print path.
 */
export function SalesList({ billId }: { billId?: number }): React.JSX.Element {
  if (billId != null) return <BillView billId={billId} />
  return <SalesTable />
}

function SalesTable(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const { from, to, workingDate } = useSession()
  const until = workingDate < to ? workingDate : to
  const { data, isLoading } = useQuery({ queryKey: ['simpleSales', from, until, workingDate], queryFn: () => api.simple.sales(from, until, workingDate) }) // i18n-technical
  const rows = data ?? []
  const columns = useMemo(
    () =>
      defineColumns<SaleRow>([
        { id: 'date', header: t('simple.sales.col.date'), kind: 'date', value: (r) => r.date, text: (r) => toPlainDate(r.date), width: 130, groupable: false }, // i18n-technical
        { id: 'number', header: t('simple.sales.col.number'), kind: 'text', value: (r) => r.number, width: 110, groupable: false },
        {
          id: 'customer', header: t('simple.sales.col.customer'), kind: 'text', hideable: false, groupable: false,
          value: (r) => (r.walkIn ? t('simple.sales.cashCustomer') : r.partyName)
        },
        { id: 'total', header: t('simple.sales.col.total'), kind: 'money', value: (r) => r.total, aggregate: 'sum', explainable: false }, // i18n-technical
        { id: 'paid', header: t('simple.sales.col.paid'), kind: 'money', value: (r) => r.paid, aggregate: 'sum', explainable: false }, // i18n-technical
        { id: 'due', header: t('simple.sales.col.due'), kind: 'money', value: (r) => r.due, aggregate: 'sum', explainable: false }, // i18n-technical
        {
          id: 'status', header: t('simple.sales.col.status'), kind: 'text', groupable: false, filterable: false, // i18n-technical
          value: (r) => t(STATUS_TEXT[saleStatus(r.total, r.due, r.overdueDays, r.paid)]), // i18n-technical: typed key table
          cell: (r) => (
            <span className="flex flex-wrap items-center gap-1">
              <StatusChip status={saleStatus(r.total, r.due, r.overdueDays, r.paid)} />
              {r.returned > 0 && <ReturnedChip amount={r.returned} />}
            </span>
          )
        }
      ]),
    [t]
  )

  return (
    <Page data-testid="simple-sales">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.sales.title')}</h1>
          <p className="mt-1 text-detail text-muted">{t('simple.sales.period', { from: toPlainDate(from), to: toPlainDate(until) })}</p>
        </div>
        <Button variant="primary" data-testid="btn-sales-make-bill" onClick={() => nav.go(SELL_SCREEN)}>
          {t('simple.sales.makeBill')}
        </Button>
      </div>
      <section className="rounded-lg border border-line bg-panel shadow-elev-1">
        <DataTable
          testId="simple-sales"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.voucherId}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
          loading={isLoading}
          toolbarFeatures={{ quickFilter: true, columns: false, groupBy: false, density: false, views: false }}
          empty={{
            title: t('simple.sales.empty'),
            action: (
              <Button variant="primary" data-testid="btn-sales-empty-make" onClick={() => nav.go(SELL_SCREEN)}>
                {t('simple.sales.makeBill')}
              </Button>
            )
          }}
          totalsLabel={t('simple.sales.col.total')}
          onRowActivate={(r) => nav.go({ name: 'simple-sales', billId: r.voucherId })} // i18n-technical
          trailing={(r) => (
            <span className="flex justify-end gap-2">
              <button type="button" className="text-small text-blue hover:underline" data-testid="btn-sale-print" onClick={() => void api.invoice.pdf(r.voucherId)}>
                {t('common.print')}
              </button>
            </span>
          )}
          trailingWidth={70}
        />
      </section>
    </Page>
  )
}

function BillView({ billId }: { billId: number }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const workingDate = useSession((s) => s.workingDate)
  const { data: bill, isLoading } = useQuery({ queryKey: ['simpleSale', billId, workingDate], queryFn: () => api.simple.sale(billId, workingDate) }) // i18n-technical
  const returnable = useReturnable(SALE_SIDE, billId)
  const { data: setup } = useQuery({ queryKey: ['simpleSellSetup'], queryFn: api.simple.sellSetup }) // i18n-technical
  const money = (p: number): string => formatPaise(p, { symbol: true })
  if (isLoading) return <Page data-testid="simple-sale">{null}</Page>
  if (!bill) {
    return (
      <Page data-testid="simple-sale">
        <button type="button" className="mb-3 text-detail text-blue hover:underline" onClick={() => nav.back()}>
          {t('simple.bill.back')}
        </button>
        <p className="text-detail text-muted" data-testid="simple-sale-missing">{t('simple.bill.missing')}</p>
      </Page>
    )
  }
  const status = saleStatus(bill.total, bill.due, bill.overdueDays, bill.paid)
  return (
    <Page data-testid="simple-sale" data-bill={bill.voucherId}>
      <button type="button" className="mb-3 text-detail text-blue hover:underline" data-testid="btn-bill-back" onClick={() => nav.back()}>
        {t('simple.bill.back')}
      </button>
      <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.bill.heading', { number: bill.number })}</h1>
            <p className="mt-1 text-detail text-muted">
              {t('simple.bill.to', { name: bill.walkIn ? t('simple.sales.cashCustomer') : bill.partyName })} · {t('simple.bill.on', { date: toPlainDate(bill.date) })}
            </p>
          </div>
          <span className="flex flex-wrap items-center gap-1">
            <StatusChip status={status} />
            {bill.returned > 0 && <ReturnedChip amount={bill.returned} />}
          </span>
        </div>

        <h2 className="mt-5 mb-2 text-subtitle font-semibold text-ink">{t('simple.bill.items')}</h2>
        <ul className="divide-y divide-line" data-testid="simple-sale-lines">
          {bill.items.map((l, i) => (
            <li key={i} className="flex items-baseline justify-between gap-4 py-1.5 text-body">
              <span className="min-w-0">
                <span className="text-ink">{l.name}</span>{' '}
                <span className="text-small text-muted">
                  {t('simple.bill.qtyAt', { qty: formatQtyMilli(l.qtyMilli), unit: l.unit, rate: money(l.ratePaise) })}
                  {l.discountPaise > 0 && ` · ${t('simple.bill.lessDiscount', { amount: money(l.discountPaise) })}`}
                </span>
              </span>
              <span className="num text-ink">{money(l.amount)}</span>
            </li>
          ))}
          {bill.amounts.map((a, i) => (
            <li key={`a${i}`} className="flex items-baseline justify-between gap-4 py-1.5 text-body">
              <span className="text-ink">{bill.note || a.name}</span>
              <span className="num text-ink">{money(a.amount)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 text-detail">
          {bill.tax > 0 && (
            <>
              <dt className="text-muted">{t('simple.sell.gst')}</dt>
              <dd className="num text-right text-muted">{money(bill.tax)}</dd>
            </>
          )}
          {bill.rounding !== 0 && (
            <>
              <dt className="text-muted">{t('simple.sell.roundOff')}</dt>
              <dd className="num text-right text-muted" data-testid="simple-sale-rounding" data-paise={bill.rounding}>
                {money(bill.rounding)}
              </dd>
            </>
          )}
          <dt className="text-lead font-semibold text-ink">{t('simple.sell.total')}</dt>
          <dd className="num text-right text-lead font-semibold text-ink" data-testid="simple-sale-total" data-paise={bill.total}>
            {money(bill.total)}
          </dd>
        </dl>
        <p className="mt-3 text-body text-ink" data-testid="simple-sale-due">
          {bill.due <= 0
            ? t('simple.bill.paidAll')
            : bill.dueDate
              ? t('simple.bill.dueBy', { amount: money(bill.due), date: toPlainDate(bill.dueDate) })
              : t('simple.bill.due', { amount: money(bill.due) })}
          {bill.due > 0 && bill.paid > 0 && ` ${t('simple.bill.paidSoFar', { amount: money(bill.paid) })}`}
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button data-testid="btn-bill-print" onClick={() => void api.invoice.pdf(bill.voucherId)}>
            {t('common.print')}
          </Button>
          {bill.due > 0 && !bill.walkIn && (
            <Button variant="primary" data-testid="btn-bill-record-payment" onClick={() => nav.go(recordPaymentScreen(bill, setup?.defaults.cash ?? null))}>
              {t('simple.bill.recordPayment')}
            </Button>
          )}
          {returnable !== false && (
            <Button data-testid="btn-bill-return" title={t('simple.returns.returnItemsHint')} onClick={() => nav.go(returnScreen(SALE_SIDE, bill.voucherId))}>
              {t('simple.returns.returnItems')}
            </Button>
          )}
          <Button data-testid="btn-bill-edit" title={t('simple.bill.editHint')} onClick={() => nav.go(editScreen(bill.voucherId))}>
            {t('simple.bill.edit')}
          </Button>
        </div>
      </section>
    </Page>
  )
}
