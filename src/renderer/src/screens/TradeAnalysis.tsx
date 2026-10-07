// Order analysis (WP 2.5d): the order book by party and by month (ordered, fulfilled, pending,
// short-closed taxable value), fulfilment lead time per order (order → delivery → invoice days),
// and demand vs stock vs on-order per item. Sales or purchase side from the header. Every row
// drills down — a party / month to its orders, an order to its document.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { summariseOrderBook } from '@shared/tradeCycle/analysis'
import { tradeStatusLabel } from '@shared/tradeCycle/edit'
import type { ItemDemandRow, LeadTimeRow, OrderBookRow, OrderBookSummaryRow } from '@shared/tradeCycle/types'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Badge, Button, Chip, DrawerSection, Page, PageHeader, Panel, Segmented, StatGrid, StatTile } from '../components/ui'
import { OptionToggle, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { ItemLink, LedgerLink, TradeDocLink } from '../components/links'
import { TabBar } from '../components/TabBar'

type OrderKind = 'sales_order' | 'purchase_order'
export type OrderBookTab = 'party' | 'month' | 'lead-time'

const SIDES = [
  { value: 'sales_order' as const, label: 'Sales orders' },
  { value: 'purchase_order' as const, label: 'Purchase orders' }
]

const pctText = (p: number | null): string => (p == null ? '—' : `${p} %`)

function summaryColumns(by: 'party' | 'month') {
  return defineColumns<OrderBookSummaryRow>([
    {
      id: 'label', header: by === 'party' ? 'Party' : 'Month', kind: 'text', value: (r) => (by === 'month' ? r.month : r.label),
      text: (r) => r.label, minWidth: 160, hideable: false,
      cell: (r) => (by === 'party' && r.partyLedgerId ? <LedgerLink ledgerId={r.partyLedgerId} name={r.label} /> : <>{r.label}</>)
    },
    { id: 'orders', header: 'Orders', kind: 'number', value: (r) => r.orders, width: 72, aggregate: 'sum' },
    { id: 'ordered', header: 'Ordered', kind: 'money', value: (r) => r.orderedValue, width: 130, aggregate: 'sum' },
    { id: 'fulfilled', header: 'Fulfilled', kind: 'money', value: (r) => r.fulfilledValue, width: 130, aggregate: 'sum' },
    { id: 'pending', header: 'Pending', kind: 'money', value: (r) => r.pendingValue, width: 130, aggregate: 'sum' },
    { id: 'short', header: 'Short-closed', kind: 'money', value: (r) => r.shortClosedValue, width: 120, aggregate: 'sum' },
    { id: 'pct', header: 'Done %', kind: 'number', value: (r) => r.fulfilledPct, text: (r) => pctText(r.fulfilledPct), width: 84 }
  ])
}
const PARTY_COLUMNS = summaryColumns('party')
const MONTH_COLUMNS = summaryColumns('month')

function orderColumns(kind: OrderKind) {
  return defineColumns<OrderBookRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
    {
      id: 'number', header: kind === 'sales_order' ? 'SO' : 'PO', kind: 'text', value: (r) => r.number, width: 96,
      cell: (r) => <TradeDocLink tradeDocId={r.docId} kind={kind} label={<span className="num">{r.number}</span>} />
    },
    { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 140, cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> },
    { id: 'status', header: 'Status', kind: 'text', value: (r) => tradeStatusLabel(kind, r.status), width: 130 },
    { id: 'ordered', header: 'Ordered', kind: 'money', value: (r) => r.orderedValue, width: 120, aggregate: 'sum' },
    { id: 'fulfilled', header: 'Fulfilled', kind: 'money', value: (r) => r.fulfilledValue, width: 120, aggregate: 'sum' },
    { id: 'pending', header: 'Pending', kind: 'money', value: (r) => r.pendingValue, width: 120, aggregate: 'sum' },
    { id: 'short', header: 'Short-closed', kind: 'money', value: (r) => r.shortClosedValue, width: 120, aggregate: 'sum' }
  ])
}
const ORDER_COLUMNS: Record<OrderKind, ReturnType<typeof orderColumns>> = { sales_order: orderColumns('sales_order'), purchase_order: orderColumns('purchase_order') }

const days = (d: number | null): string => (d == null ? '' : `${d} d`)

function leadColumns(kind: OrderKind) {
  const sales = kind === 'sales_order'
  return defineColumns<LeadTimeRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
    {
      id: 'number', header: sales ? 'SO' : 'PO', kind: 'text', value: (r) => r.number, width: 96, hideable: false,
      cell: (r) => <TradeDocLink tradeDocId={r.docId} kind={kind} label={<span className="num">{r.number}</span>} />
    },
    { id: 'party', header: sales ? 'Customer' : 'Supplier', kind: 'text', value: (r) => r.partyName, minWidth: 140, cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> },
    { id: 'first', header: sales ? 'First delivery' : 'First receipt', kind: 'date', value: (r) => r.firstDeliveryDate ?? '' },
    { id: 'firstDays', header: 'Days', kind: 'number', value: (r) => r.daysToFirstDelivery, text: (r) => days(r.daysToFirstDelivery), width: 64 },
    { id: 'full', header: sales ? 'Fully delivered' : 'Fully received', kind: 'date', value: (r) => r.fullDeliveryDate ?? '' },
    { id: 'fullDays', header: 'Days', kind: 'number', value: (r) => r.daysToFullDelivery, text: (r) => days(r.daysToFullDelivery), width: 64 },
    { id: 'invoice', header: sales ? 'First invoice' : 'First bill', kind: 'date', value: (r) => r.firstInvoiceDate ?? '' },
    { id: 'toInvoice', header: sales ? 'To invoice' : 'To bill', kind: 'number', value: (r) => r.daysDeliveryToInvoice, text: (r) => days(r.daysDeliveryToInvoice), width: 96 },
    { id: 'orderToInvoice', header: sales ? 'Order → inv.' : 'Order → bill', kind: 'number', value: (r) => r.daysOrderToInvoice, text: (r) => days(r.daysOrderToInvoice), width: 112 },
    { id: 'status', header: 'Status', kind: 'text', value: (r) => tradeStatusLabel(kind, r.status), width: 128, defaultHidden: true }
  ])
}
const LEAD_COLUMNS: Record<OrderKind, ReturnType<typeof leadColumns>> = { sales_order: leadColumns('sales_order'), purchase_order: leadColumns('purchase_order') }

const avg = (xs: (number | null)[]): string => {
  const v = xs.filter((x): x is number => x != null)
  return v.length === 0 ? '—' : `${Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10} d`
}

export function OrderBookScreen({ tab: initialTab = 'party' }: { tab?: OrderBookTab }): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const opts = useScreenOptions('order-book', { side: 'sales_order' as OrderKind }, { side: ['sales_order', 'purchase_order'] })
  const kind = opts.options.side
  const sales = kind === 'sales_order'
  const [tab, setTab] = useState<OrderBookTab>(initialTab)
  // A party / month picked in a summary narrows to its orders.
  const [drill, setDrill] = useState<{ by: 'party' | 'month'; key: string; label: string } | null>(null)
  const { data: book, isLoading } = useQuery({ queryKey: ['tradeOrderBook', kind, from, to], queryFn: () => api.trade.orderBook(kind, from, to) })
  const { data: lead, isLoading: leadLoading } = useQuery({
    queryKey: ['tradeLeadTime', kind, from, to],
    queryFn: () => api.trade.leadTime(kind, from, to, to),
    enabled: tab === 'lead-time'
  })
  const rows = useMemo(() => book ?? [], [book])
  const byParty = useMemo(() => summariseOrderBook(rows, 'party'), [rows])
  const byMonth = useMemo(() => summariseOrderBook(rows, 'month'), [rows])
  const drilled = drill ? rows.filter((r) => (drill.by === 'party' ? `p${r.partyLedgerId}` : r.month) === drill.key) : []
  const periodLabel = `${toDisplayDate(from)} to ${toDisplayDate(to)}`
  const total = (f: (r: OrderBookRow) => number): number => rows.reduce((s, r) => s + f(r), 0)
  const title = 'Order book'
  return (
    <Page width="wide">
      <PageHeader
        title={title}
        period={periodLabel}
        tabs={
          <TabBar
            screen="order-book"
            tabs={[
              { id: 'party', label: 'By party' },
              { id: 'month', label: 'By month' },
              { id: 'lead-time', label: 'Fulfilment lead time' }
            ]}
            active={tab}
            onSelect={(t) => {
              setTab(t)
              setDrill(null)
            }}
          />
        }
        controls={
          <Segmented
            label="Orders"
            size="sm"
            options={SIDES}
            value={kind}
            onChange={(v) => {
              opts.set('side', v)
              setDrill(null)
            }}
            testId="input-order-book-side"
          />
        }
        secondary={<Button onClick={() => nav.go({ name: sales ? 'pending-sales-orders' : 'pending-purchase-orders' })}>Pending {sales ? 'SOs' : 'POs'}</Button>}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod note="Orders dated in the working period (cancelled and binned ones left out)." />
              <OptionsTable area={`order-book-${tab}`} />
              <DrawerSection title="About these figures">
                <p className="text-hint text-muted">
                  Taxable values (GST excluded). Fulfilled = the share of each line drawn on by live {sales ? 'challans or invoices' : 'GRNs or bills'};
                  pending = the rest of an open order; short-closed = what a short-close abandoned. Lead time counts days from the order to its
                  first and its full {sales ? 'delivery (challan, or the invoice when drawn directly)' : 'receipt (GRN, or the bill when drawn directly)'}, and on to
                  the first {sales ? 'invoice' : 'bill'}, counting documents dated up to the period end.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      {tab !== 'lead-time' ? (
        <>
          <StatGrid className="mb-section">
            <StatTile label="Ordered" value={formatPaise(total((r) => r.orderedValue), { symbol: true })} hint={`${rows.length} order${rows.length === 1 ? '' : 's'}`} testId="order-book-ordered" />
            <StatTile label="Fulfilled" value={formatPaise(total((r) => r.fulfilledValue), { symbol: true })} />
            <StatTile label="Pending" value={formatPaise(total((r) => r.pendingValue), { symbol: true })} />
            <StatTile label="Short-closed" value={formatPaise(total((r) => r.shortClosedValue), { symbol: true })} />
          </StatGrid>
          {drill ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <Chip onRemove={() => setDrill(null)} removeLabel="Back to the summary" testId="order-book-drill">{drill.label}</Chip>
                <span className="text-hint text-muted">{drilled.length} orders</span>
              </div>
              <Panel>
                <DataTable
                  key={`${kind}-orders`}
                  viewId={`order-book-orders-${kind}`}
                  testId="order-book-orders"
                  columns={ORDER_COLUMNS[kind]}
                  rows={drilled}
                  rowKey={(r) => r.docId}
                  onRowActivate={(r) => nav.go({ name: 'trade-doc', kind, id: r.docId })}
                  exportOptions={{ title: `${title} — ${drill.label}`, periodLabel, filename: 'order-book-orders' }}
                />
              </Panel>
            </>
          ) : (
            <Panel>
              <DataTable
                key={`${kind}-${tab}`}
                viewId={`order-book-${tab}-${kind}`}
                testId={`order-book-${tab}`}
                ariaLabel={`${title} by ${tab}`}
                columns={tab === 'party' ? PARTY_COLUMNS : MONTH_COLUMNS}
                rows={tab === 'party' ? byParty : byMonth}
                rowKey={(r) => r.key}
                loading={isLoading}
                onRowActivate={(r) => setDrill({ by: tab === 'party' ? 'party' : 'month', key: r.key, label: r.label })}
                empty={{ title: `No ${sales ? 'sales' : 'purchase'} orders in this period` }}
                exportOptions={{ title: `${title} by ${tab} — ${sales ? 'sales' : 'purchase'} orders`, periodLabel, filename: `order-book-${tab}` }}
              />
            </Panel>
          )}
        </>
      ) : (
        <>
          <StatGrid className="mb-section">
            <StatTile label={sales ? 'To first delivery' : 'To first receipt'} value={avg((lead ?? []).map((r) => r.daysToFirstDelivery))} hint="average" testId="lead-time-first" />
            <StatTile label={sales ? 'To full delivery' : 'To full receipt'} value={avg((lead ?? []).map((r) => r.daysToFullDelivery))} hint="average, completed orders" />
            <StatTile label={sales ? 'Delivery → invoice' : 'Receipt → bill'} value={avg((lead ?? []).map((r) => r.daysDeliveryToInvoice))} hint="average" />
            <StatTile label={sales ? 'Order → invoice' : 'Order → bill'} value={avg((lead ?? []).map((r) => r.daysOrderToInvoice))} hint="average" />
          </StatGrid>
          <Panel>
            <DataTable
              key={`${kind}-lead`}
              viewId={`order-lead-time-${kind}`}
              testId="order-lead-time"
              ariaLabel="Fulfilment lead time"
              columns={LEAD_COLUMNS[kind]}
              rows={lead ?? []}
              rowKey={(r) => r.docId}
              loading={leadLoading}
              onRowActivate={(r) => nav.go({ name: 'trade-doc', kind, id: r.docId })}
              empty={{ title: `No ${sales ? 'sales' : 'purchase'} orders in this period` }}
              exportOptions={{ title: `Fulfilment lead time — ${sales ? 'sales' : 'purchase'} orders`, periodLabel, filename: 'fulfilment-lead-time' }}
            />
          </Panel>
        </>
      )}
      <p className="mt-2 text-hint text-muted">Click a row to drill down · F12 for options.</p>
    </Page>
  )
}

// ---------- demand vs stock vs on-order ----------

const DEMAND_COLUMNS = defineColumns<ItemDemandRow>([
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 160, hideable: false, cell: (r) => <ItemLink itemId={r.stockItemId} name={r.itemName} /> },
  { id: 'closing', header: 'In stock', kind: 'quantity', value: (r) => r.closingQtyMilli, decimals: (r) => r.decimals, unit: (r) => r.unit ?? '', width: 110 },
  { id: 'so', header: 'Open SOs', kind: 'quantity', value: (r) => r.openSoMilli, decimals: (r) => r.decimals, width: 100 },
  { id: 'soValue', header: 'SO value', kind: 'money', value: (r) => r.openSoValue, width: 120, defaultHidden: true, aggregate: 'sum' },
  { id: 'po', header: 'Open POs', kind: 'quantity', value: (r) => r.openPoMilli, decimals: (r) => r.decimals, width: 100 },
  { id: 'poValue', header: 'PO value', kind: 'money', value: (r) => r.openPoValue, width: 120, defaultHidden: true, aggregate: 'sum' },
  {
    id: 'net', header: 'Net', kind: 'quantity', value: (r) => r.netMilli, decimals: (r) => r.decimals, width: 100,
    cell: (r) => <span className={`num ${r.netMilli < 0 ? 'text-cr font-medium' : ''}`}>{(r.netMilli / 1000).toLocaleString('en-IN', { maximumFractionDigits: r.decimals })}</span>
  },
  {
    id: 'short', header: 'To order', kind: 'quantity', value: (r) => r.shortMilli || null, decimals: (r) => r.decimals, width: 100,
    cell: (r) => (r.shortMilli > 0 ? <Badge tone="danger">{(r.shortMilli / 1000).toLocaleString('en-IN', { maximumFractionDigits: r.decimals })}</Badge> : <span className="text-muted">—</span>)
  },
  { id: 'reorder', header: 'Reorder level', kind: 'quantity', value: (r) => r.reorderLevelMilli, decimals: (r) => r.decimals, width: 110, defaultHidden: true }
])

export function ItemDemandScreen(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const opts = useScreenOptions('item-demand', { onlyOpen: true })
  const { data, isLoading } = useQuery({
    queryKey: ['tradeItemDemand', to, opts.options.onlyOpen],
    queryFn: () => api.trade.itemDemand(to, opts.options.onlyOpen)
  })
  const rows = data ?? []
  const periodLabel = `as on ${toDisplayDate(to)}`
  const short = rows.filter((r) => r.shortMilli > 0).length
  return (
    <Page width="wide">
      <PageHeader
        title="Demand vs stock"
        period={periodLabel}
        secondary={<Button onClick={() => nav.go({ name: 'pending-sales-orders' })}>Pending SOs</Button>}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod asOn />
              <DrawerSection title="Items">
                <OptionToggle
                  label="Only items on open orders"
                  checked={opts.options.onlyOpen}
                  onChange={(v) => opts.set('onlyOpen', v)}
                  testId="input-item-demand-only-open"
                />
              </DrawerSection>
              <OptionsTable area="item-demand" />
              <DrawerSection title="How it adds up">
                <p className="text-hint text-muted">
                  Net = closing stock − what open sales orders still have to deliver + what open purchase orders still have to receive.
                  A negative net is the quantity still to order. Goods already on a challan have left stock and no longer count against
                  their order; goods on a GRN are in stock.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <StatGrid className="mb-section">
        <StatTile label="Items" value={String(rows.length)} hint={opts.options.onlyOpen ? 'on open orders' : 'all items'} />
        <StatTile label="Short" value={String(short)} hint="demand above stock + on order" testId="item-demand-short" />
        <StatTile label="Open SO value" value={formatPaise(rows.reduce((s, r) => s + r.openSoValue, 0), { symbol: true })} />
        <StatTile label="Open PO value" value={formatPaise(rows.reduce((s, r) => s + r.openPoValue, 0), { symbol: true })} />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="item-demand"
          testId="item-demand"
          ariaLabel="Demand vs stock vs on order"
          columns={DEMAND_COLUMNS}
          rows={rows}
          rowKey={(r) => r.stockItemId}
          rowAttrs={(r) => ({ 'data-item-id': r.stockItemId, 'data-short': r.shortMilli > 0 ? 'true' : undefined })}
          loading={isLoading}
          onRowActivate={(r) => nav.go({ name: 'stock-movements', itemId: r.stockItemId })}
          empty={{ title: 'No open orders', hint: 'Items on open sales or purchase orders show here.' }}
          exportOptions={{ title: 'Demand vs stock', periodLabel, filename: 'demand-vs-stock' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Click an item for its movements · F12 for options.</p>
    </Page>
  )
}
