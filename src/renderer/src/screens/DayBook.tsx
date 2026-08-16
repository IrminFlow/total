import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, SkeletonRows, TextInput, useKeyNav } from '../components/ui'
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
      {visible.account && <td>{row.account}</td>}
      <td className="max-w-56 truncate text-muted">{row.narration}</td>
      {visible.debit && (
        <td className="r">
          <Money paise={row.debit} />
          {row.voucherType === 'Sales' && (
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

export function DayBook(): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const { data, isLoading } = useQuery({
    queryKey: ['daybook', from, to],
    queryFn: () => api.reports.dayBook(from, to)
  })
  const { visible, toggle } = useReportConfig('daybook', COLUMNS)

  const rows = useMemo(() => {
    const all = data ?? []
    const q = filter.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (r) =>
        r.account.toLowerCase().includes(q) ||
        r.voucherType.toLowerCase().includes(q) ||
        r.number.toLowerCase().includes(q) ||
        (r.narration ?? '').toLowerCase().includes(q)
    )
  }, [data, filter])

  useEffect(() => {
    setLimit(PAGE)
  }, [from, to, filter])

  const displayRows = useMemo(() => rows.slice(0, limit), [rows, limit])
  const remaining = rows.length - displayRows.length

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
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        toDisplayDate(r.date),
        ...(visible.type ? [r.voucherType] : []),
        ...(visible.number ? [r.number] : []),
        ...(visible.account ? [r.account] : []),
        r.narration ?? '',
        ...(visible.debit ? [formatPaise(r.debit, { zeroDash: true })] : []),
        ...(visible.credit ? [formatPaise(r.credit, { zeroDash: true })] : [])
      ]
    })),
    {
      cells: [
        `Total · ${rows.length} vouchers`,
        ...(visible.type ? [''] : []),
        ...(visible.number ? [''] : []),
        ...(visible.account ? [''] : []),
        '',
        ...(visible.debit ? [formatPaise(rows.reduce((s, r) => s + r.debit, 0), { zeroDash: true })] : []),
        ...(visible.credit ? [formatPaise(rows.reduce((s, r) => s + r.credit, 0), { zeroDash: true })] : [])
      ],
      bold: true,
      rule: true
    }
  ]
  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to filter…" className="w-64" />
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
      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState title="No entries in this period" hint="Press V for voucher entry" />
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
                  Total · {rows.length} vouchers
                </td>
                {visible.debit && (
                  <td className="r">
                    <Money paise={rows.reduce((s, r) => s + r.debit, 0)} />
                  </td>
                )}
                {visible.credit && (
                  <td className="r">
                    <Money paise={rows.reduce((s, r) => s + r.credit, 0)} />
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
