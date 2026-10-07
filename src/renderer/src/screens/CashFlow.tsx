import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle } from '../components/ui'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { CashFlowRow } from '@shared/reportMath'

function Section({ title, rows, total, leadRow }: {
  title: string
  rows: CashFlowRow[]
  total: number
  leadRow?: { name: string; amount: number }
}): React.JSX.Element {
  return (
    <>
      <tr className="total-row">
        <td colSpan={2}>{title}</td>
      </tr>
      {leadRow && (
        <tr>
          <td className="pl-6">{leadRow.name}</td>
          <td className="r">
            <Money paise={leadRow.amount} />
          </td>
        </tr>
      )}
      {rows.map((r) => (
        <tr key={r.name}>
          <td className="pl-6">{r.name}</td>
          <td className="r">
            <Money paise={r.amount} />
          </td>
        </tr>
      ))}
      <tr className="font-medium">
        <td>Net cash from {title.toLowerCase()}</td>
        <td className="r">
          <Money paise={total} />
        </td>
      </tr>
    </>
  )
}

export function CashFlowScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const { data } = useQuery({ queryKey: ['cashFlow', from, to], queryFn: () => api.reports.cashFlow(from, to) })

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const hasAnything =
    data && (data.netProfit !== 0 || data.operating.length > 0 || data.investing.length > 0 || data.financing.length > 0 || data.netChange !== 0)

  const exportColumns: PdfColumn[] = [
    { label: 'Particulars', align: 'l' },
    { label: 'Amount', align: 'r' }
  ]
  const money = (p: number): string => formatPaise(p, { zeroDash: false })
  const exportRows: PdfRow[] = data
    ? [
        { cells: ['Operating activities', ''], bold: true },
        { cells: ['Net profit', money(data.netProfit)], indent: 1 },
        ...data.operating.map((r) => ({ cells: [r.name, money(r.amount)], indent: 1 })),
        { cells: ['Net cash from operating activities', money(data.operatingTotal)], bold: true, rule: true },
        { cells: ['Investing activities', ''], bold: true },
        ...data.investing.map((r) => ({ cells: [r.name, money(r.amount)], indent: 1 })),
        { cells: ['Net cash from investing activities', money(data.investingTotal)], bold: true, rule: true },
        { cells: ['Financing activities', ''], bold: true },
        ...data.financing.map((r) => ({ cells: [r.name, money(r.amount)], indent: 1 })),
        { cells: ['Net cash from financing activities', money(data.financingTotal)], bold: true, rule: true },
        { cells: ['Net change in cash', money(data.netChange)], bold: true },
        { cells: ['Opening cash & bank', money(data.openingCash)] },
        { cells: ['Closing cash & bank', money(data.closingCash)], bold: true }
      ]
    : []

  return (
    <div className="mx-auto max-w-3xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <span className="num text-small text-muted">{periodLabel}</span>
            <Button
              variant="ghost"
              data-testid="cash-flow-pdf"
              onClick={() =>
                void printReport({ title: 'Cash flow statement', periodLabel, columns: exportColumns, rows: exportRows }, toast)
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              data-testid="cash-flow-csv"
              onClick={() =>
                void csvReport(exportColumns.map((c) => c.label), exportRows.map((r) => r.cells), 'cash-flow', toast)
              }
            >
              CSV
            </Button>
          </div>
        }
      >
        Cash flow statement
      </SectionTitle>
      <Panel>
        {!data || !hasAnything ? (
          <EmptyState title="No cash movement in this period" hint="Post vouchers, then come back" />
        ) : (
          <table className="ledger-table" data-testid="cash-flow-table">
            <tbody>
              <Section
                title="Operating activities"
                rows={data.operating}
                total={data.operatingTotal}
                leadRow={{ name: 'Net profit', amount: data.netProfit }}
              />
              <Section title="Investing activities" rows={data.investing} total={data.investingTotal} />
              <Section title="Financing activities" rows={data.financing} total={data.financingTotal} />
              <tr className="total-row">
                <td>Net change in cash</td>
                <td className="r">
                  <Money paise={data.netChange} />
                </td>
              </tr>
              <tr>
                <td className="text-muted">Opening cash &amp; bank</td>
                <td className="r">
                  <Money paise={data.openingCash} />
                </td>
              </tr>
              <tr className="font-medium">
                <td>Closing cash &amp; bank</td>
                <td className="r">
                  <Money paise={data.closingCash} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
