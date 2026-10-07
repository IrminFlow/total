// Order reports (WP 2.5c): Pending sales orders / Pending purchase orders — one row per open order
// line with ordered, done, pending, value, age and overdue days, as on the period end (group by
// party or item from the toolbar) — and the Quotation pipeline: every quotation in the period
// with its outcome, converted value and the conversion rate. All drill to the documents.
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { PendingOrderRow, QuotationOutcome, QuotationPipelineRow } from '@shared/tradeCycle/types'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Badge, Button, DrawerSection, Page, PageHeader, Panel, StatGrid, StatTile } from '../components/ui'
import type { BadgeTone } from '../components/kit/Badge'
import { OptionsPeriod, OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { ItemLink, LedgerLink, TradeDocLink } from '../components/links'
import { TabBar } from '../components/TabBar'

export type OrderKind = 'sales_order' | 'purchase_order'

const AGE_BUCKETS = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const
const bucketOf = (days: number): string => AGE_BUCKETS[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3]!

function pendingColumns(kind: OrderKind) {
  const sales = kind === 'sales_order'
  return defineColumns<PendingOrderRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
    {
      id: 'number', header: sales ? 'SO' : 'PO', kind: 'text', value: (r) => r.number, width: 96, hideable: false,
      cell: (r) => <TradeDocLink tradeDocId={r.docId} kind={kind} label={<span className="num">{r.number}</span>} />
    },
    {
      id: 'party', header: sales ? 'Customer' : 'Supplier', kind: 'text', value: (r) => r.partyName, minWidth: 150,
      cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} />
    },
    {
      id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 140,
      cell: (r) => <ItemLink itemId={r.stockItemId} name={r.itemName} />
    },
    { id: 'line', header: 'Line', kind: 'number', value: (r) => r.lineNo, width: 56, defaultHidden: true },
    { id: 'qty', header: 'Ordered', kind: 'quantity', value: (r) => r.qtyMilli, decimals: (r) => r.decimals, width: 96, defaultHidden: true },
    { id: 'done', header: sales ? 'Delivered' : 'Received', kind: 'quantity', value: (r) => r.doneMilli, decimals: (r) => r.decimals, width: 96 },
    { id: 'pending', header: 'Pending', kind: 'quantity', value: (r) => r.pendingMilli, decimals: (r) => r.decimals, unit: (r) => r.unit ?? '', width: 110, aggregate: 'sum' },
    { id: 'rate', header: 'Rate', kind: 'money', value: (r) => r.ratePaise, width: 116, defaultHidden: true },
    { id: 'value', header: 'Pending value', kind: 'money', value: (r) => r.pendingValue, width: 130, aggregate: 'sum' },
    { id: 'due', header: sales ? 'Expected' : 'Deliver by', kind: 'date', value: (r) => r.dueDate ?? '' },
    {
      id: 'overdue', header: 'Overdue', kind: 'number', value: (r) => r.overdueDays, width: 84,
      text: (r) => (r.overdueDays > 0 ? `${r.overdueDays} d` : ''),
      cell: (r) => (r.overdueDays > 0 ? <Badge tone="warning">{r.overdueDays} d</Badge> : <span className="text-muted">—</span>)
    },
    { id: 'age', header: 'Age', kind: 'number', value: (r) => r.ageDays, text: (r) => `${r.ageDays} d`, width: 70 },
    { id: 'bucket', header: 'Ageing', kind: 'text', value: (r) => bucketOf(r.ageDays), groupKey: (r) => bucketOf(r.ageDays), width: 104, defaultHidden: true }
  ])
}

const PENDING_COLUMNS: Record<OrderKind, ReturnType<typeof pendingColumns>> = {
  sales_order: pendingColumns('sales_order'),
  purchase_order: pendingColumns('purchase_order')
}
const PENDING_TITLE: Record<OrderKind, string> = { sales_order: 'Pending sales orders', purchase_order: 'Pending purchase orders' }

export function PendingOrdersScreen({ kind }: { kind: OrderKind }): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const { data, isLoading } = useQuery({ queryKey: ['tradePendingOrders', kind, to], queryFn: () => api.trade.pendingOrders(kind, to) })
  const rows = data ?? []
  const sales = kind === 'sales_order'
  const periodLabel = `as on ${toDisplayDate(to)}`
  return (
    <Page width="wide">
      <PageHeader
        title={PENDING_TITLE[kind]}
        period={periodLabel}
        tabs={
          <TabBar
            screen="trade-pending-orders"
            tabs={[
              { id: 'sales_order', label: 'Sales orders to deliver' },
              { id: 'purchase_order', label: 'Purchase orders to receive' }
            ]}
            active={kind}
            onSelect={(k) => nav.go({ name: k === 'sales_order' ? 'pending-sales-orders' : 'pending-purchase-orders' })}
          />
        }
        actions={
          <Button data-testid="btn-pending-orders-list" onClick={() => nav.go({ name: sales ? 'sales-orders' : 'purchase-orders' })}>
            {sales ? 'Sales orders' : 'Purchase orders'}
          </Button>
        }
        options={{
          content: (
            <>
              <OptionsPeriod asOn />
              <OptionsTable area={`trade-pending-${kind}`} />
              <DrawerSection title="About this report">
                <p className="text-hint text-muted">
                  Open {sales ? 'sales' : 'purchase'} order lines not yet {sales ? 'delivered (challan) or invoiced' : 'received (GRN) or billed'}.
                  A line counts as done once a live {sales ? 'challan or invoice' : 'GRN or bill'} dated on or before the report date draws on it;
                  returns never re-open an order. Short-closed, cancelled and binned orders are not pending. The value is the line&apos;s
                  taxable value for the pending quantity; overdue runs from the line&apos;s (else the order&apos;s) expected date. Group by
                  customer, item or ageing from the table toolbar.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <Panel>
        <DataTable
          key={kind}
          viewId={`trade-pending-${kind}`}
          testId={`trade-pending-${kind}`}
          ariaLabel={PENDING_TITLE[kind]}
          columns={PENDING_COLUMNS[kind]}
          rows={rows}
          rowKey={(r) => r.lineUid}
          rowAttrs={(r) => ({ 'data-row-id': r.docId })}
          loading={isLoading}
          onRowActivate={(r) => nav.go({ name: 'trade-doc', kind, id: r.docId })}
          empty={{
            title: sales ? 'Every sales order is delivered' : 'Every purchase order is received',
            hint: sales ? 'Draw on an order with “Add from sales orders…” (⌥A) in a delivery challan, or from a sales invoice.' : 'Draw on an order with “Add from purchase orders…” (⌥A) in a GRN, or from a purchase bill.'
          }}
          exportOptions={{ title: PENDING_TITLE[kind], periodLabel, filename: sales ? 'pending-sales-orders' : 'pending-purchase-orders' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Click a line to open its order · F12 for options.</p>
    </Page>
  )
}

// ---------- quotation pipeline ----------

const OUTCOME: Record<QuotationOutcome, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'info' },
  expired: { label: 'Expired', tone: 'warning' },
  converted: { label: 'Converted', tone: 'success' },
  partly_converted: { label: 'Partly converted', tone: 'amber' },
  lost: { label: 'Lost', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'danger' }
}

const PIPELINE_COLUMNS = defineColumns<QuotationPipelineRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  {
    id: 'number', header: 'Quotation', kind: 'text', value: (r) => r.number, width: 104, hideable: false,
    cell: (r) => <TradeDocLink tradeDocId={r.docId} kind="quotation" label={<span className="num">{r.number}</span>} />
  },
  {
    id: 'party', header: 'Customer', kind: 'text', value: (r) => r.partyName, minWidth: 150,
    cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} />
  },
  { id: 'valid', header: 'Valid until', kind: 'date', value: (r) => r.validUntil ?? '' },
  { id: 'taxable', header: 'Quoted (taxable)', kind: 'money', value: (r) => r.taxable, width: 140, aggregate: 'sum' },
  { id: 'total', header: 'Quoted (with GST)', kind: 'money', value: (r) => r.total, width: 140, defaultHidden: true, aggregate: 'sum' },
  { id: 'converted', header: 'Converted', kind: 'money', value: (r) => r.convertedValue, width: 130, aggregate: 'sum' },
  {
    id: 'outcome', header: 'Outcome', kind: 'enum', value: (r) => r.outcome, width: 136,
    options: (Object.keys(OUTCOME) as QuotationOutcome[]).map((k) => ({ value: k, label: OUTCOME[k].label })),
    text: (r) => OUTCOME[r.outcome].label,
    cell: (r) => <Badge tone={OUTCOME[r.outcome].tone} testId="pipeline-outcome">{OUTCOME[r.outcome].label}</Badge>
  },
  { id: 'to', header: 'Converted to', kind: 'text', value: (r) => r.convertedTo.join(', '), minWidth: 140 },
  { id: 'reason', header: 'Reason', kind: 'text', value: (r) => r.closeReason ?? '', defaultHidden: true }
])

export function QuotationPipelineScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const { data, isLoading } = useQuery({ queryKey: ['quotationPipeline', from, to], queryFn: () => api.trade.quotationPipeline(from, to, to) })
  const rows = data?.rows ?? []
  const periodLabel = `${toDisplayDate(from)} to ${toDisplayDate(to)}`
  const count = (o: QuotationOutcome[]): number => rows.filter((r) => o.includes(r.outcome)).length
  const openValue = rows.filter((r) => r.outcome === 'open').reduce((s, r) => s + r.taxable, 0)
  return (
    <Page width="wide">
      <PageHeader
        title="Quotation pipeline"
        period={periodLabel}
        actions={<Button onClick={() => nav.go({ name: 'quotations' })}>Quotations</Button>}
        options={{
          content: (
            <>
              <OptionsPeriod note="Quotations dated in the working period; their outcome as on its last day." />
              <OptionsTable area="quotation-pipeline" />
              <DrawerSection title="How the rate is worked out">
                <p className="text-hint text-muted">
                  Conversion rate = quotations converted (fully or partly, into sales orders or invoices) ÷ quotations decided —
                  converted, lost (closed with nothing converted) or expired. Open and cancelled quotations are not decided yet.
                  The value rate compares converted taxable value with everything quoted (cancelled ones aside).
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <StatGrid className="mb-section">
        <StatTile label="Conversion rate" value={data?.conversionRatePct == null ? '—' : `${data.conversionRatePct}%`} hint={`${count(['converted', 'partly_converted'])} of ${count(['converted', 'partly_converted', 'lost', 'expired'])} decided`} testId="pipeline-rate" />
        <StatTile label="Value converted" value={data?.valueConversionPct == null ? '—' : `${data.valueConversionPct}%`} hint={formatPaise(rows.reduce((s, r) => s + r.convertedValue, 0), { symbol: true })} />
        <StatTile label="Open" value={String(count(['open']))} hint={formatPaise(openValue, { symbol: true })} />
        <StatTile label="Expired / lost" value={String(count(['expired', 'lost']))} hint="follow up or close" />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="quotation-pipeline"
          testId="quotation-pipeline"
          ariaLabel="Quotation pipeline"
          columns={PIPELINE_COLUMNS}
          rows={rows}
          rowKey={(r) => r.docId}
          rowAttrs={(r) => ({ 'data-row-id': r.docId, 'data-outcome': r.outcome })}
          loading={isLoading}
          onRowActivate={(r) => nav.go({ name: 'trade-doc', kind: 'quotation', id: r.docId })}
          empty={{ title: 'No quotations in this period', hint: 'Quotations → New quotation.' }}
          exportOptions={{ title: 'Quotation pipeline', periodLabel, filename: 'quotation-pipeline' }}
        />
      </Panel>
    </Page>
  )
}
