import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, Select, SkeletonRows, TextInput, useKeyNav, useTableNav } from '../components/ui'
import { useStickyFlag } from '../lib/useStickyTab'
import { ReportConfigButton } from '../components/ReportConfigButton'
import { useReportConfig, type ReportColumn } from '../lib/reportConfig'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { DayBookRow } from '@shared/reports'

/**
 * Rows fetched per page.
 *
 * This is a fetch window, not a render cap. Measured on a three-year book (30,000 vouchers) the
 * SQL runs in ~94 ms, but serialising the whole period is a ~6 MB JSON payload structure-cloned
 * across IPC on every visit to this screen. Fetching a window keeps that in the tens of KB.
 */
const PAGE = 500

const COLUMNS: ReportColumn[] = [
  { key: 'type', label: 'Type', defaultOn: true },
  { key: 'number', label: 'Number', defaultOn: true },
  { key: 'account', label: 'Account', defaultOn: true },
  { key: 'debit', label: 'Debit', defaultOn: true },
  { key: 'credit', label: 'Credit', defaultOn: true },
  // Off by default: it is only meaningful on bank vouchers, and a mostly-empty column costs
  // width on every row of a dense table to say something about a few of them.
  { key: 'reconciled', label: 'Reconciled', defaultOn: false }
]

/** Which vouchers show: the books only (default), everything, or just the out-of-book kinds. */
type Scope = 'books' | 'all' | 'optional' | 'post-dated'

const SCOPE_LABELS: { value: Scope; label: string }[] = [
  { value: 'books', label: 'In books' },
  { value: 'all', label: 'All vouchers' },
  { value: 'optional', label: 'Optional only' },
  { value: 'post-dated', label: 'Post-dated only' }
]


/** A drilled-into date span handed over by the Registers screen. */
export interface DrillSpan {
  from: string
  to: string
  /** Pre-rendered period label, e.g. 'Q1 FY2026-27'. */
  label: string
}

const DayBookRowView = memo(function DayBookRowView({
  row,
  index,
  isActive,
  visible,
  onHover,
  onOpen,
  onPdf
}: {
  row: DayBookRow
  index: number
  isActive: boolean
  visible: Record<string, boolean>
  onHover: (i: number) => void
  onOpen: (voucherId: number) => void
  onPdf: (voucherId: number, e: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <tr
      data-active={isActive}
      data-row-id={row.voucherId}
      className="kbar-row cursor-pointer"
      onMouseEnter={() => onHover(index)}
      onClick={() => onOpen(row.voucherId)}
    >
      <td className="num text-muted">{toDisplayDate(row.date)}</td>
      {visible.type && <td className="text-muted">{row.voucherType}</td>}
      {visible.number && <td className="num text-muted">{row.number}</td>}
      {visible.account && (
        <td>
          {row.account}
          {row.isOptional && (
            <span className="ml-2 rounded-md bg-amber/15 px-1.5 py-0.5 text-label font-medium text-amber">Optional</span>
          )}
          {row.postDated && (
            <span className="ml-2 rounded-md bg-blue/10 px-1.5 py-0.5 text-label font-medium text-blue">PDC</span>
          )}
        </td>
      )}
      <td className="max-w-56 truncate text-muted">{row.narration}</td>
      {visible.debit && (
        <td className="r">
          <Money paise={row.debit} />
          {row.kind === 'sales' && (
            <button
              className="ml-2 text-hint text-blue hover:underline"
              onClick={(e) => onPdf(row.voucherId, e)}
              title="Invoice PDF"
            >
              PDF
            </button>
          )}
        </td>
      )}
      {visible.credit && (
        <td className="r">
          <Money paise={row.credit} />
        </td>
      )}
      {visible.reconciled && (
        <td className="text-hint" data-testid="daybook-bank-status">
          {row.bankStatus == null ? (
            // Not a bank voucher. A dash, not "pending" — a cash receipt can never be cleared,
            // and showing it as outstanding would be a permanent to-do that is not a to-do.
            <span className="text-muted">–</span>
          ) : row.bankStatus === 'reconciled' ? (
            <span className="text-dr">Cleared</span>
          ) : row.bankStatus === 'partial' ? (
            <span className="text-amber">Part-cleared</span>
          ) : (
            <span className="text-amber">Not cleared</span>
          )}
        </td>
      )}
    </tr>
  )
})

export function DayBook({ span, kind }: { span?: DrillSpan; kind?: string } = {}): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const [byType, setByType] = useStickyFlag('daybook-by-type', false)
  const toast = useToasts()
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState<Scope>('books')
  const [fetched, setFetched] = useState(PAGE)
  const [exporting, setExporting] = useState(false)
  // The Registers drill-through hands over a date span + kind; keep them as dismissible local
  // state so the chip's ✕ clears the drill without a navigation. The span is a period range
  // rather than a month so a quarterly (or half-yearly, or annual) register row can drill too.
  const [drill, setDrill] = useState<{ span?: DrillSpan; kind?: string }>({ span, kind })
  useEffect(() => {
    setDrill({ span, kind })
  }, [span, kind])
  const { data, isLoading } = useQuery({
    queryKey: ['daybook', from, to, 'all', fetched],
    queryFn: () => api.reports.dayBook(from, to, true, { limit: fetched, offset: 0 }),
    // Keep the previous page on screen while the next one loads, so "Show more" grows the list
    // instead of blanking it.
    placeholderData: (prev) => prev
  })
  const { visible, toggle } = useReportConfig('daybook', COLUMNS)

  const total = data?.total ?? 0

  /** The visible filters, as a function, so an export can apply the same ones to the full period. */
  const applyFilters = useCallback(
    (source: DayBookRow[]): DayBookRow[] => {
      let all = source
      if (scope === 'books') all = all.filter((r) => !r.isOptional && !r.postDated)
      else if (scope === 'optional') all = all.filter((r) => r.isOptional)
      else if (scope === 'post-dated') all = all.filter((r) => r.postDated)
      if (drill.span) all = all.filter((r) => r.date >= drill.span!.from && r.date <= drill.span!.to)
      if (drill.kind) all = all.filter((r) => r.kind === drill.kind)
      const q = filter.trim().toLowerCase()
      if (!q) return all
      return all.filter(
        (r) =>
          r.account.toLowerCase().includes(q) ||
          r.voucherType.toLowerCase().includes(q) ||
          r.number.toLowerCase().includes(q) ||
          (r.narration ?? '').toLowerCase().includes(q)
      )
    },
    [filter, scope, drill]
  )

  const rows = useMemo(() => applyFilters(data?.rows ?? []), [data, applyFilters])

  useEffect(() => {
    setFetched(PAGE)
  }, [from, to])

  const displayRows = rows
  const loadedAll = (data?.rows.length ?? 0) >= total
  const remaining = total - (data?.rows.length ?? 0)
  // A filter can only match inside what has been fetched. Saying so is better than showing four
  // results and letting the user believe that is all there is.
  const filtering = filter.trim() !== '' || scope !== 'books' || !!drill.span || !!drill.kind

  // Totals stay honest: only in-books rows (never optional/PDC) count, whatever the scope shows.
  const bookRows = useMemo(() => rows.filter((r) => !r.isOptional && !r.postDated), [rows])
  const totalDebit = bookRows.reduce((s, r) => s + r.debit, 0)
  const totalCredit = bookRows.reduce((s, r) => s + r.credit, 0)

  const { active, setActive } = useKeyNav(displayRows.length, (i) => {
    const r = displayRows[i]
    if (r) nav.go({ name: 'voucher-entry', voucherId: r.voucherId })
  })

  const openRow = useCallback(
    (voucherId: number) => {
      nav.go({ name: 'voucher-entry', voucherId })
    },
    [nav]
  )

  const openPdf = useCallback(
    (voucherId: number, e: React.MouseEvent) => {
      e.stopPropagation()
      api.invoice.pdf(voucherId).catch((err: Error) => toast.push('error', err.message))
    },
    [toast]
  )

  // Date and Narration always show; the rest follow the F12 column config.
  const colCount =
    2 +
    (visible.type ? 1 : 0) +
    (visible.number ? 1 : 0) +
    (visible.account ? 1 : 0) +
    (visible.debit ? 1 : 0) +
    (visible.credit ? 1 : 0) +
    (visible.reconciled ? 1 : 0)

  const exportColumns: PdfColumn[] = [
    { label: 'Date', align: 'l' },
    ...(visible.type ? [{ label: 'Type', align: 'l' as const }] : []),
    ...(visible.number ? [{ label: 'No.', align: 'l' as const }] : []),
    ...(visible.account ? [{ label: 'Account', align: 'l' as const }] : []),
    { label: 'Narration', align: 'l' },
    ...(visible.debit ? [{ label: 'Debit', align: 'r' as const }] : []),
    ...(visible.credit ? [{ label: 'Credit', align: 'r' as const }] : [])
  ]
  const badge = (r: DayBookRow): string => (r.isOptional ? ' [Optional]' : r.postDated ? ' [PDC]' : '')
  const toExportRows = (source: DayBookRow[]): PdfRow[] => [
    ...source.map((r) => ({
      cells: [
        toDisplayDate(r.date),
        ...(visible.type ? [r.voucherType] : []),
        ...(visible.number ? [r.number] : []),
        ...(visible.account ? [`${r.account}${badge(r)}`] : []),
        r.narration ?? '',
        ...(visible.debit ? [formatPaise(r.debit, { zeroDash: true })] : []),
        ...(visible.credit ? [formatPaise(r.credit, { zeroDash: true })] : [])
      ]
    })),
    {
      cells: [
        `Total (in books) · ${source.filter((r) => !r.isOptional && !r.postDated).length} vouchers`,
        ...(visible.type ? [''] : []),
        ...(visible.number ? [''] : []),
        ...(visible.account ? [''] : []),
        '',
        ...(visible.debit
          ? [formatPaise(source.reduce((sum, r) => sum + (r.isOptional || r.postDated ? 0 : r.debit), 0), { zeroDash: true })]
          : []),
        ...(visible.credit
          ? [formatPaise(source.reduce((sum, r) => sum + (r.isOptional || r.postDated ? 0 : r.credit), 0), { zeroDash: true })]
          : [])
      ],
      bold: true,
      rule: true
    }
  ]

  /**
   * Exports cover the WHOLE period, not the window on screen.
   *
   * The screen fetches a page to keep the IPC payload small, so building an export from what is
   * rendered would silently ship 500 of 30,000 rows and look complete. This refetches without a
   * limit and applies the same filters the user can see.
   */
  const fullExportRows = async (): Promise<PdfRow[]> => {
    const complete = await api.reports.dayBook(from, to, true)
    return toExportRows(applyFilters(complete.rows))
  }
  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const hasOutOfBooks = rows.length !== bookRows.length

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to filter…" data-filter-box className="w-56" />
            <Select
              data-testid="input-daybook-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
              className="w-40"
              aria-label="Voucher scope"
            >
              {SCOPE_LABELS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              data-testid="btn-daybook-by-type"
              onClick={() => setByType(!byType)}
              title="Count and total the period by voucher type"
            >
              {byType ? 'Show entries' : 'By type'}
            </Button>
            <ReportConfigButton columns={COLUMNS} visible={visible} toggle={toggle} />
            <Button
              variant="ghost"
              disabled={exporting}
              onClick={() => {
                setExporting(true)
                void fullExportRows()
                  .then((all) => printReport({ title: 'Day book', periodLabel, columns: exportColumns, rows: all }, toast))
                  .catch((err: Error) => toast.push('error', err.message))
                  .finally(() => setExporting(false))
              }}
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              disabled={exporting}
              onClick={() => {
                setExporting(true)
                void fullExportRows()
                  .then((all) =>
                    csvReport(exportColumns.map((c) => c.label), all.map((r) => r.cells), 'day-book', toast)
                  )
                  .catch((err: Error) => toast.push('error', err.message))
                  .finally(() => setExporting(false))
              }}
            >
              CSV
            </Button>
          </div>
        }
      >
        Day book
      </SectionTitle>
      {(drill.span || drill.kind) && (
        <div className="mb-3 flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border border-amberbar/50 bg-amberbar/10 px-3 py-1 text-small">
            {drill.span ? drill.span.label : null}
            {drill.span && drill.kind ? ' · ' : ''}
            {drill.kind ? <span className="capitalize">{drill.kind.replace('_', ' ')}</span> : null}
            <button
              type="button"
              data-testid="daybook-clear-drill"
              aria-label="Clear the period/kind filter"
              className="ml-1 text-muted hover:text-ink"
              onClick={() => setDrill({})}
            >
              ✕
            </button>
          </span>
          <span className="text-hint text-muted">Filtered from Registers</span>
        </div>
      )}
      {byType ? (
        <ByTypePanel from={from} to={to} includeOutOfBooks={scope !== 'books'} />
      ) : (
      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState
            title={scope === 'books' ? 'No entries in this period' : `No ${scope === 'all' ? '' : scope + ' '}vouchers in this period`}
            hint="Press V for voucher entry"
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-24">Date</th>
                {visible.type && <th className="w-28">Type</th>}
                {visible.number && <th className="w-20">No.</th>}
                {visible.account && <th>Account</th>}
                <th>Narration</th>
                {visible.debit && <th className="r w-36">Debit</th>}
                {visible.credit && <th className="r w-36">Credit</th>}
                {visible.reconciled && <th className="w-28">Reconciled</th>}
              </tr>
            </thead>
            <tbody data-testid="rows-daybook">
              {displayRows.map((r, i) => (
                <DayBookRowView
                  key={`${r.voucherId}`}
                  row={r}
                  index={i}
                  isActive={i === active}
                  visible={visible}
                  onHover={setActive}
                  onOpen={openRow}
                  onPdf={openPdf}
                />
              ))}
              {!loadedAll && (
                <tr>
                  <td colSpan={colCount} className="py-2 text-center">
                    <Button variant="ghost" onClick={() => setFetched((f) => f + PAGE)}>
                      Show 500 more ({remaining.toLocaleString('en-IN')} more in this period)
                    </Button>
                    {filtering && (
                      <p className="mt-1 text-hint text-muted">
                        Filters apply to the {(data?.rows.length ?? 0).toLocaleString('en-IN')} entries loaded so far.
                        Narrow the dates, or load more.
                      </p>
                    )}
                  </td>
                </tr>
              )}
              <tr className="total-row">
                <td
                  colSpan={
                    colCount - (visible.debit ? 1 : 0) - (visible.credit ? 1 : 0) - (visible.reconciled ? 1 : 0)
                  }
                >
                  Total{hasOutOfBooks ? ' (in books)' : ''} · {bookRows.length} vouchers
                </td>
                {visible.debit && (
                  <td className="r">
                    <Money paise={totalDebit} />
                  </td>
                )}
                {visible.credit && (
                  <td className="r">
                    <Money paise={totalCredit} />
                  </td>
                )}
                {visible.reconciled && <td />}
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      )}
    </div>
  )
}

/**
 * The period by voucher type.
 *
 * A summary rather than subtotals inside the list, because the list is paged: subtotals over a
 * page would be subtotals of an arbitrary slice, which is worse than none at all. This counts the
 * whole period server-side however many rows that is, and each row drills into the Day Book
 * filtered to that type.
 */
function ByTypePanel({
  from,
  to,
  includeOutOfBooks
}: {
  from: string
  to: string
  includeOutOfBooks: boolean
}): React.JSX.Element {
  const nav = useNav()
  const { data, isLoading } = useQuery({
    queryKey: ['dayBookByType', from, to, includeOutOfBooks],
    queryFn: () => api.reports.dayBookByType(from, to, includeOutOfBooks)
  })
  const rows = data ?? []
  const table = useTableNav(rows, {
    rowId: (r) => r.kind,
    onEnter: (r) => nav.go({ name: 'daybook', kind: r.kind })
  })

  return (
    <>
      <Panel>
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState title="No entries in this period" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Voucher type</th>
                <th className="r w-24">Count</th>
                <th className="r w-40">Debit</th>
                <th className="r w-40">Credit</th>
              </tr>
            </thead>
            <tbody data-testid="rows-daybook-by-type">
              {rows.map((r, i) => (
                <tr key={r.kind} {...table.rowProps(i, r)}>
                  <td>{r.voucherType}</td>
                  <td className="r num">{r.count}</td>
                  <td className="r"><Money paise={r.debit} /></td>
                  <td className="r"><Money paise={r.credit} /></td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total · {rows.reduce((s, r) => s + r.count, 0)} vouchers</td>
                <td className="r num">{rows.reduce((s, r) => s + r.count, 0)}</td>
                <td className="r"><Money paise={rows.reduce((s, r) => s + r.debit, 0)} /></td>
                <td className="r"><Money paise={rows.reduce((s, r) => s + r.credit, 0)} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Counted over the whole period, not just the entries loaded below. Click a type to open its
        vouchers.
      </p>
    </>
  )
}
