// Registers → All entries: every voucher of every type in a date range, in order (what the Day
// book screen showed before the feature cleanup removed it). Links that opened the Day book open
// this tab with the same date / range (a month of a register, today's entries on simple Home, the
// vouchers behind a cash-flow line, the close checklist, AI sources).
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useNav, useToasts } from '../../state/stores'
import { Badge, Chip, Panel } from '../../components/ui'
import { DataTable, defineColumns, type DataTableFooterContext } from '../../components/table'
import type { DayBookRow } from '@shared/reports'
import { printKindForVoucherKind } from '@shared/printTemplates'
import { LedgerLink } from '../../components/links'
import { LINKABLE_VOUCHER_KINDS, openLinkedDocs } from '../../components/LinkedDocs'
import { useFeatures } from '../../lib/useFeatures'
import { useBulkSelection } from '../../components/bulk/BulkEdit'
import { AttachmentsModal } from '../../components/attachments/Attachments'
import { attachmentsApi } from '../../lib/workspaceClient'
import { useAiScreenContext } from '../../lib/aiContext'

/** Which vouchers show: the books only (default), everything, or just the out-of-book kinds. */
export type EntriesScope = 'books' | 'all' | 'optional' | 'post-dated'

export const ENTRIES_SCOPE_LABELS: { value: EntriesScope; label: string }[] = [
  { value: 'books', label: 'In books' },
  { value: 'all', label: 'All vouchers' },
  { value: 'optional', label: 'Optional only' },
  { value: 'post-dated', label: 'Post-dated only' }
]

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`
}

/** Totals stay honest: only in-books rows (never optional/PDC) count, whatever the scope shows. */
const inBooks = (r: DayBookRow): boolean => !r.isOptional && !r.postDated
const badge = (r: DayBookRow): string =>
  (r.isOptional ? ' [Optional]' : r.postDated ? ' [PDC]' : '') + (r.yearEndClose ? ' [Year-end closing entry]' : '')

export const ALL_ENTRIES_COLUMNS = defineColumns<DayBookRow>([
  {
    id: 'date',
    header: 'Date',
    kind: 'date',
    value: (r) => r.date,
    className: 'text-muted',
    hideable: false,
    groupKey: (r) => monthLabel(r.date.slice(0, 7))
  },
  { id: 'type', header: 'Type', kind: 'text', value: (r) => r.voucherType, className: 'text-muted', width: 130 },
  { id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, className: 'num text-muted', width: 100, groupable: false },
  {
    id: 'account',
    header: 'Account',
    kind: 'text',
    value: (r) => r.account,
    text: (r) => `${r.account}${badge(r)}`,
    minWidth: 160,
    // The row opens the voucher; only the account NAME drills to the ledger's edit window.
    cell: (r) => (
      <>
        <LedgerLink ledgerId={r.accountLedgerId} name={r.account} />
        {r.isOptional && (
          <Badge tone="amber" className="ml-2">
            Optional
          </Badge>
        )}
        {r.postDated && (
          <Badge tone="info" className="ml-2">
            PDC
          </Badge>
        )}
        {r.yearEndClose && (
          <Badge tone="info" className="ml-2" testId="entries-year-end-chip">
            Year-end closing entry
          </Badge>
        )}
      </>
    )
  },
  { id: 'narration', header: 'Narration', kind: 'text', value: (r) => r.narration ?? '', className: 'text-muted', groupable: false },
  {
    id: 'debit',
    header: 'Debit',
    kind: 'money',
    value: (r) => r.debit,
    width: 140,
    aggregate: (rows) => rows.filter(inBooks).reduce((s, r) => s + r.debit, 0)
  },
  {
    id: 'credit',
    header: 'Credit',
    kind: 'money',
    value: (r) => r.credit,
    width: 140,
    aggregate: (rows) => rows.filter(inBooks).reduce((s, r) => s + r.credit, 0)
  }
])

/** "Total (in books) · 12 vouchers" — the count is of rows that reach the books, out of the rows
 *  in view (filters and the quick filter applied). The table lays the row out (label spanning the
 *  columns before the first total, sums under Debit / Credit). */
function entriesTotalsLabel({ rows }: DataTableFooterContext<DayBookRow>): string {
  const bookCount = rows.filter(inBooks).length
  return `Total${bookCount !== rows.length ? ' (in books)' : ''} · ${bookCount} vouchers`
}

/**
 * The list. `from` / `to` = the range shown (the Registers screen's period, or the one a link asked
 * for); `kind` (a register month's voucher kind) and `voucherIds` + `source` (a cash-flow line's
 * vouchers) narrow it further as dismissible chips; `scope` comes from the screen's options.
 */
export function AllEntriesPanel({ from, to, periodLabel, scope, onScope, kind, voucherIds, source }: {
  from: string
  to: string
  periodLabel: string
  scope: EntriesScope
  onScope: (s: EntriesScope) => void
  kind?: string
  voucherIds?: number[]
  source?: string
}): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  // The assistant's screen context: Registers on its All entries tab (current_screen_data).
  useAiScreenContext('registers', { tab: 'entries' })
  // WP 2.5d: trade vouchers get a "Links" action (the linked-documents drawer).
  const ordersOn = useFeatures().orders
  const [onlyKind, setOnlyKind] = useState<string | undefined>(kind)
  useEffect(() => setOnlyKind(kind), [kind])
  const [only, setOnly] = useState<{ ids: Set<number>; source: string } | null>(voucherIds ? { ids: new Set(voucherIds), source: source ?? '' } : null)
  useEffect(() => {
    setOnly(voucherIds ? { ids: new Set(voucherIds), source: source ?? '' } : null)
  }, [voucherIds, source])
  const { data, isLoading } = useQuery({
    queryKey: ['allEntries', from, to, 'all'],
    queryFn: () => api.reports.dayBook(from, to, true)
  })

  // Scope + the link's kind / vouchers are pre-filters; everything else is the table's view.
  const rows = useMemo(() => {
    let all = data ?? []
    if (scope === 'books') all = all.filter(inBooks)
    else if (scope === 'optional') all = all.filter((r) => r.isOptional)
    else if (scope === 'post-dated') all = all.filter((r) => r.postDated)
    if (onlyKind) all = all.filter((r) => r.kind === onlyKind)
    if (only) all = all.filter((r) => only.ids.has(r.voucherId))
    return all
  }, [data, scope, onlyKind, only])

  // WP 6.4: multi-select → bulk edit (preview / apply / undo), and the row's attachments. Only the
  // rows still listed are edited, and the server refuses vouchers that left the period.
  const visibleIds = useMemo(() => rows.map((r) => r.voucherId), [rows])
  const bulk = useBulkSelection('voucher', 'registers-entries', { visibleIds, scope: { from, to } })
  const { data: fileCounts } = useQuery({ queryKey: ['attachmentCounts', 'voucher'], queryFn: () => attachmentsApi.counts('voucher') })
  const [filesFor, setFilesFor] = useState<DayBookRow | null>(null)

  const scopeLabel = ENTRIES_SCOPE_LABELS.find((x) => x.value === scope)?.label ?? ''

  return (
    <>
      {(scope !== 'books' || onlyKind || only) && (
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="entries-filters">
          {scope !== 'books' && (
            <Chip onRemove={() => onScope('books')} removeLabel={`Show in-books vouchers only (now: ${scopeLabel})`} testId="entries-scope-chip">
              {scopeLabel}
            </Chip>
          )}
          {onlyKind && (
            <Chip onRemove={() => setOnlyKind(undefined)} removeLabel="Show every voucher type" testId="entries-kind-chip">
              <span className="capitalize">{onlyKind.replace('_', ' ')}</span>
            </Chip>
          )}
          {only && (
            <Chip onRemove={() => setOnly(null)} removeLabel="Show every voucher of the period" testId="entries-only-chip">
              {only.source ? `${only.source} · ` : ''}
              {only.ids.size} {only.ids.size === 1 ? 'voucher' : 'vouchers'}
            </Chip>
          )}
        </div>
      )}
      {bulk.bar}
      <Panel>
        <DataTable
          // The Day book's saved views and column choices carry over (same storage key).
          viewId="daybook"
          legacyReportKey="daybook"
          testId="registers-entries"
          ariaLabel="All entries"
          columns={ALL_ENTRIES_COLUMNS}
          rows={rows}
          rowKey={(r) => r.voucherId}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
          loading={isLoading}
          empty={{
            title: scope === 'books' ? 'No entries in this period' : `No ${scope === 'all' ? '' : scope + ' '}vouchers in this period`,
            hint: 'Press V for voucher entry'
          }}
          onRowActivate={(r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
          selection={bulk.selection}
          toolbarEnd={bulk.historyButton}
          trailing={(r) => (
            <span className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="text-hint text-blue hover:underline"
                title="Attached files"
                data-testid="btn-entries-files"
                onClick={(e) => {
                  e.stopPropagation()
                  setFilesFor(r)
                }}
              >
                Files{fileCounts?.[r.voucherId] ? ` · ${fileCounts[r.voucherId]}` : ''}
              </button>
              {ordersOn && LINKABLE_VOUCHER_KINDS.has(r.kind) && (
                <button
                  type="button"
                  className="text-hint text-blue hover:underline"
                  title="Linked documents"
                  data-testid="btn-entries-links"
                  onClick={(e) => {
                    e.stopPropagation()
                    openLinkedDocs({ voucherId: r.voucherId })
                  }}
                >
                  Links
                </button>
              )}
              {printKindForVoucherKind(r.kind) ? (
                <button
                  type="button"
                  className="text-hint text-blue hover:underline"
                  title={r.kind === 'sales' ? 'Invoice PDF' : 'Print PDF (default template for this kind)'}
                  data-testid="btn-entries-invoice-pdf"
                  onClick={() => {
                    api.invoice.pdf(r.voucherId).catch((err: Error) => toast.push('error', err.message))
                  }}
                >
                  PDF
                </button>
              ) : null}
            </span>
          )}
          trailingWidth={ordersOn ? 148 : 112}
          totalsLabel={entriesTotalsLabel}
          exportOptions={{ title: 'All entries', periodLabel, filename: 'all-entries', totalsLabel: 'Total (in books)' }}
        />
      </Panel>
      {bulk.dialogs}
      {filesFor && (
        <AttachmentsModal
          target={{ entity: 'voucher', entityId: filesFor.voucherId }}
          title={`Files — ${filesFor.voucherType} ${filesFor.number}`}
          onClose={() => setFilesFor(null)}
        />
      )}
    </>
  )
}
