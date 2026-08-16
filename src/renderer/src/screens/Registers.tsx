import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, SkeletonRows } from '../components/ui'
import { TabBar } from '../components/TabBar'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const EXPORT_COLUMNS: PdfColumn[] = [
  { label: 'Month', align: 'l' },
  { label: 'Vouchers', align: 'r' },
  { label: 'Taxable value', align: 'r' },
  { label: 'GST', align: 'r' },
  { label: 'Invoice total', align: 'r' }
]

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[m - 1]} ${y}`
}

export function RegistersScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const [kind, setKind] = useState<'sales' | 'purchase'>('sales')
  const [busy, setBusy] = useState<'caPack' | 'tallyXml' | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['register', kind, from, to],
    queryFn: () => api.analysis.register(kind, from, to)
  })
  const rows = data ?? []

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        monthLabel(r.month),
        String(r.vouchers),
        formatPaise(r.taxable, { zeroDash: true }),
        formatPaise(r.tax, { zeroDash: true }),
        formatPaise(r.total, { zeroDash: true })
      ]
    })),
    {
      cells: [
        'Total',
        String(rows.reduce((s, r) => s + r.vouchers, 0)),
        formatPaise(rows.reduce((s, r) => s + r.taxable, 0), { zeroDash: true }),
        formatPaise(rows.reduce((s, r) => s + r.tax, 0), { zeroDash: true }),
        formatPaise(rows.reduce((s, r) => s + r.total, 0), { zeroDash: true })
      ],
      bold: true,
      rule: true
    }
  ]

  const runExport = async (which: 'caPack' | 'tallyXml'): Promise<void> => {
    setBusy(which)
    try {
      const r = which === 'caPack' ? await api.exporter.caPack(from, to) : await api.exporter.tallyXml(from, to)
      toast.push('success', `Saved to ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <TabBar
              screen="registers"
              tabs={[
                { id: 'sales', label: 'Sales' },
                { id: 'purchase', label: 'Purchase' }
              ]}
              active={kind}
              onSelect={setKind}
            />
            <Button
              variant="ghost"
              onClick={() =>
                void printReport(
                  { title: kind === 'sales' ? 'Sales register' : 'Purchase register', periodLabel, columns: EXPORT_COLUMNS, rows: exportRows },
                  toast
                )
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void csvReport(EXPORT_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), `${kind}-register`, toast)
              }
            >
              CSV
            </Button>
            <Button disabled={busy !== null} onClick={() => void runExport('tallyXml')}>
              Tally XML
            </Button>
            <Button variant="primary" data-testid="btn-registers-ca-pack" disabled={busy !== null} onClick={() => void runExport('caPack')}>
              CA pack…
            </Button>
          </div>
        }
      >
        {kind === 'sales' ? 'Sales register' : 'Purchase register'}
      </SectionTitle>
      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState title={`No ${kind} vouchers in this period`} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="r w-24">Vouchers</th>
                <th className="r w-40">Taxable value</th>
                <th className="r w-36">GST</th>
                <th className="r w-40">Invoice total</th>
              </tr>
            </thead>
            <tbody data-testid="rows-registers">
              {rows.map((r) => (
                <tr key={r.month}>
                  <td>{monthLabel(r.month)}</td>
                  <td className="r num">{r.vouchers}</td>
                  <td className="r"><Money paise={r.taxable} /></td>
                  <td className="r"><Money paise={r.tax} /></td>
                  <td className="r"><Money paise={r.total} /></td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="r num">{rows.reduce((s, r) => s + r.vouchers, 0)}</td>
                <td className="r"><Money paise={rows.reduce((s, r) => s + r.taxable, 0)} /></td>
                <td className="r"><Money paise={rows.reduce((s, r) => s + r.tax, 0)} /></td>
                <td className="r"><Money paise={rows.reduce((s, r) => s + r.total, 0)} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
