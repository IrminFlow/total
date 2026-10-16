// Delivery challans / Goods receipt notes (WP 2.5b lists): every challan / GRN with its items,
// quantity, what is still pending (from live links, as on the period end), its status and the
// invoices / bills drawing on it — trade:noteList, computed at query time (only the short-close is
// stored). "Convert to invoice / bill" opens the sales / purchase editor with every pending line
// drawn as the "Add from…" drawer would (supply / purchase links, written by the editor's own
// voucher:save); tick several notes of one party to put them on one invoice / bill.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { purposeLabel, STOCK_NOTE_PURPOSES } from '@shared/voucherEdit'
import type { NoteListFilter, NoteListStatus, StockNoteListRow } from '@shared/tradeCycle/types'
import { CONVERT_TARGET, convertTogetherProblem, noteStatusLabel, type NoteStage } from '@shared/tradeCycle/convert'
import { api } from '../lib/client'
import { formatMilli } from '../lib/table/format'
import { useCanEditMasters } from '../lib/drill'
import { useCapabilityRefused } from '../lib/capabilities'
import { nextDraftId, useNav, useSession } from '../state/stores'
import { Badge, Button, DrawerSection, Page, PageHeader, Panel, Segmented } from '../components/ui'
import type { BadgeTone } from '../components/kit/Badge'
import { OptionsPeriod, OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink, VoucherLink } from '../components/links'
import { NoteTabs } from './trade/noteTabs'

const STATUSES: readonly NoteListStatus[] = ['pending', 'partly', 'done', 'closed']
const TONE: Record<NoteListStatus, BadgeTone> = { pending: 'info', partly: 'amber', done: 'success', closed: 'neutral' }
/** A quantity in the note's one unit; "mixed units" when its lines' units differ. */
const qtyText = (q: number | null, r: StockNoteListRow): string => (q == null ? 'mixed units' : `${formatMilli(q, r.decimals)}${r.unit ? ` ${r.unit}` : ''}`)
const onlyReturned = (r: StockNoteListRow): boolean => r.targets.length > 0 && r.targets.every((t) => t.linkType === 'return')

function columnsFor(stage: NoteStage) {
  const out = stage === 'delivery_note'
  return defineColumns<StockNoteListRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
    {
      id: 'number', header: out ? 'Challan' : 'GRN', kind: 'text', value: (r) => r.number, width: 104, hideable: false,
      cell: (r) => <VoucherLink voucherId={r.voucherId} label={<span className="num">{r.number}</span>} />
    },
    {
      id: 'party', header: out ? 'Consignee' : 'Supplier', kind: 'text', value: (r) => r.partyName ?? '', minWidth: 150,
      cell: (r) => (r.partyLedgerId ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName ?? ''} /> : <>{r.partyName}</>)
    },
    {
      id: 'purpose', header: 'Purpose', kind: 'enum', value: (r) => r.purpose, width: 110, defaultHidden: !out,
      options: STOCK_NOTE_PURPOSES[stage].map((p) => ({ value: p.value, label: p.label })),
      text: (r) => purposeLabel(r.purpose)
    },
    { id: 'items', header: 'Items', kind: 'text', value: (r) => r.items, minWidth: 160 },
    { id: 'lines', header: 'Lines', kind: 'number', value: (r) => r.lineCount, width: 64, defaultHidden: true },
    {
      id: 'qty', header: out ? 'Delivered' : 'Received', kind: 'quantity', value: (r) => r.qtyMilli, decimals: (r) => r.decimals,
      unit: (r) => r.unit ?? '', width: 110, text: (r) => qtyText(r.qtyMilli, r)
    },
    {
      id: 'pending', header: 'Pending', kind: 'quantity', value: (r) => r.pendingMilli, decimals: (r) => r.decimals,
      unit: (r) => r.unit ?? '', width: 110, text: (r) => (r.pendingMilli == null ? `${r.pendingLines} of ${r.lineCount} lines` : qtyText(r.pendingMilli, r))
    },
    { id: 'value', header: 'Value', kind: 'money', value: (r) => r.value, width: 130, defaultHidden: true, aggregate: 'sum' },
    { id: 'pendingValue', header: 'Pending value', kind: 'money', value: (r) => r.pendingValue, width: 130, aggregate: 'sum' },
    {
      id: 'status', header: 'Status', kind: 'enum', value: (r) => r.status, width: 130,
      options: STATUSES.map((s) => ({ value: s, label: noteStatusLabel(stage, s) })),
      text: (r) => noteStatusLabel(stage, r.status, onlyReturned(r)),
      cell: (r) => (
        <Badge tone={TONE[r.status]} testId="note-status" title={r.closeReason ?? undefined}>
          {noteStatusLabel(stage, r.status, onlyReturned(r))}
        </Badge>
      )
    },
    {
      id: 'linked', header: out ? 'Invoices' : 'Bills', kind: 'text', value: (r) => r.targets.map((t) => t.number).join(', '), minWidth: 120,
      sortable: false,
      cell: (r) => (
        <span className="inline-flex flex-wrap gap-x-1.5">
          {r.targets.map((t) => (
            <span key={`${t.voucherId}-${t.linkType}`} data-testid="note-target">
              <VoucherLink voucherId={t.voucherId} label={<span className="num">{t.number}</span>} />
              {t.linkType === 'return' && <span className="text-hint text-muted"> (return)</span>}
            </span>
          ))}
        </span>
      )
    },
    { id: 'reason', header: 'Close reason', kind: 'text', value: (r) => r.closeReason ?? '', defaultHidden: true }
  ])
}

const COLUMNS: Record<NoteStage, ReturnType<typeof columnsFor>> = {
  delivery_note: columnsFor('delivery_note'),
  receipt_note: columnsFor('receipt_note')
}

const TITLE: Record<NoteStage, string> = { delivery_note: 'Delivery challans', receipt_note: 'Goods receipt notes' }
const FILTERS: readonly { value: NoteListFilter; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'closed', label: 'Done / closed' },
  { value: 'all', label: 'All' }
]

export function TradeNoteListScreen({ stage, filter: initialFilter }: { stage: NoteStage; filter?: NoteListFilter }): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const canWrite = useCanEditMasters()
  const postRefused = useCapabilityRefused('canPost')
  const canConvert = canWrite && !postRefused
  const [filter, setFilter] = useState<NoteListFilter>(initialFilter ?? 'pending')
  const [selected, setSelected] = useState<ReadonlySet<number | string>>(() => new Set())
  const { data, isLoading } = useQuery({
    queryKey: ['tradeNoteList', stage, from, to, filter],
    queryFn: () => api.trade.noteList({ stage, from, to, asOn: to, filter })
  })
  const rows = useMemo(() => data ?? [], [data])
  const out = stage === 'delivery_note'
  const noun = out ? 'challan' : 'GRN'
  const target = out ? 'invoice' : 'bill'
  const periodLabel = filter === 'pending' ? `pending as on ${toDisplayDate(to)}` : `${toDisplayDate(from)} to ${toDisplayDate(to)}`

  const picked = rows.filter((r) => selected.has(r.voucherId))
  const problem = convertTogetherProblem(picked)
  const convert = (notes: readonly StockNoteListRow[]): void => {
    if (notes.length === 0 || convertTogetherProblem(notes)) return
    nav.go({
      name: 'voucher-entry',
      kindHint: CONVERT_TARGET[stage],
      draft: { partyLedgerId: notes[0]!.partyLedgerId!, fromVoucherIds: notes.map((n) => n.voucherId) },
      draftId: nextDraftId()
    })
  }

  return (
    <Page width="wide">
      <PageHeader
        title={TITLE[stage]}
        period={periodLabel}
        tabs={<NoteTabs active={out ? 'challans' : 'grns'} />}
        actions={
          canWrite ? (
            <Button data-testid="btn-trade-notes-new" onClick={() => nav.go({ name: 'voucher-entry', kindHint: stage })}>
              New {noun}
            </Button>
          ) : undefined
        }
        options={{
          content: (
            <>
              <OptionsPeriod />
              <OptionsTable area={`trade-notes-${stage}`} />
              <DrawerSection title="About this list">
                <p className="text-hint text-muted">
                  Pending is worked out from the {target}s (and returns) drawing on each {noun}, dated on or before the period end —
                  the same figure as the Pending {out ? 'challans' : 'GRNs'} report and {out ? 'GDNI' : 'GRNI'}. “Pending” lists
                  every {noun} still to {out ? 'invoice' : 'bill'}, whatever its date; “Done / closed” and “All” list the period.
                  Short-closing is the only status set by hand. “Convert to {target}” draws every pending line into a new {target}
                  {out ? ' (supply and on-approval challans)' : ' (purchase GRNs)'}; tick several {noun}s of one party to put them on
                  one {target}.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <Panel>
        <DataTable
          key={stage}
          viewId={`trade-notes-${stage}`}
          testId={`trade-notes-${stage}`}
          ariaLabel={TITLE[stage]}
          columns={COLUMNS[stage]}
          rows={rows}
          rowKey={(r) => r.voucherId}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId, 'data-status': r.status })}
          loading={isLoading}
          onRowActivate={(r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
          {...(canConvert
            ? {
                selection: {
                  selected,
                  onChange: (next) => setSelected(next),
                  isSelectable: (r: StockNoteListRow) => r.convertible,
                  label: (r: StockNoteListRow) => `Select ${noun} ${r.number}`
                }
              }
            : {})}
          trailingWidth={150}
          trailing={(r) =>
            canConvert && r.convertible ? (
              <Button size="sm" data-testid={`btn-note-convert-${r.voucherId}`} onClick={() => convert([r])}>
                Convert to {target}
              </Button>
            ) : null
          }
          toolbarStart={
            <Segmented
              label="Show"
              size="sm"
              options={FILTERS}
              value={filter}
              onChange={(f) => {
                setFilter(f)
                setSelected(new Set())
              }}
              testId="trade-notes-filter"
            />
          }
          toolbarEnd={
            canConvert && picked.length > 0 ? (
              <Button
                size="sm"
                variant="primary"
                data-testid="btn-notes-convert-selected"
                disabled={problem != null}
                disabledTitle={problem ?? undefined}
                onClick={() => convert(picked)}
              >
                Convert {picked.length} {noun}{picked.length === 1 ? '' : 's'} to one {target}
              </Button>
            ) : undefined
          }
          empty={{
            title: filter === 'pending' ? (out ? 'Every challan is invoiced' : 'Every GRN is billed') : `No ${noun}s in this period`,
            hint: filter === 'pending' ? 'Pick “All” to see the finished ones.' : undefined
          }}
          exportOptions={{ title: TITLE[stage], periodLabel, filename: out ? 'challans' : 'grns' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Click a row to open its {noun} · tick {noun}s of one party to convert them together · F12 for options.
      </p>
    </Page>
  )
}
