import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle } from '../components/ui'
import { ReportConfigButton } from '../components/ReportConfigButton'
import { useReportConfig, type ReportColumn } from '../lib/reportConfig'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'

function fmtQty(qtyMilli: number, decimals: number): string {
  return (qtyMilli / 1000).toFixed(decimals)
}

const COLUMNS: ReportColumn[] = [
  { key: 'inwards', label: 'Inwards', defaultOn: true },
  { key: 'outwards', label: 'Outwards', defaultOn: true },
  { key: 'closingQty', label: 'Closing qty', defaultOn: true },
  { key: 'closingValue', label: 'Closing value', defaultOn: true }
]

export function StockSummaryScreen(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const { data } = useQuery({ queryKey: ['stockSummary', to], queryFn: () => api.reports.stockSummary(to) })
  const rows = data ?? []
  const { visible, toggle } = useReportConfig('stock-summary', COLUMNS)

  const exportColumns: PdfColumn[] = [
    { label: 'Item', align: 'l' },
    ...(visible.inwards ? [{ label: 'Inwards', align: 'r' as const }] : []),
    ...(visible.outwards ? [{ label: 'Outwards', align: 'r' as const }] : []),
    ...(visible.closingQty ? [{ label: 'Closing qty', align: 'r' as const }] : []),
    ...(visible.closingValue ? [{ label: 'Closing value', align: 'r' as const }] : [])
  ]
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        r.name,
        ...(visible.inwards ? [`${fmtQty(r.inwardQtyMilli, r.decimals)} ${r.unitSymbol}`] : []),
        ...(visible.outwards ? [`${fmtQty(r.outwardQtyMilli, r.decimals)} ${r.unitSymbol}`] : []),
        ...(visible.closingQty ? [`${fmtQty(r.closingQtyMilli, r.decimals)} ${r.unitSymbol}`] : []),
        ...(visible.closingValue ? [formatPaise(r.closingValue, { zeroDash: true })] : [])
      ]
    })),
    {
      cells: [
        'Total',
        ...(visible.inwards ? [''] : []),
        ...(visible.outwards ? [''] : []),
        ...(visible.closingQty ? [''] : []),
        ...(visible.closingValue ? [formatPaise(rows.reduce((s, r) => s + r.closingValue, 0), { zeroDash: true })] : [])
      ],
      bold: true,
      rule: true
    }
  ]
  const periodLabel = `as on ${toDisplayDate(to)}`

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <span className="num text-[12px] text-muted">as on {toDisplayDate(to)}</span>
            <ReportConfigButton columns={COLUMNS} visible={visible} toggle={toggle} />
            <Button
              variant="ghost"
              onClick={() =>
                void printReport({ title: 'Stock summary', periodLabel, columns: exportColumns, rows: exportRows }, toast)
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void csvReport(exportColumns.map((c) => c.label), exportRows.map((r) => r.cells), 'stock-summary', toast)
              }
            >
              CSV
            </Button>
          </div>
        }
      >
        Stock summary
      </SectionTitle>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No stock items yet" hint="Create items under Masters, or straight from a sales/purchase voucher" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Item</th>
                {visible.inwards && <th className="r w-32">Inwards</th>}
                {visible.outwards && <th className="r w-32">Outwards</th>}
                {visible.closingQty && <th className="r w-32">Closing qty</th>}
                {visible.closingValue && <th className="r w-40">Closing value</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.stockItemId} className={r.closingQtyMilli < 0 ? 'text-cr' : ''}>
                  <td>
                    {r.name}
                    {r.closingQtyMilli < 0 && <span className="ml-2 text-[11px]">— negative stock, check entries</span>}
                  </td>
                  {visible.inwards && (
                    <td className="r num">
                      {fmtQty(r.inwardQtyMilli, r.decimals)} {r.unitSymbol}
                    </td>
                  )}
                  {visible.outwards && (
                    <td className="r num">
                      {fmtQty(r.outwardQtyMilli, r.decimals)} {r.unitSymbol}
                    </td>
                  )}
                  {visible.closingQty && (
                    <td className="r num">
                      {fmtQty(r.closingQtyMilli, r.decimals)} {r.unitSymbol}
                    </td>
                  )}
                  {visible.closingValue && (
                    <td className="r">
                      <Money paise={r.closingValue} />
                    </td>
                  )}
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={1 + (visible.inwards ? 1 : 0) + (visible.outwards ? 1 : 0) + (visible.closingQty ? 1 : 0)}>
                  Total
                </td>
                {visible.closingValue && (
                  <td className="r">
                    <Money paise={rows.reduce((s, r) => s + r.closingValue, 0)} />
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
