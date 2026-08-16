import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, useKeyNav } from '../components/ui'
import { csvReport, printReport, slugFilename } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { LedgerStatementRow } from '@shared/reports'

const EXPORT_COLUMNS: PdfColumn[] = [
  { label: 'Date', align: 'l' },
  { label: 'Particulars', align: 'l' },
  { label: 'Type · No.', align: 'l' },
  { label: 'Debit', align: 'r' },
  { label: 'Credit', align: 'r' },
  { label: 'Balance', align: 'r' }
]

const PAGE = 500

const LedgerStatementRowView = memo(function LedgerStatementRowView({
  row,
  index,
  isActive,
  onHover,
  onOpen
}: {
  row: LedgerStatementRow
  index: number
  isActive: boolean
  onHover: (i: number) => void
  onOpen: (voucherId: number) => void
}): React.JSX.Element {
  return (
    <tr
      data-active={isActive}
      data-row-id={row.voucherId || undefined}
      className="kbar-row cursor-pointer"
      onMouseEnter={() => onHover(index)}
      onClick={() => onOpen(row.voucherId)}
    >
      <td className="num text-muted">{toDisplayDate(row.date)}</td>
      <td className="max-w-64 truncate">{row.particulars}</td>
      <td className="num text-[12px] text-muted">
        {row.voucherType} {row.number}
      </td>
      <td className="r">
        <Money paise={row.debit} />
      </td>
      <td className="r">
        <Money paise={row.credit} />
      </td>
      <td className="r">
        <Money paise={row.running} signed />
      </td>
    </tr>
  )
})

export function LedgerStatementScreen({ ledgerId }: { ledgerId: number }): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [limit, setLimit] = useState(PAGE)
  const { data } = useQuery({
    queryKey: ['ledgerStatement', ledgerId, from, to],
    queryFn: () => api.reports.ledger(ledgerId, from, to)
  })

  const rows = data?.rows ?? []

  useEffect(() => {
    setLimit(PAGE)
  }, [ledgerId, from, to])

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

  if (!data) return <p className="text-muted">Loading…</p>

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        toDisplayDate(r.date),
        r.particulars,
        `${r.voucherType} ${r.number}`,
        formatPaise(r.debit, { zeroDash: true }),
        formatPaise(r.credit, { zeroDash: true }),
        formatPaise(r.running, { zeroDash: true })
      ]
    })),
    {
      cells: [
        '',
        'Closing balance',
        '',
        formatPaise(data.totalDebit, { zeroDash: true }),
        formatPaise(data.totalCredit, { zeroDash: true }),
        formatPaise(data.closing, { zeroDash: true })
      ],
      bold: true,
      rule: true
    }
  ]

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() =>
                void printReport({ title: data.ledgerName, periodLabel, columns: EXPORT_COLUMNS, rows: exportRows }, toast)
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void csvReport(
                  EXPORT_COLUMNS.map((c) => c.label),
                  exportRows.map((r) => r.cells),
                  `ledger-${slugFilename(data.ledgerName)}`,
                  toast
                )
              }
            >
              CSV
            </Button>
            <Money paise={data.closing} signed className="text-[15px]" />
          </div>
        }
      >
        {data.ledgerName}
      </SectionTitle>
      <Panel>
        <div className="flex justify-between border-b border-line px-4 py-2 text-[12px] text-muted">
          <span>
            Opening balance · <Money paise={data.opening} signed />
          </span>
          <span>
            {toDisplayDate(from)} → {toDisplayDate(to)}
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No entries for this ledger in the period" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-24">Date</th>
                <th>Particulars</th>
                <th className="w-24">Type · No.</th>
                <th className="r w-32">Debit</th>
                <th className="r w-32">Credit</th>
                <th className="r w-36">Balance</th>
              </tr>
            </thead>
            <tbody data-testid="rows-ledger-statement">
              {displayRows.map((r, i) => (
                <LedgerStatementRowView
                  key={i}
                  row={r}
                  index={i}
                  isActive={i === active}
                  onHover={setActive}
                  onOpen={openRow}
                />
              ))}
              {remaining > 0 && (
                <tr>
                  <td colSpan={6} className="py-2 text-center">
                    <Button variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                      Show 500 more ({remaining} remaining)
                    </Button>
                  </td>
                </tr>
              )}
              <tr className="total-row">
                <td colSpan={3}>Closing balance</td>
                <td className="r">
                  <Money paise={data.totalDebit} />
                </td>
                <td className="r">
                  <Money paise={data.totalCredit} />
                </td>
                <td className="r">
                  <Money paise={data.closing} signed />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
