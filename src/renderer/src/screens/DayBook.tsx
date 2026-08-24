import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { nextDraftId, useNav, useSession, useToasts } from '../state/stores'
import { useKeyLayer } from '../lib/keyboard'
import { confirmDialog } from '../lib/dialogs'
import type { VoucherKind } from '@shared/domain'
import { Button, EmptyState, Field, Modal, Money, Panel, SectionTitle, Select, SkeletonRows, TextInput, useKeyNav, useTableNav } from '../components/ui'
import { useStickyFlag } from '../lib/useStickyTab'
import { ReportConfigButton } from '../components/ReportConfigButton'
import { useReportConfig, type ReportColumn } from '../lib/reportConfig'
import { csvReport, printReport, xlsReport } from '../lib/reportExport'
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
  isSelected,
  visible,
  onHover,
  onOpen,
  onPdf,
  onDotMatrix,
  onToggleSelect
}: {
  row: DayBookRow
  index: number
  isActive: boolean
  isSelected: boolean
  visible: Record<string, boolean>
  onHover: (i: number) => void
  onOpen: (voucherId: number) => void
  onPdf: (voucherId: number, e: React.MouseEvent) => void
  onDotMatrix: (voucherId: number, e: React.MouseEvent) => void
  onToggleSelect: (voucherId: number) => void
}): React.JSX.Element {
  return (
    <tr
      data-active={isActive}
      data-row-id={row.voucherId}
      className="kbar-row group cursor-pointer"
      onMouseEnter={() => onHover(index)}
      onClick={() => onOpen(row.voucherId)}
    >
      <td onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          data-testid={`check-daybook-${row.voucherId}`}
          aria-label={`Select voucher ${row.number}`}
          checked={isSelected}
          onChange={() => onToggleSelect(row.voucherId)}
        />
      </td>
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
      {/* The invoice affordance lives in its own trailing column, never inside a numeric cell:
          a button sharing the Debit cell shortens the amount and leaves the column's right edge
          ragged from row to row. It stays quiet until the row is hovered, active or focused. */}
      <td className="r" onClick={(e) => e.stopPropagation()}>
        {row.kind === 'sales' && (
          <button
            className="row-action text-hint text-blue hover:underline"
            onClick={(e) => onPdf(row.voucherId, e)}
            title={`Invoice PDF — ${row.voucherType} ${row.number}`}
          >
            PDF
          </button>
        )}
        {/* Dot-matrix, next to the PDF and not instead of it: a shop that prints on impact
            stationery still emails a PDF, and the two are different jobs to different devices. */}
        {row.kind === 'sales' && (
          <button
            className="row-action ml-2 text-hint text-blue hover:underline"
            data-testid={`btn-daybook-dmp-${row.voucherId}`}
            onClick={(e) => onDotMatrix(row.voucherId, e)}
            title={`Print raw to a dot-matrix printer — ${row.voucherType} ${row.number}`}
          >
            DMP
          </button>
        )}
      </td>
    </tr>
  )
})

export function DayBook({ span, kind }: { span?: DrillSpan; kind?: string } = {}): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [byType, setByType] = useStickyFlag('daybook-by-type', false)
  /**
   * Rows ticked for a bulk action.
   *
   * Deliberately NOT persisted and cleared whenever the period or filter changes: a selection
   * that survives a change of what is on screen is a selection of rows the user can no longer
   * see, and the only action offered here deletes things.
   */
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [dotMatrixFor, setDotMatrixFor] = useState<number | null>(null)
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

  /**
   * ⌘D starts a new voucher shaped like the selected one.
   *
   * "Same as last time, different amount" is most of the data entry in a small business. The
   * date is deliberately not copied — a new voucher dated a month ago is a mistake — so this
   * lands on the entry screen with everything that identifies the transaction and today's date.
   */
  const duplicateRow = useCallback(
    async (voucherId: number): Promise<void> => {
      try {
        const draft = await api.vouchers.draftFrom(voucherId)
        if (!draft) return void toast.push('error', 'That voucher is no longer in the books')
        const row = displayRows.find((r) => r.voucherId === voucherId)
        nav.go({
          name: 'voucher-entry',
          kindHint: row?.kind as VoucherKind | undefined,
          draft,
          draftId: nextDraftId()
        })
      } catch (err) {
        toast.push('error', (err as Error).message)
      }
    },
    [displayRows, nav, toast]
  )

  /**
   * ⌘⌫ moves the selected voucher to the bin, with the undo on the toast.
   *
   * No confirm dialog, unlike the tick-box bulk delete above: one voucher removed by a keystroke
   * is undone by one click on the toast that appears in the same instant, and a modal between
   * the key and the deletion turns a keyboard action back into a mouse one. The bulk path keeps
   * its dialog because ticking nine rows and pressing a button is a different kind of mistake —
   * there the question is "did you mean all nine", which no undo answers as clearly.
   */
  const deleteRow = useCallback(
    async (voucherId: number, label: string): Promise<void> => {
      try {
        await api.vouchers.remove(voucherId)
        await queryClient.invalidateQueries()
        toast.push('success', `${label} moved to the bin`, {
          label: 'Undo',
          run: async () => {
            try {
              await api.vouchers.restore(voucherId)
              await queryClient.invalidateQueries()
              toast.push('success', `${label} restored`)
            } catch (err) {
              toast.push('error', `Could not restore: ${(err as Error).message}`)
            }
          }
        })
      } catch (err) {
        toast.push('error', (err as Error).message)
      }
    },
    [queryClient, toast]
  )

  useKeyLayer('screen', (e) => {
    if (e.metaKey || e.ctrlKey) {
      const row = displayRows[active]
      if (e.key.toLowerCase() === 'd') {
        if (!row) return false
        e.preventDefault()
        void duplicateRow(row.voucherId)
        return true
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (!row) return false
        e.preventDefault()
        void deleteRow(row.voucherId, `${row.voucherType} ${row.number}`)
        return true
      }
    }
    return false
  })

  useEffect(() => {
    setSelected(new Set())
  }, [from, to, scope, filter])

  const toggleSelected = useCallback((voucherId: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(voucherId)) next.delete(voucherId)
      else next.add(voucherId)
      return next
    })
  }, [])

  /**
   * Move every ticked voucher to the bin.
   *
   * One at a time rather than in a transaction: each delete runs its own period-lock check and
   * writes its own audit entry, and a batch that half-succeeds is far better reported as "9 of 10
   * moved, one is in a locked period" than rolled back wholesale. The bin makes every one of them
   * undoable anyway.
   */
  const deleteSelected = useCallback(async (): Promise<void> => {
    const ids = [...selected]
    if (ids.length === 0) return
    const ok = await confirmDialog({
      title: `Move ${ids.length} voucher${ids.length === 1 ? '' : 's'} to the bin?`,
      message: 'They stop counting in every report straight away. You can restore them from Settings → Bin.',
      confirmLabel: `Move ${ids.length} to the bin`,
      danger: true
    })
    if (!ok) return

    const failures: string[] = []
    for (const id of ids) {
      try {
        await api.vouchers.remove(id)
      } catch (err) {
        failures.push((err as Error).message)
      }
    }
    setSelected(new Set())
    await queryClient.invalidateQueries()
    if (failures.length === 0) {
      toast.push('success', `${ids.length} voucher${ids.length === 1 ? '' : 's'} moved to the bin`)
    } else {
      toast.push(
        'warning',
        `${ids.length - failures.length} of ${ids.length} moved — ${failures[0]}`
      )
    }
  }, [selected, queryClient, toast])

  const openPdf = useCallback(
    (voucherId: number, e: React.MouseEvent) => {
      e.stopPropagation()
      api.invoice.pdf(voucherId).catch((err: Error) => toast.push('error', err.message))
    },
    [toast]
  )

  const openDotMatrix = useCallback((voucherId: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setDotMatrixFor(voucherId)
  }, [])

  const colCount =
    // Date, Narration, the select checkbox and the trailing invoice-action column always show;
    // the rest follow the F12 column config.
    4 +
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
  /** Same whole-period refetch, but as typed cells: the spreadsheet gets numbers and real dates
   *  rather than the display strings the PDF and CSV want. */
  const fullExportXlsRows = async (): Promise<{ cells: (string | number | null)[] }[]> => {
    const complete = await api.reports.dayBook(from, to, true)
    return applyFilters(complete.rows).map((r) => ({
      cells: [r.date, r.voucherType, r.number, r.account, r.narration ?? '', r.debit, r.credit]
    }))
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
            <Button
              variant="ghost"
              data-testid="btn-daybook-xls"
              disabled={exporting}
              onClick={() => {
                setExporting(true)
                void fullExportXlsRows()
                  .then((rowsForSheet) =>
                    xlsReport(
                      'day-book',
                      [
                        {
                          name: 'Day book',
                          columns: [
                            { label: 'Date', kind: 'date' },
                            { label: 'Type', kind: 'text' },
                            { label: 'Number', kind: 'text' },
                            { label: 'Account', kind: 'text' },
                            { label: 'Narration', kind: 'text' },
                            { label: 'Debit', kind: 'money' },
                            { label: 'Credit', kind: 'money' }
                          ],
                          rows: rowsForSheet
                        }
                      ],
                      toast
                    )
                  )
                  .catch((err: Error) => toast.push('error', err.message))
                  .finally(() => setExporting(false))
              }}
            >
              XLS
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
      {selected.size > 0 && (
        <div
          className="mb-3 flex items-center gap-3 rounded-md border border-amber/50 bg-amber/10 px-3.5 py-2.5 text-body-sm"
          data-testid="daybook-selection-bar"
        >
          <span>
            <b>{selected.size}</b> selected
          </span>
          <button className="text-small text-muted hover:text-ink" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <span className="flex-1" />
          <Button variant="danger" data-testid="btn-daybook-bulk-delete" onClick={() => void deleteSelected()}>
            Move to bin
          </Button>
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
                <th scope="col" className="w-8" aria-label="Select" />
                <th scope="col" className="w-24">Date</th>
                {visible.type && <th scope="col" className="w-28">Type</th>}
                {visible.number && <th scope="col" className="w-20">No.</th>}
                {visible.account && <th scope="col">Account</th>}
                <th scope="col">Narration</th>
                {visible.debit && <th scope="col" className="r w-36">Debit</th>}
                {visible.credit && <th scope="col" className="r w-36">Credit</th>}
                {visible.reconciled && <th scope="col" className="w-28">Reconciled</th>}
                <th scope="col" className="w-12" aria-label="Invoice" />
              </tr>
            </thead>
            <tbody data-testid="rows-daybook">
              {displayRows.map((r, i) => (
                <DayBookRowView
                  key={`${r.voucherId}`}
                  row={r}
                  index={i}
                  isActive={i === active}
                  isSelected={selected.has(r.voucherId)}
                  visible={visible}
                  onHover={setActive}
                  onOpen={openRow}
                  onPdf={openPdf}
                  onDotMatrix={openDotMatrix}
                  onToggleSelect={toggleSelected}
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
                    colCount - 1 - (visible.debit ? 1 : 0) - (visible.credit ? 1 : 0) - (visible.reconciled ? 1 : 0)
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
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      )}
      {dotMatrixFor !== null && <DotMatrixModal voucherId={dotMatrixFor} onClose={() => setDotMatrixFor(null)} />}
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
                <th scope="col">Voucher type</th>
                <th scope="col" className="r w-24">Count</th>
                <th scope="col" className="r w-40">Debit</th>
                <th scope="col" className="r w-40">Credit</th>
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

/**
 * Print an invoice as ESC/P bytes on an impact printer (roadmap #379).
 *
 * A preview of the byte stream rather than of a page, because that is what is actually sent:
 * escape codes in angle brackets, text as text. Nobody has ever run this against a physical
 * printer — the sequences are the documented ones and the job is sent with `lp -o raw`, but the
 * "save to a file" button exists so that whoever tries it first can look at the bytes.
 */
function DotMatrixModal({ voucherId, onClose }: { voucherId: number; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const [width, setWidth] = useState<80 | 132>(80)
  const [copies, setCopies] = useState(1)
  const [preprinted, setPreprinted] = useState(false)
  const [printer, setPrinter] = useState('')

  const COPY_LABELS = ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER']
  const options = {
    width,
    condensed: width === 132,
    preprintedHeader: preprinted,
    copies: COPY_LABELS.slice(0, copies)
  }

  const { data: printers } = useQuery({ queryKey: ['rawPrinters'], queryFn: api.rawPrint.printers })
  const { data: preview } = useQuery({
    queryKey: ['escpPreview', voucherId, width, copies, preprinted],
    queryFn: () => api.rawPrint.preview(voucherId, options)
  })

  const send = async (): Promise<void> => {
    try {
      const result = await api.rawPrint.print(voucherId, printer, options)
      toast.push('success', `${result.bytes} bytes sent to ${result.printer}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const save = async (): Promise<void> => {
    try {
      const result = await api.rawPrint.save(voucherId, options)
      toast.push('success', `Saved to ${result.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Print on a dot-matrix printer" onClose={onClose} wide>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Paper" hint="132 columns prints condensed">
          <Select data-testid="select-dmp-width" value={width} onChange={(e) => setWidth(Number(e.target.value) as 80 | 132)}>
            <option value={80}>80 columns</option>
            <option value={132}>132 columns</option>
          </Select>
        </Field>
        <Field label="Copies" hint="Rule 46 asks each to be marked">
          <Select value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
            <option value={1}>Original only</option>
            <option value={2}>Original + duplicate</option>
            <option value={3}>All three</option>
          </Select>
        </Field>
        <Field label="Stationery">
          <Select value={preprinted ? 'pre' : 'plain'} onChange={(e) => setPreprinted(e.target.value === 'pre')}>
            <option value="plain">Plain continuous</option>
            <option value="pre">Pre-printed letterhead</option>
          </Select>
        </Field>
        <Field label="Printer" hint="A raw queue, not a PDF one">
          <Select data-testid="select-dmp-printer" value={printer} onChange={(e) => setPrinter(e.target.value)}>
            <option value="">Choose…</option>
            {(printers ?? []).map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <pre
        className="mt-4 max-h-80 overflow-auto rounded-md border border-line bg-panel2 p-3 num text-hint whitespace-pre"
        data-testid="dmp-preview"
      >
        {preview?.text ?? '…'}
      </pre>
      <p className="mt-2 text-hint text-muted">
        {preview ? `${preview.bytes} bytes.` : ''} Escape codes are shown in angle brackets — that
        is what goes down the wire, unrendered. This has never been tested against a physical
        printer.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button data-testid="btn-dmp-save" onClick={() => void save()}>
          Save the bytes
        </Button>
        <Button variant="primary" data-testid="btn-dmp-print" disabled={!printer} onClick={() => void send()}>
          Print
        </Button>
      </div>
    </Modal>
  )
}
