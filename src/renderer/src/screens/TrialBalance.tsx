import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, useKeyNav } from '../components/ui'
import { ReportConfigButton } from '../components/ReportConfigButton'
import { useReportConfig, type ReportColumn } from '../lib/reportConfig'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'

const COLUMNS: ReportColumn[] = [
  { key: 'debit', label: 'Debit', defaultOn: true },
  { key: 'credit', label: 'Credit', defaultOn: true }
]

export function TrialBalanceScreen(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const { data } = useQuery({ queryKey: ['trialBalance', to], queryFn: () => api.reports.trialBalance(to) })
  const rows = data?.rows ?? []
  const { active, setActive } = useKeyNav(rows.length, (i) => {
    const r = rows[i]
    if (r && r.ledgerId > 0) nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })
  })
  const { visible, toggle } = useReportConfig('trial-balance', COLUMNS)

  const matched = data && data.totalDebit === data.totalCredit

  const exportColumns: PdfColumn[] = [
    { label: 'Ledger', align: 'l' },
    { label: 'Group', align: 'l' },
    ...(visible.debit ? [{ label: 'Debit', align: 'r' as const }] : []),
    ...(visible.credit ? [{ label: 'Credit', align: 'r' as const }] : [])
  ]
  const exportRows: PdfRow[] = [
    ...rows.map((r) => ({
      cells: [
        r.ledgerName,
        r.groupName,
        ...(visible.debit ? [formatPaise(r.debit, { zeroDash: true })] : []),
        ...(visible.credit ? [formatPaise(r.credit, { zeroDash: true })] : [])
      ]
    })),
    {
      cells: [
        'Total',
        '',
        ...(visible.debit ? [formatPaise(data?.totalDebit ?? 0, { zeroDash: true })] : []),
        ...(visible.credit ? [formatPaise(data?.totalCredit ?? 0, { zeroDash: true })] : [])
      ],
      bold: true,
      rule: true
    }
  ]

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
                void printReport(
                  { title: 'Trial balance', periodLabel: `as on ${toDisplayDate(to)}`, columns: exportColumns, rows: exportRows },
                  toast
                )
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void csvReport(exportColumns.map((c) => c.label), exportRows.map((r) => r.cells), 'trial-balance', toast)
              }
            >
              CSV
            </Button>
          </div>
        }
      >
        Trial balance
      </SectionTitle>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No balances yet" hint="Enter a voucher or set opening balances" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Ledger</th>
                <th>Group</th>
                {visible.debit && <th className="r w-40">Debit</th>}
                {visible.credit && <th className="r w-40">Credit</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.ledgerId}
                  data-active={i === active}
                  className="kbar-row cursor-pointer"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => r.ledgerId > 0 && nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
                >
                  <td>{r.ledgerName}</td>
                  <td className="text-muted">{r.groupName}</td>
                  {visible.debit && (
                    <td className="r">
                      <Money paise={r.debit} />
                    </td>
                  )}
                  {visible.credit && (
                    <td className="r">
                      <Money paise={r.credit} />
                    </td>
                  )}
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={2}>Total {matched ? '' : '— debits and credits differ; check opening balances'}</td>
                {visible.debit && (
                  <td className="r">
                    <Money paise={data?.totalDebit ?? 0} />
                  </td>
                )}
                {visible.credit && (
                  <td className="r">
                    <Money paise={data?.totalCredit ?? 0} />
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
