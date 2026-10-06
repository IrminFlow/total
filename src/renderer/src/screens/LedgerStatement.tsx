import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Button, Money, Panel, SectionTitle, SkeletonRows } from '../components/ui'
import { TabBar } from '../components/TabBar'
import { DataTable, defineColumns, type TableColumn } from '../components/table'
import { slugFilename } from '../lib/reportExport'
import { toDisplayDate } from '@shared/dates'
import type { LedgerMonthRow, LedgerStatementRow } from '@shared/reports'
import { FirstLedgerLink, VoucherLink } from '../components/links'
import { groupAncestryNames } from '../components/LedgerFormModal'
import { useGroups, useLedgers } from '../components/pickers'
import { openLedgerEdit, useCanEditMasters } from '../lib/drill'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`
}

type Mode = 'detail' | 'monthly'

const MODE_TABS: { id: Mode; label: string }[] = [
  { id: 'detail', label: 'Vouchers' },
  { id: 'monthly', label: 'Monthly' }
]

/**
 * The balance column is a running balance — never summed. Its footer shows the ledger's
 * closing balance, but only while the view holds every row (a filtered view has no honest
 * closing figure). Group subtotals never show it unless one group holds every row.
 */
function closingAggregate<Row>(allCount: number, closing: number): (rows: Row[]) => number | null {
  return (rows) => (rows.length === allCount ? closing : null)
}

export function statementColumns(allCount: number, closing: number): TableColumn<LedgerStatementRow>[] {
  return defineColumns<LedgerStatementRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted', groupKey: (r) => monthLabel(r.date.slice(0, 7)) },
    {
      id: 'particulars',
      header: 'Particulars',
      kind: 'text',
      value: (r) => r.particulars,
      hideable: false,
      minWidth: 160,
      // The row opens the voucher; the counter-ledger NAME opens that ledger's edit window.
      cell: (r) => <FirstLedgerLink ledgerId={r.particularsLedgerId} text={r.particulars} />
    },
    {
      id: 'voucher',
      header: 'Type · No.',
      kind: 'text',
      value: (r) => `${r.voucherType} ${r.number}`,
      groupKey: (r) => r.voucherType,
      className: 'num text-[12px] text-muted',
      width: 150,
      cell: (r) => <VoucherLink voucherId={r.voucherId} label={`${r.voucherType} ${r.number}`} />
    },
    { id: 'narration', header: 'Narration', kind: 'text', value: (r) => r.narration ?? '', className: 'text-muted', defaultHidden: true, groupable: false },
    { id: 'debit', header: 'Debit', kind: 'money', value: (r) => r.debit, aggregate: 'sum', width: 140 },
    { id: 'credit', header: 'Credit', kind: 'money', value: (r) => r.credit, aggregate: 'sum', width: 140 },
    { id: 'balance', header: 'Balance', kind: 'money', signed: true, value: (r) => r.running, aggregate: closingAggregate(allCount, closing), width: 160 }
  ])
}

export function monthlyColumns(allCount: number, closing: number): TableColumn<LedgerMonthRow>[] {
  return defineColumns<LedgerMonthRow>([
    // 'YYYY-MM' sorts chronologically as text; shown as "Apr 2026".
    { id: 'month', header: 'Month', kind: 'text', value: (m) => m.month, text: (m) => monthLabel(m.month), hideable: false, groupable: false },
    { id: 'debit', header: 'Debit', kind: 'money', value: (m) => m.debit, aggregate: 'sum', width: 150 },
    { id: 'credit', header: 'Credit', kind: 'money', value: (m) => m.credit, aggregate: 'sum', width: 150 },
    { id: 'closing', header: 'Closing', kind: 'money', signed: true, value: (m) => m.closing, aggregate: closingAggregate(allCount, closing), width: 170 }
  ])
}

export function LedgerStatementScreen({ ledgerId }: { ledgerId: number }): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  // Columnar month mode (v0.3 #55): one row per month with period totals + closing balance.
  const [mode, setMode] = useState<Mode>('detail')
  const { data, isLoading } = useQuery({
    queryKey: ['ledgerStatement', ledgerId, from, to, mode],
    queryFn: () => api.reports.ledger(ledgerId, from, to, mode === 'monthly' ? 'month' : undefined)
  })

  const rows = data?.rows ?? []
  const months = data?.months ?? []
  const closing = data?.closing ?? 0
  const detailCols = useMemo(() => statementColumns(rows.length, closing), [rows.length, closing])
  const monthCols = useMemo(() => monthlyColumns(months.length, closing), [months.length, closing])
  const canEdit = useCanEditMasters()
  // Group breadcrumb (root → own group), e.g. "Current Assets › Sundry Debtors".
  const ledgers = useLedgers()
  const groups = useGroups()
  const groupId = ledgers.find((l) => l.id === ledgerId)?.groupId
  const breadcrumb = groupId != null && groups.length ? groupAncestryNames(groupId, groups).reverse() : []

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
  const filename = `ledger-${slugFilename(data.ledgerName)}${mode === 'monthly' ? '-monthly' : ''}`
  const empty = { title: 'No entries for this ledger in the period' }

  return (
    <div className="mx-auto max-w-5xl">
      {breadcrumb.length > 0 && (
        <nav className="mb-0.5 text-[11.5px] text-muted" aria-label="Ledger group" data-testid="ledger-statement-breadcrumb">
          {breadcrumb.join(' › ')}
        </nav>
      )}
      <SectionTitle
        right={
          <div className="flex items-center gap-3">
            <TabBar screen="ledger-statement" tabs={MODE_TABS} active={mode} onSelect={setMode} />
            {canEdit && (
              <Button data-testid="btn-statement-edit-ledger" title="Edit this ledger (⌘E)" onClick={() => openLedgerEdit(ledgerId)}>
                Edit
              </Button>
            )}
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
          <span>{periodLabel}</span>
        </div>
        {mode === 'monthly' ? (
          <DataTable
            key="monthly"
            viewId="ledger-statement-monthly"
            testId="ledger-statement-monthly"
            ariaLabel={`${data.ledgerName} by month`}
            columns={monthCols}
            rows={months}
            rowKey={(m) => m.month}
            rowAttrs={(m) => ({ 'data-row-id': m.month })}
            loading={isLoading}
            empty={empty}
            totalsLabel="Closing balance"
            exportOptions={{ title: data.ledgerName, periodLabel, filename }}
          />
        ) : (
          <DataTable
            key="detail"
            viewId="ledger-statement"
            testId="ledger-statement"
            ariaLabel={`${data.ledgerName} statement`}
            columns={detailCols}
            rows={rows}
            // A voucher can post to this ledger on several lines — the row index keeps keys unique.
            rowKey={(_r, i) => i}
            rowAttrs={(r) => ({ 'data-row-id': r.voucherId || undefined })}
            loading={isLoading}
            empty={empty}
            isRowActivatable={(r) => r.voucherId > 0}
            onRowActivate={(r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
            totalsLabel="Closing balance"
            exportOptions={{ title: data.ledgerName, periodLabel, filename }}
          />
        )}
      </Panel>
    </div>
  )
}
