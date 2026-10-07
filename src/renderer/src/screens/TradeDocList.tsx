// Quotations / Sales orders / Purchase orders (WP 2.5c, design §5.2 "Lists"): one DataTable
// keyed by kind — number, date, party, value, pending value, % fulfilled and the DERIVED status
// (never stored: fulfilment.ts docStatus from the live links). Row menu: open, convert, print,
// duplicate, close, cancel, reopen, bin / restore. The period is the shared working period.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TradeDocKind } from '@shared/domain'
import type { TradeDocListRow } from '@shared/tradeCycle/types'
import { TRADE_DOC_TITLES, tradeStatusLabel } from '@shared/tradeCycle/edit'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { api } from '../lib/client'
import { useCanEditMasters } from '../lib/drill'
import { useNav, useSession } from '../state/stores'
import { Button, Checkbox, DrawerSection, Kbd, Page, PageHeader, Panel } from '../components/ui'
import { MenuButton } from '../components/kit/Menu'
import { OptionsPeriod, OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink, TradeDocLink } from '../components/links'
import { TradeStatusBadge, useTradeDocActions } from './trade/tradeDocShared'

const STATUSES = ['open', 'partly_fulfilled', 'fulfilled', 'expired', 'closed', 'cancelled'] as const

const PLURAL: Record<TradeDocKind, string> = { quotation: 'Quotations', sales_order: 'Sales orders', purchase_order: 'Purchase orders' }

function columnsFor(kind: TradeDocKind) {
  const sales = kind !== 'purchase_order'
  return defineColumns<TradeDocListRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
    {
      id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, width: 104, hideable: false,
      cell: (r) => <TradeDocLink tradeDocId={r.id} kind={r.kind} label={<span className="num">{r.number}</span>} />
    },
    {
      id: 'party', header: sales ? 'Customer' : 'Supplier', kind: 'text', value: (r) => r.partyName, minWidth: 160,
      cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} />
    },
    { id: 'reference', header: sales ? 'Customer ref.' : 'Supplier ref.', kind: 'text', value: (r) => r.reference ?? '', width: 120, defaultHidden: kind === 'quotation' },
    kind === 'quotation'
      ? { id: 'validUntil', header: 'Valid until', kind: 'date', value: (r) => r.validUntil ?? '' }
      : { id: 'dueDate', header: 'Expected', kind: 'date', value: (r) => r.dueDate ?? '' },
    { id: 'lines', header: 'Lines', kind: 'number', value: (r) => r.lineCount, width: 64, defaultHidden: true },
    // Value and pending value are both taxable (before GST), so they compare; the GST-inclusive
    // document total is one column away.
    { id: 'taxable', header: 'Value', kind: 'money', value: (r) => r.taxable, width: 130, aggregate: 'sum' },
    { id: 'total', header: 'With GST', kind: 'money', value: (r) => r.total, width: 130, defaultHidden: true, aggregate: 'sum' },
    { id: 'pending', header: kind === 'quotation' ? 'Not converted' : 'Pending value', kind: 'money', value: (r) => r.pendingValue, width: 130, aggregate: 'sum' },
    {
      id: 'fulfilled', header: kind === 'quotation' ? 'Converted' : 'Fulfilled', kind: 'number', value: (r) => r.fulfilledPct, width: 96,
      text: (r) => `${r.fulfilledPct}%`,
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="relative inline-block h-1.5 w-10 overflow-hidden rounded bg-panel2" aria-hidden>
            <span className="absolute inset-y-0 left-0 bg-success" style={{ width: `${Math.min(100, r.fulfilledPct)}%` }} />
          </span>
          <span className="num">{r.fulfilledPct}%</span>
        </span>
      )
    },
    {
      id: 'status', header: 'Status', kind: 'enum', value: (r) => (r.binned ? 'binned' : r.status), width: 130,
      options: [...STATUSES.map((s) => ({ value: s, label: tradeStatusLabel(kind, s) })), { value: 'binned', label: 'In the bin' }],
      text: (r) => (r.binned ? 'In the bin' : tradeStatusLabel(kind, r.status)),
      cell: (r) => <TradeStatusBadge kind={r.kind} status={r.status} binned={r.binned} />
    },
    {
      id: 'downstream', header: kind === 'quotation' ? 'Converted to' : 'Drawn by', kind: 'text', value: (r) => r.downstreamLabels.join(', '),
      minWidth: 140, defaultHidden: true
    },
    { id: 'reason', header: 'Close reason', kind: 'text', value: (r) => r.closeReason ?? '', defaultHidden: true }
  ])
}

const COLUMNS: Record<TradeDocKind, ReturnType<typeof columnsFor>> = {
  quotation: columnsFor('quotation'),
  sales_order: columnsFor('sales_order'),
  purchase_order: columnsFor('purchase_order')
}

export function TradeDocListScreen({ kind }: { kind: TradeDocKind }): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const canWrite = useCanEditMasters()
  const [showBinned, setShowBinned] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['tradeDocs', kind, from, to, showBinned],
    queryFn: () => api.tradeDocs.list({ kind, from, to, includeBinned: showBinned })
  })
  const rows = data ?? []
  const actions = useTradeDocActions()
  const title = PLURAL[kind]
  const one = TRADE_DOC_TITLES[kind].toLowerCase()
  const periodLabel = `${toDisplayDate(from)} to ${toDisplayDate(to)}`
  const openValue = useMemo(() => rows.filter((r) => !r.binned).reduce((s, r) => s + r.pendingValue, 0), [rows])

  return (
    <Page width="wide">
      <PageHeader
        title={title}
        period={periodLabel}
        actions={
          canWrite ? (
            <Button variant="primary" data-testid="btn-trade-doc-new" onClick={() => nav.go({ name: 'trade-doc', kind })}>
              New {one}
            </Button>
          ) : undefined
        }
        options={{
          content: (
            <>
              <OptionsPeriod />
              <OptionsTable area={`trade-docs-${kind}`} />
              <DrawerSection title="About statuses">
                <p className="text-hint text-muted">
                  The status is worked out from the documents drawn from each {one} — never typed.{' '}
                  {kind === 'quotation'
                    ? 'Converted once sales orders or invoices take every line; expired once past its validity with nothing converted.'
                    : kind === 'sales_order'
                      ? 'Delivered once challans or invoices take every line.'
                      : 'Received once GRNs or bills take every line.'}{' '}
                  Closed and cancelled are the only states set by hand; binned or cancelled documents never count.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <Panel>
        <DataTable
          key={kind}
          viewId={`trade-docs-${kind}`}
          testId={`trade-docs-${kind}`}
          ariaLabel={title}
          columns={COLUMNS[kind]}
          rows={rows}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-row-id': r.id, 'data-status': r.binned ? 'binned' : r.status })}
          loading={isLoading}
          onRowActivate={(r) => nav.go({ name: 'trade-doc', kind, id: r.id })}
          trailingWidth={60}
          trailing={(r) => (
            <MenuButton
              label={`Actions for ${r.number}`}
              testId={`trade-doc-actions-${r.id}`}
              className="px-1.5 text-muted hover:text-ink"
              items={actions.menu({ id: r.id, kind: r.kind, number: r.number, partyLedgerId: r.partyLedgerId, status: r.status, binned: r.binned }, { canWrite })}
            >
              ⋯
            </MenuButton>
          )}
          toolbarStart={
            <Checkbox label="Show the bin" checked={showBinned} onChange={setShowBinned} testId="input-trade-docs-binned" />
          }
          empty={{
            title: `No ${title.toLowerCase()} in this period`,
            hint: canWrite ? `Start one with “New ${one}”.` : undefined
          }}
          exportOptions={{ title, periodLabel, filename: title.toLowerCase().replace(/ /g, '-') }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">
        {kind === 'quotation' ? 'Not yet converted' : 'Open'} (taxable) <span className="num">{formatPaise(openValue, { symbol: true })}</span> · click a row to open it ·{' '}
        <Kbd>⋯</Kbd> for convert, close and print · F12 for options.
      </p>
    </Page>
  )
}
