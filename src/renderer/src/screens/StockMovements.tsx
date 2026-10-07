// Item movement register (WP 2.3): one stock item's inward/outward lines over the working period
// with running quantity and value — read off the valuation pass server-side (stock:movements),
// never re-costed here. Opened from the sidebar, Stock summary's item breakdown, or an item's
// edit window; the item and godown live in the screen params so drill-backs restore them.
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { StockMovementRegister, StockMovementRow } from '@shared/stockPlanning'
import { toDisplayDate } from '@shared/dates'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Banner, Chip, DrawerSection, EmptyState, Page, PageHeader, Panel, Select, StatGrid, StatTile } from '../components/ui'
import { OptionToggle, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { formatMilli } from '../lib/table'
import { formatPaise } from '@shared/money'
import { ItemPicker } from '../components/pickers'
import { useGodowns } from '../components/stockPickers'
import { VoucherLink, LedgerLink } from '../components/links'
import { openVoucher } from '../lib/drill'
import { useFeatures } from '../lib/useFeatures'

type Reg = StockMovementRegister

function columnsFor(reg: Reg | undefined) {
  const decimals = reg?.item.decimals ?? 3
  const unit = reg?.item.unitSymbol ?? ''
  const qty = { decimals, unit, aggregateDecimals: decimals }
  // Sized to fit a 1440-wide window without scrolling: type + number share the Voucher column,
  // and Batch / Serials / Type start hidden (the column chooser and exports have them).
  return defineColumns<StockMovementRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, width: 104 },
    {
      id: 'voucher',
      header: 'Voucher',
      kind: 'text',
      value: (r) => `${r.voucherType} ${r.number}`,
      width: 168,
      groupable: false,
      cell: (r) => (
        <VoucherLink
          voucherId={r.voucherId}
          label={
            <>
              {r.voucherType}
              {r.isAbsolute ? ' (count)' : ''} <span className="num">{r.number}</span>
            </>
          }
        />
      )
    },
    { id: 'type', header: 'Type', kind: 'text', value: (r) => r.voucherType, width: 120, defaultHidden: true },
    {
      id: 'particulars',
      header: 'Party / narration',
      kind: 'text',
      value: (r) => r.particulars,
      minWidth: 140,
      groupable: false,
      cell: (r) =>
        r.partyLedgerId ? (
          <LedgerLink ledgerId={r.partyLedgerId} name={r.particulars} />
        ) : (
          <span className="text-muted">{r.particulars}</span>
        )
    },
    { id: 'godown', header: 'Godown', kind: 'text', value: (r) => r.godownName ?? '', width: 112 },
    {
      id: 'batch',
      header: 'Batch',
      kind: 'text',
      value: (r) => r.batchName ?? '',
      width: 120,
      defaultHidden: true,
      text: (r) => (r.batchName ? `${r.batchName}${r.expiryDate ? ` (exp ${toDisplayDate(r.expiryDate)})` : ''}` : '')
    },
    {
      id: 'serials',
      header: 'Serials',
      kind: 'text',
      value: (r) => r.serials.join(', '),
      width: 140,
      defaultHidden: true,
      groupable: false
    },
    { id: 'inward', header: 'Inward', kind: 'quantity', value: (r) => r.inwardQtyMilli || null, ...qty, aggregate: 'sum', width: 96 },
    { id: 'outward', header: 'Outward', kind: 'quantity', value: (r) => r.outwardQtyMilli || null, ...qty, aggregate: 'sum', width: 96 },
    { id: 'rate', header: 'Rate', kind: 'money', value: (r) => (r.isAbsolute ? null : r.ratePaise), width: 104 },
    { id: 'value', header: 'Value', kind: 'money', value: (r) => r.value, width: 120 },
    { id: 'runningQty', header: 'Running qty', kind: 'quantity', value: (r) => r.runningQtyMilli, decimals, unit, width: 116 },
    { id: 'runningValue', header: 'Running value', kind: 'money', value: (r) => r.runningValue, width: 128 }
  ])
}

export function StockMovementsScreen({ itemId, godownId }: { itemId?: number; godownId?: number }): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const features = useFeatures()
  const godowns = useGodowns()
  const opts = useScreenOptions('stock-movements', { showZeroValue: true })
  const { data: reg, isLoading, error } = useQuery({
    queryKey: ['stockMovements', itemId ?? null, from, to, godownId ?? null],
    queryFn: () => api.stock.movements({ itemId: itemId!, from, to, godownId }),
    enabled: itemId != null
  })
  const columns = useMemo(() => columnsFor(reg), [reg])
  const rows = (reg?.rows ?? []).filter((r) => opts.options.showZeroValue || r.value !== 0)
  const setParams = (next: { itemId?: number; godownId?: number }): void =>
    nav.replace({ name: 'stock-movements', itemId: next.itemId, godownId: next.godownId })
  const godownName = godownId != null ? (godowns.find((g) => g.id === godownId)?.name ?? `#${godownId}`) : null
  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const fmtQty = (milli: number): string => (reg ? `${formatMilli(milli, reg.item.decimals)} ${reg.item.unitSymbol}` : '')

  return (
    <Page width="full">
      <PageHeader
        title="Stock movements"
        period={periodLabel}
        controls={
          <div className="flex items-center gap-2">
            <ItemPicker value={itemId ?? null} onPick={(id) => id != null && setParams({ itemId: id, godownId })} className="w-64" testId="picker-movements-item" />
            {godownName && (
              <Chip onRemove={() => setParams({ itemId })} removeLabel="Show all godowns" testId="chip-movements-godown">
                {godownName}
              </Chip>
            )}
          </div>
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod />
              <DrawerSection title="Filter">
                <label className="flex flex-col gap-1">
                  <span className="text-detail text-ink">Godown</span>
                  <Select
                    value={godownId ?? ''}
                    data-testid="input-movements-godown"
                    onChange={(e) => setParams({ itemId, godownId: e.target.value ? Number(e.target.value) : undefined })}
                  >
                    <option value="">All godowns (company-wide)</option>
                    {godowns.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </Select>
                  <span className="text-hint text-muted">
                    One godown: its own movements only, valued at the cost the company-wide pass booked (openings aren&apos;t godown-wise).
                  </span>
                </label>
                <OptionToggle
                  label="Show zero-value lines"
                  hint="Lines that moved no value (e.g. a count that matched the books)."
                  checked={opts.options.showZeroValue}
                  onChange={(v) => opts.set('showZeroValue', v)}
                  testId="input-movements-zero"
                />
              </DrawerSection>
              <OptionsTable area="stock-movements" />
            </>
          )
        }}
      />
      {!features.inventory && <Banner tone="info" className="mb-section">Inventory is turned off for this company.</Banner>}
      {itemId == null ? (
        <Panel>
          <EmptyState title="Pick a stock item" hint="Its movements over the working period appear here, with running quantity and value." />
        </Panel>
      ) : error ? (
        <Banner tone="danger">{(error as Error).message}</Banner>
      ) : (
        <>
          <StatGrid className="mb-section">
            <StatTile label="Opening" value={reg ? fmtQty(reg.opening.qtyMilli) : '–'} footer={reg ? formatPaise(reg.opening.value, { symbol: true }) : undefined} loading={isLoading} testId="movements-opening" />
            <StatTile label="Inward" value={reg ? fmtQty(reg.totals.inwardQtyMilli) : '–'} footer={reg ? formatPaise(reg.totals.inwardValue, { symbol: true }) : undefined} loading={isLoading} tone="dr" testId="movements-inward" />
            <StatTile label="Outward" value={reg ? fmtQty(reg.totals.outwardQtyMilli) : '–'} footer={reg ? formatPaise(reg.totals.outwardValue, { symbol: true }) : undefined} loading={isLoading} tone="cr" testId="movements-outward" />
            <StatTile
              label="Closing"
              value={reg ? fmtQty(reg.closing.qtyMilli) : '–'}
              footer={reg ? `${formatPaise(reg.closing.value, { symbol: true })} · ${reg.item.valuationMethod === 'fifo' ? 'FIFO' : 'weighted average'}` : undefined}
              loading={isLoading}
              tone="amber"
              testId="movements-closing"
            />
          </StatGrid>
          <Panel>
            <DataTable
              viewId="stock-movements"
              testId="stock-movements"
              ariaLabel="Stock movements"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.lineId}
              rowAttrs={(r) => ({ 'data-row-id': r.lineId, 'data-voucher-id': r.voucherId })}
              rowClassName={(r) => (r.runningQtyMilli < 0 ? 'text-cr' : '')}
              loading={isLoading}
              onRowActivate={(r) => openVoucher(r.voucherId)}
              empty={{ title: 'No movements in this period', hint: 'Change the working period, or the godown filter.' }}
              maxHeight="calc(100vh - 330px)"
              toolbarFeatures={{ groupBy: false }}
              exportOptions={{
                title: `Stock movements — ${reg?.item.name ?? ''}${godownName ? ` (${godownName})` : ''}`,
                periodLabel,
                filename: `stock-movements-${(reg?.item.name ?? 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
              }}
            />
          </Panel>
        </>
      )}
    </Page>
  )
}
