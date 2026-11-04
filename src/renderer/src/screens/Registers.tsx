import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, Money, Page, PageHeader, Panel } from '../components/ui'
import { OptionChoice, OptionsExport, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { AllEntriesPanel, ENTRIES_SCOPE_LABELS, type EntriesScope } from './registers/AllEntries'
import { TabBar } from '../components/TabBar'
import { DataTable, defineColumns } from '../components/table'
import { formatMilli } from '../lib/table'
import { toDisplayDate } from '@shared/dates'
import type { ItemProfitRow, RegisterMonthRow } from '@shared/reports'
import { ItemLink } from '../components/links'
import { CAPABILITY_REFUSED_TEXT, useCapabilityRefused } from '../lib/capabilities'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[m - 1]} ${y}`
}

export const REGISTER_COLUMNS = defineColumns<RegisterMonthRow>([
  // 'YYYY-MM' sorts chronologically as text; shown as "Apr 2026".
  {
    id: 'month',
    header: 'Month',
    kind: 'text',
    value: (r) => r.month,
    text: (r) => monthLabel(r.month),
    hideable: false,
    groupable: false,
    className: 'text-blue'
  },
  { id: 'vouchers', header: 'Vouchers', kind: 'number', value: (r) => r.vouchers, aggregate: 'sum', width: 130 },
  { id: 'taxable', header: 'Taxable value', kind: 'money', value: (r) => r.taxable, aggregate: 'sum', width: 160 },
  { id: 'tax', header: 'GST', kind: 'money', value: (r) => r.tax, aggregate: 'sum', width: 150 },
  { id: 'total', header: 'Invoice total', kind: 'money', value: (r) => r.total, aggregate: 'sum', width: 160 }
])

/** "12.3%", or "—" when there were no sales to divide by. Display only — never feeds an amount. */
function marginOf(profit: number, sales: number): string {
  return sales !== 0 ? `${((profit / sales) * 100).toFixed(1)}%` : '—'
}

export const ITEM_PROFIT_COLUMNS = defineColumns<ItemProfitRow>([
  {
    id: 'name',
    header: 'Item',
    kind: 'text',
    value: (r) => r.name,
    hideable: false,
    groupable: false,
    minWidth: 160,
    cell: (r) => <ItemLink itemId={r.stockItemId} name={r.name} />
  },
  {
    id: 'qty',
    header: 'Qty sold',
    kind: 'quantity',
    value: (r) => r.outQtyMilli,
    // Each item has its own unit and decimals — mixed units never total.
    text: (r) => `${formatMilli(r.outQtyMilli, r.decimals)} ${r.unitSymbol}`,
    width: 130
  },
  { id: 'unit', header: 'Unit', kind: 'text', value: (r) => r.unitSymbol, className: 'text-muted', width: 80, defaultHidden: true },
  { id: 'sales', header: 'Sales', kind: 'money', value: (r) => r.salesValue, aggregate: 'sum', width: 150 },
  { id: 'cogs', header: 'COGS', kind: 'money', value: (r) => r.cogs, aggregate: 'sum', width: 150 },
  {
    id: 'profit',
    header: 'Profit',
    kind: 'money',
    value: (r) => r.profit,
    aggregate: 'sum',
    width: 150,
    cell: (r) => (
      <span className={r.profit < 0 ? 'text-cr' : ''}>
        <Money paise={r.profit} />
      </span>
    )
  },
  {
    id: 'margin',
    header: 'Margin',
    kind: 'number',
    // Sorted/filtered as a percentage; rows without sales have no margin (blank, sorts last).
    value: (r) => (r.salesValue !== 0 ? (r.profit / r.salesValue) * 100 : null),
    text: (r) => marginOf(r.profit, r.salesValue),
    className: 'text-muted',
    width: 120,
    // The footer margin is profit over sales of the rows in scope, not a sum of percentages.
    aggregate: (rows) =>
      marginOf(
        rows.reduce((s, r) => s + r.profit, 0),
        rows.reduce((s, r) => s + r.salesValue, 0)
      )
  }
])

/** `entries` = All entries: every voucher of every type in the period (the feature cleanup moved
 *  the Day book's list here; links that opened the Day book open this tab with the same range). */
export type RegistersTab = 'sales' | 'purchase' | 'items' | 'entries'
type Tab = RegistersTab

const TAB_ORDER: readonly Tab[] = ['entries', 'sales', 'purchase', 'items']
const TAB_LABELS: Record<Tab, string> = { entries: 'All entries', sales: 'Sales', purchase: 'Purchase', items: 'Item profit' }

/** The first and last day of `month` ('YYYY-MM') inside [from, to]. */
export function monthWithin(month: string, from: string, to: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const start = `${month}-01`
  const end = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
  return { from: start < from ? from : start, to: end > to ? to : end }
}

export function RegistersScreen({ tab: requestedTab, from: askedFrom, to: askedTo, kind: askedKind, voucherIds, source }: {
  tab?: Tab
  from?: string
  to?: string
  /** All entries: only this voucher kind (a register month's drill). */
  kind?: string
  /** All entries: only these vouchers (a cash-flow line's), with where they came from. */
  voucherIds?: number[]
  source?: string
} = {}): React.JSX.Element {
  const { from: sessionFrom, to: sessionTo } = useSession()
  // A simple "Why?" link may ask for one month (Reports → by month); absent = the session period,
  // as before. Changing the period in the options afterwards goes back to the session period.
  const [asked, setAsked] = useState(askedFrom && askedTo ? { from: askedFrom, to: askedTo } : null)
  const seen = useRef({ sessionFrom, sessionTo })
  useEffect(() => {
    if (seen.current.sessionFrom === sessionFrom && seen.current.sessionTo === sessionTo) return
    seen.current = { sessionFrom, sessionTo }
    setAsked(null)
  }, [sessionFrom, sessionTo])
  const from = asked?.from ?? sessionFrom
  const to = asked?.to ?? sessionTo
  const toast = useToasts()
  // The last register viewed is remembered per company (screen option); tabs stay in the header.
  // WP 8.1: a link may ask for a tab ("Purchase list" → purchase); it becomes the remembered one.
  const opts = useScreenOptions('registers', { tab: 'sales' as Tab, scope: 'books' as EntriesScope }, { tab: [...TAB_ORDER], scope: ENTRIES_SCOPE_LABELS.map((s) => s.value) })
  // A link to All entries (a month, today's entries, a cash-flow line …) shows it for this visit
  // only — it never becomes the remembered register, so Back / the sidebar return to the register
  // that was open. Choosing the tab yourself does remember it.
  const [pending, setPending] = useState(requestedTab && requestedTab !== 'entries' ? requestedTab : null)
  const [visit, setVisit] = useState<Tab | null>(requestedTab === 'entries' ? 'entries' : null)
  const tab = visit ?? pending ?? opts.options.tab
  useEffect(() => {
    if (pending === null) return
    if (opts.options.tab !== pending) opts.set('tab', pending)
    setPending(null)
  }, [pending, opts])
  const setTab = (t: Tab): void => {
    setVisit(null)
    opts.set('tab', t)
  }
  const [busy, setBusy] = useState<'caPack' | 'tallyXml' | null>(null)
  const exportRefused = useCapabilityRefused('canExport')
  const kind = tab === 'items' || tab === 'entries' ? 'sales' : tab

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`

  const runExport = async (which: 'caPack' | 'tallyXml'): Promise<void> => {
    setBusy(which)
    try {
      const r = which === 'caPack' ? await api.exporter.caPack(from, to) : await api.exporter.tallyXml(from, to)
      if (!('cancelled' in r && r.cancelled)) toast.push('success', `Saved to ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const title = tab === 'entries' ? 'All entries' : tab === 'items' ? 'Item profitability' : tab === 'sales' ? 'Sales register' : 'Purchase register'

  return (
    <Page width={tab === 'entries' ? 'wide' : undefined}>
      <PageHeader
        title={title}
        period={periodLabel}
        tabs={
          <TabBar
            screen="registers"
            tabs={TAB_ORDER.map((k) => ({ id: k, label: TAB_LABELS[k] }))}
            active={tab}
            onSelect={setTab}
          />
        }
        secondary={
          <Button disabled={busy !== null || exportRefused} disabledTitle={exportRefused ? CAPABILITY_REFUSED_TEXT.canExport : undefined} loading={busy === 'tallyXml'} onClick={() => void runExport('tallyXml')}>
            Tally XML
          </Button>
        }
        actions={
          <Button
            variant="primary"
            data-testid="btn-registers-ca-pack"
            disabled={busy !== null || exportRefused}
            disabledTitle={exportRefused ? CAPABILITY_REFUSED_TEXT.canExport : undefined}
            loading={busy === 'caPack'}
            onClick={() => void runExport('caPack')}
          >
            CA pack…
          </Button>
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod />
              {tab === 'entries' && (
                <OptionChoice
                  label="Show"
                  value={opts.options.scope}
                  options={ENTRIES_SCOPE_LABELS}
                  onChange={(v) => opts.set('scope', v)}
                  testId="input-entries-scope"
                />
              )}
              <OptionsTable area={tab === 'items' ? 'registers-items' : tab === 'entries' ? 'registers-entries' : 'registers'} />
              <OptionsExport>
                <Button size="sm" disabled={busy !== null} onClick={() => void runExport('tallyXml')}>
                  Tally XML for the period
                </Button>
                <Button size="sm" disabled={busy !== null} onClick={() => void runExport('caPack')}>
                  CA pack…
                </Button>
              </OptionsExport>
            </>
          )
        }}
      />
      {tab === 'entries' ? (
        <AllEntriesPanel
          from={from}
          to={to}
          periodLabel={periodLabel}
          scope={opts.options.scope}
          onScope={(s) => opts.set('scope', s)}
          kind={askedKind}
          voucherIds={voucherIds}
          source={source}
        />
      ) : tab === 'items' ? (
        <ItemProfitPanel from={from} to={to} periodLabel={periodLabel} />
      ) : (
        <MonthRegister key={kind} kind={kind} from={from} to={to} title={title} periodLabel={periodLabel} />
      )}
    </Page>
  )
}

function MonthRegister({
  kind,
  from,
  to,
  title,
  periodLabel
}: {
  kind: 'sales' | 'purchase'
  from: string
  to: string
  title: string
  periodLabel: string
}): React.JSX.Element {
  const nav = useNav()
  const { data, isLoading } = useQuery({
    queryKey: ['register', kind, from, to],
    queryFn: () => api.analysis.register(kind, from, to)
  })
  return (
    <>
      <Panel>
        <DataTable
          viewId="registers-month"
          testId="registers"
          ariaLabel={title}
          columns={REGISTER_COLUMNS}
          rows={data ?? []}
          rowKey={(r) => r.month}
          rowAttrs={(r) => ({ 'data-row-id': r.month, title: 'Open this month’s entries' })}
          loading={isLoading}
          empty={{ title: `No ${kind} vouchers in this period` }}
          onRowActivate={(r) => nav.go({ name: 'registers', tab: 'entries', ...monthWithin(r.month, from, to), kind })}
          maxHeight="70vh"
          exportOptions={{ title, periodLabel, filename: `${kind}-register` }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Click a month to open its vouchers in All entries.</p>
    </>
  )
}

/** Item profitability (v0.3 R3): per-item qty sold, sales value, engine-valued COGS and margin. */
function ItemProfitPanel({ from, to, periodLabel }: { from: string; to: string; periodLabel: string }): React.JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['register', 'item-profit', from, to],
    queryFn: () => api.reports.itemProfitability(from, to)
  })

  return (
    <>
      <Panel>
        <DataTable
          viewId="registers-item-profit"
          testId="registers-items"
          ariaLabel="Item profitability"
          columns={ITEM_PROFIT_COLUMNS}
          rows={data ?? []}
          rowKey={(r) => r.stockItemId}
          rowAttrs={(r) => ({ 'data-row-id': r.stockItemId })}
          loading={isLoading}
          empty={{ title: 'No item sales in this period' }}
          maxHeight="70vh"
          exportOptions={{ title: 'Item profitability', periodLabel, filename: 'item-profitability' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">
        COGS is valued by each item&apos;s valuation method (FIFO / weighted average) over the period&apos;s movements.
      </p>
    </>
  )
}
