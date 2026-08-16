import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, Select, SkeletonRows, TextInput, useKeyNav } from '../components/ui'
import { ReportConfigButton } from '../components/ReportConfigButton'
import { useReportConfig, type ReportColumn } from '../lib/reportConfig'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { DayBookRow } from '@shared/reports'

const PAGE = 500

const COLUMNS: ReportColumn[] = [
  { key: 'type', label: 'Type', defaultOn: true },
  { key: 'number', label: 'Number', defaultOn: true },
  { key: 'account', label: 'Account', defaultOn: true },
  { key: 'debit', label: 'Debit', defaultOn: true },
  { key: 'credit', label: 'Credit', defaultOn: true }
]

/** Which vouchers show: the books only (default), everything, or just the out-of-book kinds. */
type Scope = 'books' | 'all' | 'optional' | 'post-dated'

const SCOPE_LABELS: { value: Scope; label: string }[] = [
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
            <span className="ml-2 rounded bg-amber/15 px-1.5 py-0.5 text-[10px] font-medium text-amber">Optional</span>
          )}
          {row.postDated && (
            <span className="ml-2 rounded bg-blue/10 px-1.5 py-0.5 text-[10px] font-medium text-blue">PDC</span>
          )}
        </td>
      )}
      <td className="max-w-56 truncate text-muted">{row.narration}</td>
      {visible.debit && (
        <td className="r">
          <Money paise={row.debit} />
          {row.kind === 'sales' && (
            <button
              className="ml-2 text-[11.5px] text-blue hover:underline"
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
    </tr>
  )
})

export function DayBook({ month, kind }: { month?: string; kind?: string } = {}): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState<Scope>('books')
  const [limit, setLimit] = useState(PAGE)
  // The Registers drill-through hands over a month + kind; keep them as dismissible local state
  // so the chip's ✕ clears the drill without a navigation.
  const [drill, setDrill] = useState<{ month?: string; kind?: string }>({ month, kind })
  useEffect(() => {
    setDrill({ month, kind })
  }, [month, kind])
  const { data, isLoading } = useQuery({
    queryKey: ['daybook', from, to, 'all'],
    queryFn: () => api.reports.dayBook(from, to, true)
  })
  const { visible, toggle } = useReportConfig('daybook', COLUMNS)

  const rows = useMemo(() => {
    let all = data ?? []
    if (scope === 'books') all = all.filter((r) => !r.isOptional && !r.postDated)
    else if (scope === 'optional') all = all.filter((r) => r.isOptional)
    else if (scope === 'post-dated') all = all.filter((r) => r.postDated)
    if (drill.month) all = all.filter((r) => r.date.startsWith(drill.month!))
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
  }, [data, filter, scope, drill])

  useEffect(() => {
    setLimit(PAGE)
  }, [from, to, filter, scope, drill])

  const displayRows = useMemo(() => rows.slice(0, limit), [rows, limit])
  const remaining = rows.length - displayRows.length

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
    2 + (visible.type ? 1 : 0) + (visible.number ? 1 : 0) + (visible.account ? 1 : 0) + (visible.debit ? 1 : 0) + (visible.credit ? 1 : 0)

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
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
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
        `Total (in books) · ${bookRows.length} vouchers`,
        ...(visible.type ? [''] : []),
        ...(visible.number ? [''] : []),
        ...(visible.account ? [''] : []),
        '',
        ...(visible.debit ? [formatPaise(totalDebit, { zeroDash: true })] : []),
        ...(visible.credit ? [formatPaise(totalCredit, { zeroDash: true })] : [])
      ],
      bold: true,
      rule: true
    }
  ]
  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const hasOutOfBooks = rows.length !== bookRows.length

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to filter…" className="w-56" />
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
            <ReportConfigButton columns={COLUMNS} visible={visible} toggle={toggle} />
            <Button
              variant="ghost"
              onClick={() => void printReport({ title: 'Day book', periodLabel, columns: exportColumns, rows: exportRows }, toast)}
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void csvReport(exportColumns.map((c) => c.label), exportRows.map((r) => r.cells), 'day-book', toast)
              }
            >
              CSV
            </Button>
          </div>
        }
      >
        Day book
      </SectionTitle>
      {(drill.month || drill.kind) && (
        <div className="mb-3 flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border border-amberbar/50 bg-amberbar/10 px-3 py-1 text-[12px]">
            {drill.month ? monthLabel(drill.month) : null}
            {drill.month && drill.kind ? ' · ' : ''}
            {drill.kind ? <span className="capitalize">{drill.kind.replace('_', ' ')}</span> : null}
            <button
              type="button"
              data-testid="daybook-clear-drill"
              aria-label="Clear the month/kind filter"
              className="ml-1 text-muted hover:text-ink"
              onClick={() => setDrill({})}
            >
              ✕
            </button>
          </span>
          <span className="text-[11.5px] text-muted">Filtered from Registers</span>
        </div>
      )}
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
              {remaining > 0 && (
                <tr>
                  <td colSpan={colCount} className="py-2 text-center">
                    <Button variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                      Show 500 more ({remaining} remaining)
                    </Button>
                  </td>
                </tr>
              )}
              <tr className="total-row">
                <td colSpan={colCount - (visible.debit ? 1 : 0) - (visible.credit ? 1 : 0)}>
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
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
