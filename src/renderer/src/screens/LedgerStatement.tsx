import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, SkeletonRows, useKeyNav } from '../components/ui'
import { csvReport, printReport, slugFilename } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { LedgerStatementRow } from '@shared/reports'
import type { Period } from '@shared/period'

const EXPORT_COLUMNS: PdfColumn[] = [
  { label: 'Date', align: 'l' },
  { label: 'Particulars', align: 'l' },
  { label: 'Type · No.', align: 'l' },
  { label: 'Debit', align: 'r' },
  { label: 'Credit', align: 'r' },
  { label: 'Balance', align: 'r' }
]

/** Export columns for a columnar summary; the first header tracks the chosen granularity. */
function summaryColumns(heading: string): PdfColumn[] {
  return [
    { label: heading, align: 'l' },
    { label: 'Debit', align: 'r' },
    { label: 'Credit', align: 'r' },
    { label: 'Closing', align: 'r' }
  ]
}

/**
 * Summary granularities. `detail` is the voucher-by-voucher view; the rest are columnar
 * summaries bucketed by `@shared/period`, which anchors quarters to the Indian financial year
 * (Q1 = Apr-Jun) so this agrees with GSTR/TDS quarters. Row labels come from the service, so
 * there is no label logic to drift here.
 */
type Mode = 'detail' | Period

const MODES: { mode: Mode; tab: string; testid: string; heading: string }[] = [
  { mode: 'detail', tab: 'Vouchers', testid: 'detail', heading: 'Date' },
  { mode: 'month', tab: 'Monthly', testid: 'monthly', heading: 'Month' },
  { mode: 'quarter', tab: 'Quarterly', testid: 'quarterly', heading: 'Quarter' },
  { mode: 'half', tab: 'Half-year', testid: 'half-yearly', heading: 'Half-year' },
  { mode: 'year', tab: 'Yearly', testid: 'yearly', heading: 'Year' }
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
      <td className="num text-small text-muted">
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
  // Columnar summary mode (v0.3 #55, any granularity since v0.5): one row per period with
  // period totals + the closing balance carried across periods with no activity.
  const [mode, setMode] = useState<Mode>('detail')
  const { data, isLoading } = useQuery({
    queryKey: ['ledgerStatement', ledgerId, from, to, mode, limit],
    queryFn: () =>
      api.reports.ledger(
        ledgerId,
        from,
        to,
        mode === 'detail' ? undefined : mode,
        // Only the detail view has rows worth paging; the columnar summaries are a few dozen.
        mode === 'detail' ? { limit } : undefined
      ),
    // Keep the current page visible while the next loads, so "Show more" grows the list.
    placeholderData: (prev) => prev
  })

  const rows = data?.rows ?? []
  const periods = data?.periods ?? []
  const summaryHeading = MODES.find((m) => m.mode === mode)?.heading ?? 'Period'

  useEffect(() => {
    setLimit(PAGE)
  }, [ledgerId, from, to, mode])

  const displayRows = rows
  const remaining = (data?.totalRows ?? 0) - rows.length

  const { active, setActive } = useKeyNav(
    displayRows.length,
    (i) => {
      const r = displayRows[i]
      if (r) nav.go({ name: 'voucher-entry', voucherId: r.voucherId })
    },
    mode === 'detail'
  )

  const openRow = useCallback(
    (voucherId: number) => {
      nav.go({ name: 'voucher-entry', voucherId })
    },
    [nav]
  )

  if (!data) {
    return (
      <div className="mx-auto max-w-5xl">
        <Panel>
          <SkeletonRows />
        </Panel>
      </div>
    )
  }

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const exportColumns = mode === 'detail' ? EXPORT_COLUMNS : summaryColumns(summaryHeading)
  const buildExportRows = (detailRows: typeof rows): PdfRow[] =>
    mode !== 'detail'
      ? [
          ...periods.map((m) => ({
            cells: [
              m.label,
              formatPaise(m.debit, { zeroDash: true }),
              formatPaise(m.credit, { zeroDash: true }),
              formatPaise(m.closing, { zeroDash: true })
            ]
          })),
          {
            cells: [
              'Closing balance',
              formatPaise(data.totalDebit, { zeroDash: true }),
              formatPaise(data.totalCredit, { zeroDash: true }),
              formatPaise(data.closing, { zeroDash: true })
            ],
            bold: true,
            rule: true
          }
        ]
      : [
          ...detailRows.map((r) => ({
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

  /**
   * Exports cover the whole period, not the page on screen.
   *
   * The detail view fetches a window to keep the payload small, so building an export from what
   * is rendered would silently ship 500 rows of a 30,000-row statement and look complete.
   */
  const fullExportRows = async (): Promise<PdfRow[]> => {
    if (mode !== 'detail') return buildExportRows([])
    const complete = await api.reports.ledger(ledgerId, from, to)
    return buildExportRows(complete.rows)
  }

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {MODES.map((m) => (
                <button
                  key={m.mode}
                  data-testid={`tab-ledger-statement-${m.testid}`}
                  onClick={() => setMode(m.mode)}
                  className={`rounded-md px-3 py-1 text-body-sm ${mode === m.mode ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'}`}
                >
                  {m.tab}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              onClick={() =>
                void fullExportRows()
                  .then((all) =>
                    printReport({ title: data.ledgerName, periodLabel, columns: exportColumns, rows: all }, toast)
                  )
                  .catch((err: Error) => toast.push('error', err.message))
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void fullExportRows()
                  .then((all) =>
                    csvReport(
                      exportColumns.map((c) => c.label),
                      all.map((r) => r.cells),
                      `ledger-${slugFilename(data.ledgerName)}${mode === 'detail' ? '' : `-${mode}`}`,
                      toast
                    )
                  )
                  .catch((err: Error) => toast.push('error', err.message))
              }
            >
              CSV
            </Button>
            <Money paise={data.closing} signed className="text-lead" />
          </div>
        }
      >
        {data.ledgerName}
      </SectionTitle>
      <Panel>
        <div className="flex justify-between border-b border-line px-4 py-2 text-small text-muted">
          <span>
            Opening balance · <Money paise={data.opening} signed />
          </span>
          <span>
            {toDisplayDate(from)} → {toDisplayDate(to)}
          </span>
        </div>
        {isLoading ? (
          <SkeletonRows />
        ) : mode !== 'detail' ? (
          periods.length === 0 ? (
            <EmptyState title="No entries for this ledger in the period" />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>{summaryHeading}</th>
                  <th className="r w-36">Debit</th>
                  <th className="r w-36">Credit</th>
                  <th className="r w-40">Closing</th>
                </tr>
              </thead>
              <tbody data-testid="rows-ledger-statement-summary">
                {periods.map((m) => (
                  <tr key={m.period}>
                    <td>{m.label}</td>
                    <td className="r">
                      <Money paise={m.debit} />
                    </td>
                    <td className="r">
                      <Money paise={m.credit} />
                    </td>
                    <td className="r">
                      <Money paise={m.closing} signed />
                    </td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td>Closing balance</td>
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
          )
        ) : rows.length === 0 ? (
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
                      Show 500 more ({remaining.toLocaleString('en-IN')} more in this period)
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
