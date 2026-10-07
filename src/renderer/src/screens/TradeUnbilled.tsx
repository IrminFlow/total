// Goods not invoiced (WP 2.5d, design §9 Q5) and stale documents.
//
// Unbilled goods: GDNI — supply / on-approval challans not yet invoiced — and GRNI — purchase GRNs
// not yet billed — as on the period end, in total and per party. The same figures the pending
// reports add up to, and the ones the year-end close warns about (no journal is posted for them).
//
// Stale documents: quotations past their validity, orders past their expected date (or old with
// none), challans / GRNs pending too long. Stale quotations can be closed in bulk; any row can be
// closed (short-closed) from its ⋯ menu.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { StaleDocRow, StaleReason, UnbilledPartyRow } from '@shared/tradeCycle/types'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Badge, Button, DrawerSection, Field, Page, PageHeader, Panel, StatGrid, StatTile, TextInput } from '../components/ui'
import { OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { DocLink, LedgerLink } from '../components/links'
import { chainStatusLabel, openLinkedDocs } from '../components/LinkedDocs'
import { MenuButton } from '../components/kit/Menu'
import { promptDialog } from '../lib/dialogs'
import { useCanEditMasters } from '../lib/drill'

// ---------- GRNI / GDNI ----------

const SIDE_LABEL = { gdni: 'Delivered, not invoiced (GDNI)', grni: 'Received, not billed (GRNI)' } as const

const UNBILLED_COLUMNS = defineColumns<UnbilledPartyRow>([
  {
    id: 'side', header: 'Side', kind: 'enum', value: (r) => r.side, width: 230, defaultHidden: true, groupKey: (r) => SIDE_LABEL[r.side],
    options: [{ value: 'gdni', label: SIDE_LABEL.gdni }, { value: 'grni', label: SIDE_LABEL.grni }], text: (r) => SIDE_LABEL[r.side]
  },
  {
    id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName ?? '', minWidth: 160, hideable: false,
    cell: (r) => (r.partyLedgerId ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName ?? ''} /> : <>{r.partyName ?? '—'}</>)
  },
  { id: 'notes', header: 'Notes', kind: 'number', value: (r) => r.notes, width: 72, aggregate: 'sum' },
  { id: 'lines', header: 'Lines', kind: 'number', value: (r) => r.lines, width: 72, defaultHidden: true, aggregate: 'sum' },
  { id: 'value', header: 'Value (taxable)', kind: 'money', value: (r) => r.value, width: 140, aggregate: 'sum' },
  { id: 'oldest', header: 'Oldest', kind: 'number', value: (r) => r.oldestDays, text: (r) => `${r.oldestDays} d`, width: 80 }
])

export function UnbilledGoodsScreen(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const { data, isLoading } = useQuery({ queryKey: ['tradeUnbilled', to], queryFn: () => api.trade.unbilledGoods(to) })
  const periodLabel = `as on ${toDisplayDate(to)}`
  return (
    <Page width="wide">
      <PageHeader
        title="Goods not invoiced"
        period={periodLabel}
        secondary={
          <>
            <Button onClick={() => nav.go({ name: 'pending-challans' })}>Pending challans</Button>
            <Button onClick={() => nav.go({ name: 'pending-grns' })}>Pending GRNs</Button>
          </>
        }
        options={{
          content: (
            <>
              <OptionsPeriod asOn />
              <OptionsTable area="unbilled-goods" />
              <DrawerSection title="What these are">
                <p className="text-hint text-muted">
                  GDNI: goods that left on a supply or on-approval delivery challan and are not invoiced yet. GRNI: goods that came in on a
                  purchase GRN and are not billed yet. Values are taxable (GST excluded), pro rata of each line&apos;s pending quantity — the
                  same as the pending reports. Short-closed and binned notes are not counted. At year end, the close screen warns with these
                  values: under periodic stock an unbilled GRN raises closing stock with no purchase booked, so post a provision if your CA asks
                  for one — nothing is posted automatically.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <StatGrid className="mb-section">
        <StatTile label="GDNI" value={formatPaise(data?.gdni.value ?? 0, { symbol: true })} hint={`${data?.gdni.notes ?? 0} challan${data?.gdni.notes === 1 ? '' : 's'} · ${data?.gdni.lines ?? 0} line${data?.gdni.lines === 1 ? '' : 's'}`} testId="unbilled-gdni" />
        <StatTile label="GRNI" value={formatPaise(data?.grni.value ?? 0, { symbol: true })} hint={`${data?.grni.notes ?? 0} GRN${data?.grni.notes === 1 ? '' : 's'} · ${data?.grni.lines ?? 0} line${data?.grni.lines === 1 ? '' : 's'}`} testId="unbilled-grni" />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="unbilled-goods"
          testId="unbilled-goods"
          ariaLabel="Goods not invoiced by party"
          columns={UNBILLED_COLUMNS}
          rows={data?.byParty ?? []}
          rowKey={(r) => `${r.side}:${r.partyLedgerId ?? 0}`}
          rowAttrs={(r) => ({ 'data-side': r.side })}
          viewDefaults={{ groupBy: 'side' }}
          loading={isLoading}
          onRowActivate={(r) => nav.go({ name: r.side === 'gdni' ? 'pending-challans' : 'pending-grns' })}
          empty={{ title: 'Everything delivered is invoiced and everything received is billed' }}
          exportOptions={{ title: 'Goods not invoiced (GRNI / GDNI)', periodLabel, filename: 'grni-gdni' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Click a party for the pending lines · F12 for options.</p>
    </Page>
  )
}

// ---------- stale documents ----------

const WHY: Record<StaleReason, { label: string; tone: 'warning' | 'danger' | 'neutral' }> = {
  expired: { label: 'Validity over', tone: 'warning' },
  overdue: { label: 'Past expected date', tone: 'danger' },
  aged: { label: 'Open too long', tone: 'neutral' }
}

const KIND_LABEL: Record<string, string> = {
  quotation: 'Quotation', sales_order: 'Sales order', purchase_order: 'Purchase order', delivery_note: 'Delivery challan', receipt_note: 'Goods receipt'
}

const STALE_COLUMNS = defineColumns<StaleDocRow>([
  { id: 'kind', header: 'Document', kind: 'text', value: (r) => KIND_LABEL[r.kind] ?? r.kind, width: 130, groupKey: (r) => KIND_LABEL[r.kind] ?? r.kind },
  {
    id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, width: 80, hideable: false,
    cell: (r) => <DocLink voucherId={r.voucherId} tradeDocId={r.tradeDocId} kind={r.kind} label={<span className="num">{r.number}</span>} />
  },
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  {
    id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName ?? '', minWidth: 120,
    cell: (r) => (r.partyLedgerId ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName ?? ''} /> : <>{r.partyName}</>)
  },
  {
    id: 'why', header: 'Why', kind: 'enum', value: (r) => r.why, width: 140,
    options: (Object.keys(WHY) as StaleReason[]).map((k) => ({ value: k, label: WHY[k].label })), text: (r) => WHY[r.why].label,
    cell: (r) => <Badge tone={WHY[r.why].tone} testId="stale-why">{WHY[r.why].label}</Badge>
  },
  { id: 'due', header: 'Due', kind: 'date', value: (r) => r.dueDate ?? '' },
  { id: 'days', header: 'Days', kind: 'number', value: (r) => r.daysStale, text: (r) => `${r.daysStale} d`, width: 72 },
  { id: 'status', header: 'Status', kind: 'text', value: (r) => chainStatusLabel(r.kind, r.status), width: 130 },
  { id: 'value', header: 'Pending value', kind: 'money', value: (r) => r.pendingValue, width: 130, aggregate: 'sum' }
])

export function StaleDocumentsScreen(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const qc = useQueryClient()
  const canWrite = useCanEditMasters()
  const opts = useScreenOptions('stale-documents', { orderAgeDays: '30', noteAgeDays: '30' })
  const orderAge = Math.max(0, parseInt(opts.options.orderAgeDays, 10) || 0)
  const noteAge = Math.max(0, parseInt(opts.options.noteAgeDays, 10) || 0)
  const { data, isLoading } = useQuery({
    queryKey: ['tradeStale', to, orderAge, noteAge],
    queryFn: () => api.trade.staleDocuments(to, orderAge, noteAge)
  })
  const rows = useMemo(() => data ?? [], [data])
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set())
  const expired = rows.filter((r) => r.kind === 'quotation' && r.why === 'expired')
  const pickedIds = expired.filter((r) => picked.has(r.tradeDocId!)).map((r) => r.tradeDocId!)
  const periodLabel = `as on ${toDisplayDate(to)}`

  const done = async (msg: string): Promise<void> => {
    toast.push('success', msg)
    setPicked(new Set())
    await qc.invalidateQueries()
  }
  const closeQuotations = async (ids?: number[]): Promise<void> => {
    const n = ids?.length ?? expired.length
    const reason = await promptDialog({
      title: `Close ${n} stale quotation${n === 1 ? '' : 's'}`,
      message: 'Each is closed as lost: nothing more can be converted from it; converted lines keep their links. Reopen any of them later from its Actions menu.',
      placeholder: 'Reason (default: Validity expired)',
      confirmLabel: 'Close'
    })
    if (reason === null) return
    try {
      const r = await api.trade.closeStaleQuotations(to, ids, reason.trim() || null)
      await done(`${r.closed.length} quotation${r.closed.length === 1 ? '' : 's'} closed`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const closeOne = async (r: StaleDocRow): Promise<void> => {
    const reason = await promptDialog({
      title: `${r.kind === 'quotation' ? 'Close' : 'Short-close'} ${KIND_LABEL[r.kind]} ${r.number}`,
      message: 'The rest of it stops being pending; what was already drawn on keeps its links.',
      placeholder: 'Reason (optional)',
      confirmLabel: 'Close'
    })
    if (reason === null) return
    try {
      if (r.tradeDocId) await api.tradeDocs.close(r.tradeDocId, reason.trim() || null)
      else if (r.voucherId) await api.trade.closeVoucher(r.voucherId, reason.trim() || null)
      await done(`${KIND_LABEL[r.kind]} ${r.number} closed`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Stale documents"
        period={periodLabel}
        actions={
          canWrite && expired.length > 0 ? (
            <Button variant="primary" data-testid="btn-close-stale-quotations" onClick={() => void closeQuotations(pickedIds.length > 0 ? pickedIds : undefined)}>
              {pickedIds.length > 0 ? `Close ${pickedIds.length} selected` : `Close all ${expired.length} expired quotations`}
            </Button>
          ) : undefined
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod asOn />
              <DrawerSection title="Stale after" testId="stale-options">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Orders, days" hint="With no expected date">
                    <TextInput value={opts.options.orderAgeDays} inputMode="numeric" className="num text-right" onChange={(e) => opts.set('orderAgeDays', e.target.value)} data-testid="input-stale-order-days" />
                  </Field>
                  <Field label="Challans / GRNs, days" hint="Not yet invoiced / billed">
                    <TextInput value={opts.options.noteAgeDays} inputMode="numeric" className="num text-right" onChange={(e) => opts.set('noteAgeDays', e.target.value)} data-testid="input-stale-note-days" />
                  </Field>
                </div>
                <p className="text-hint text-muted">Quotations go stale the day after their validity; orders the day after their expected date.</p>
              </DrawerSection>
              <OptionsTable area="stale-documents" />
            </>
          )
        }}
      />
      <StatGrid className="mb-section">
        <StatTile label="Stale" value={String(rows.length)} hint={periodLabel} testId="stale-count" />
        <StatTile label="Expired quotations" value={String(expired.length)} hint="close them as lost" />
        <StatTile label="Overdue orders" value={String(rows.filter((r) => r.why === 'overdue').length)} />
        <StatTile label="Pending value" value={formatPaise(rows.reduce((s, r) => s + r.pendingValue, 0), { symbol: true })} />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="stale-documents"
          testId="stale-documents"
          ariaLabel="Stale documents"
          columns={STALE_COLUMNS}
          rows={rows}
          rowKey={(r) => r.key}
          rowAttrs={(r) => ({ 'data-kind': r.kind, 'data-why': r.why })}
          loading={isLoading}
          onRowActivate={(r) => openLinkedDocs(r.tradeDocId ? { tradeDocId: r.tradeDocId } : { voucherId: r.voucherId! })}
          leadingWidth={40}
          leading={(r) =>
            canWrite && r.kind === 'quotation' && r.why === 'expired' ? (
              <input
                type="checkbox"
                aria-label={`Select quotation ${r.number}`}
                data-testid="input-stale-pick"
                checked={picked.has(r.tradeDocId!)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  setPicked((s) => {
                    const next = new Set(s)
                    if (e.target.checked) next.add(r.tradeDocId!)
                    else next.delete(r.tradeDocId!)
                    return next
                  })
                }
              />
            ) : null
          }
          trailingWidth={52}
          trailing={(r) =>
            canWrite ? (
              <MenuButton
                label={`Actions for ${r.number}`}
                testId={`stale-actions-${r.key}`}
                className="px-1.5 text-muted hover:text-ink"
                items={[
                  { label: 'Linked documents', onSelect: () => openLinkedDocs(r.tradeDocId ? { tradeDocId: r.tradeDocId } : { voucherId: r.voucherId! }) },
                  { label: r.kind === 'quotation' ? 'Close (lost)…' : 'Short-close…', onSelect: () => void closeOne(r), testId: 'stale-action-close' }
                ]}
              >
                ⋯
              </MenuButton>
            ) : null
          }
          empty={{ title: 'Nothing is stale', hint: 'Every open quotation, order and note is within its dates.' }}
          exportOptions={{ title: 'Stale documents', periodLabel, filename: 'stale-documents' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Tick expired quotations to close only those · ⋯ to close one · click a row for its linked documents.</p>
    </Page>
  )
}
