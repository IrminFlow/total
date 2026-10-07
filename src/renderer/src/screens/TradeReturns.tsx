// Returns (WP 2.5d): the returns register — every credit / debit note line and rejection-note line
// in the period with what it returns, the party, the item and the reason (the voucher's narration)
// — and the returns rate by item and by party (returned ÷ sold). Sales or purchase side from the
// header. Each row drills to its documents; the register's rows open the linked-documents chain.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { ReturnRateRow, ReturnRow, ReturnSide } from '@shared/tradeCycle/types'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Badge, DrawerSection, Page, PageHeader, Panel, Segmented, StatGrid, StatTile } from '../components/ui'
import { OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { ItemLink, LedgerLink, VoucherLink } from '../components/links'
import { openLinkedDocs } from '../components/LinkedDocs'
import { TabBar } from '../components/TabBar'

export type ReturnsTab = 'register' | 'item' | 'party'

const SIDES = [
  { value: 'sales' as const, label: 'Sales returns' },
  { value: 'purchase' as const, label: 'Purchase returns' }
]

const KIND_LABEL: Record<string, string> = {
  credit_note: 'Credit note', debit_note: 'Debit note', receipt_note: 'Rejection in (GRN)', delivery_note: 'Rejection out (challan)'
}

const REGISTER_COLUMNS = defineColumns<ReturnRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  {
    id: 'number', header: 'Return', kind: 'text', value: (r) => `${r.typeName} ${r.number}`, minWidth: 120, hideable: false,
    cell: (r) => <VoucherLink voucherId={r.voucherId} label={`${r.typeName} ${r.number}`} />
  },
  { id: 'kind', header: 'Kind', kind: 'text', value: (r) => KIND_LABEL[r.kind] ?? r.kind, width: 150, defaultHidden: true },
  {
    id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName ?? '', minWidth: 140,
    cell: (r) => (r.partyLedgerId ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName ?? ''} /> : <>{r.partyName}</>)
  },
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 120, cell: (r) => <ItemLink itemId={r.stockItemId} name={r.itemName} /> },
  { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => r.qtyMilli, decimals: (r) => r.decimals, unit: (r) => r.unit ?? '', width: 96, aggregate: 'sum' },
  { id: 'amount', header: 'Value', kind: 'money', value: (r) => r.amount, width: 120, aggregate: 'sum' },
  {
    id: 'against', header: 'Against', kind: 'text', value: (r) => r.againstLabel ?? '', minWidth: 120,
    cell: (r) => (r.againstVoucherId ? <VoucherLink voucherId={r.againstVoucherId} label={r.againstLabel ?? ''} /> : <Badge tone="neutral">Not linked</Badge>)
  },
  { id: 'againstDate', header: 'Source date', kind: 'date', value: (r) => r.againstDate ?? '', defaultHidden: true },
  { id: 'days', header: 'Days after', kind: 'number', value: (r) => r.daysAfter, text: (r) => (r.daysAfter == null ? '' : `${r.daysAfter} d`), width: 92 },
  { id: 'reason', header: 'Reason (narration)', kind: 'text', value: (r) => r.reason ?? '', minWidth: 160 }
])

const pct = (p: number | null): string => (p == null ? '—' : `${p} %`)

function rateColumns(by: 'item' | 'party', side: ReturnSide) {
  const sold = side === 'sales' ? 'Sold' : 'Bought'
  return defineColumns<ReturnRateRow>([
    by === 'item'
      ? { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName ?? '', minWidth: 160, hideable: false, cell: (r) => <ItemLink itemId={r.stockItemId!} name={r.itemName ?? ''} /> }
      : {
          id: 'party', header: side === 'sales' ? 'Customer' : 'Supplier', kind: 'text', value: (r) => r.partyName ?? '', minWidth: 160, hideable: false,
          cell: (r) => (r.partyLedgerId ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName ?? ''} /> : <>{r.partyName ?? '—'}</>)
        },
    { id: 'soldQty', header: `${sold} qty`, kind: 'quantity', value: (r) => r.soldQtyMilli, decimals: (r) => r.decimals, width: 110, ...(by === 'party' ? { defaultHidden: true } : {}) },
    { id: 'retQty', header: 'Returned qty', kind: 'quantity', value: (r) => r.returnedQtyMilli, decimals: (r) => r.decimals, width: 110, ...(by === 'party' ? { defaultHidden: true } : {}) },
    { id: 'qtyPct', header: 'Qty rate', kind: 'number', value: (r) => r.qtyRatePct, text: (r) => pct(r.qtyRatePct), width: 90, ...(by === 'party' ? { defaultHidden: true } : {}) },
    { id: 'sold', header: `${sold} value`, kind: 'money', value: (r) => r.soldValue, width: 130, aggregate: 'sum' },
    { id: 'returned', header: 'Returned value', kind: 'money', value: (r) => r.returnedValue, width: 130, aggregate: 'sum' },
    {
      id: 'valuePct', header: 'Value rate', kind: 'number', value: (r) => r.valueRatePct, text: (r) => pct(r.valueRatePct), width: 96,
      cell: (r) => <span className={`num ${r.valueRatePct != null && r.valueRatePct >= 10 ? 'font-medium text-cr' : ''}`}>{pct(r.valueRatePct)}</span>
    }
  ])
}
const RATE_COLUMNS = {
  'item-sales': rateColumns('item', 'sales'), 'item-purchase': rateColumns('item', 'purchase'),
  'party-sales': rateColumns('party', 'sales'), 'party-purchase': rateColumns('party', 'purchase')
} as const

export function TradeReturnsScreen({ tab: initialTab = 'register' }: { tab?: ReturnsTab }): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const opts = useScreenOptions('trade-returns', { side: 'sales' as ReturnSide }, { side: ['sales', 'purchase'] })
  const side = opts.options.side
  const [tab, setTab] = useState<ReturnsTab>(initialTab)
  const { data: register, isLoading } = useQuery({
    queryKey: ['tradeReturns', side, from, to],
    queryFn: () => api.trade.returnsRegister(side, from, to),
    enabled: tab === 'register'
  })
  const by = tab === 'party' ? 'party' : 'item'
  const { data: rate, isLoading: rateLoading } = useQuery({
    queryKey: ['tradeReturnsRate', side, from, to, by],
    queryFn: () => api.trade.returnsRate(side, from, to, by),
    enabled: tab !== 'register'
  })
  const periodLabel = `${toDisplayDate(from)} to ${toDisplayDate(to)}`
  const rows = register ?? []
  const linked = rows.filter((r) => r.againstVoucherId != null).length
  const sales = side === 'sales'
  return (
    <Page width="wide">
      <PageHeader
        title="Returns"
        period={periodLabel}
        tabs={
          <TabBar
            screen="trade-returns"
            tabs={[
              { id: 'register', label: 'Register' },
              { id: 'item', label: 'Rate by item' },
              { id: 'party', label: sales ? 'Rate by customer' : 'Rate by supplier' }
            ]}
            active={tab}
            onSelect={setTab}
          />
        }
        controls={<Segmented label="Side" size="sm" options={SIDES} value={side} onChange={(v) => opts.set('side', v)} testId="input-returns-side" />}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod />
              <OptionsTable area={`trade-returns-${tab}`} />
              <DrawerSection title="What counts as a return">
                <p className="text-hint text-muted">
                  {sales
                    ? 'Credit note lines (linked to the invoice line they return, or not), and GRNs bringing goods back against a challan not yet invoiced (rejection in).'
                    : 'Debit note lines (linked to the bill line they return, or not), and challans sending goods back against a GRN not yet billed (rejection out).'}{' '}
                  The reason is the voucher&apos;s narration — the “Against…” picker writes it there. The rate compares what came back in the
                  period with what was {sales ? 'sold (invoice lines)' : 'bought (bill lines)'} in the same period, so a return of an older sale can
                  push a rate above what the period alone suggests. Returns never re-open an order.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      {tab === 'register' ? (
        <>
          <StatGrid className="mb-section">
            <StatTile label="Return lines" value={String(rows.length)} hint={sales ? 'credit notes + rejections in' : 'debit notes + rejections out'} testId="returns-count" />
            <StatTile label="Value" value={formatPaise(rows.reduce((s, r) => s + r.amount, 0), { symbol: true })} hint="taxable" />
            <StatTile label="Linked" value={String(linked)} hint="against a source line" />
            <StatTile label="Not linked" value={String(rows.length - linked)} hint="entered without “Against…”" />
          </StatGrid>
          <Panel>
            <DataTable
              key={`register-${side}`}
              viewId={`trade-returns-register-${side}`}
              testId="returns-register"
              ariaLabel="Returns register"
              columns={REGISTER_COLUMNS}
              rows={rows}
              rowKey={(r) => r.lineUid}
              rowAttrs={(r) => ({ 'data-row-id': r.voucherId, 'data-kind': r.kind })}
              loading={isLoading}
              onRowActivate={(r) => openLinkedDocs({ voucherId: r.voucherId })}
              empty={{ title: 'No returns in this period', hint: sales ? 'Credit note → “Against invoice…” (⌥A).' : 'Debit note → “Against bill…” (⌥A).' }}
              exportOptions={{ title: `Returns register — ${sales ? 'sales' : 'purchase'}`, periodLabel, filename: 'returns-register' }}
            />
          </Panel>
          <p className="mt-2 text-hint text-muted">Click a row for its linked documents · group by party, item or reason from the toolbar.</p>
        </>
      ) : (
        <Panel>
          <DataTable
            key={`${tab}-${side}`}
            viewId={`trade-returns-${tab}-${side}`}
            testId={`returns-rate-${tab}`}
            ariaLabel="Returns rate"
            columns={RATE_COLUMNS[`${by}-${side}`]}
            rows={rate ?? []}
            rowKey={(r) => r.key}
            loading={rateLoading}
            onRowActivate={(r) => {
              if (r.stockItemId) nav.go({ name: 'stock-movements', itemId: r.stockItemId })
              else setTab('register')
            }}
            empty={{ title: `Nothing ${sales ? 'sold or returned' : 'bought or returned'} in this period` }}
            exportOptions={{ title: `Returns rate by ${by} — ${sales ? 'sales' : 'purchase'}`, periodLabel, filename: `returns-rate-${by}` }}
          />
        </Panel>
      )}
    </Page>
  )
}
