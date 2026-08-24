import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  Button,
  EmptyState,
  Money,
  Panel,
  SectionTitle,
  SkeletonRows,
  TextInput,
  useTableNav
} from '../components/ui'
import { useStickyFlag, useStickyTab } from '../lib/useStickyTab'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { buildReminder } from '@shared/outstanding'
import type { KhataParty } from '@shared/reports'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn } from '../lib/client'
import { useState } from 'react'

/**
 * The khata: every party on one page.
 *
 * "Who owes me, how much, how long, and can they take more" is the question a small business asks
 * every day, and answering it used to mean three screens — Outstandings for the amount, the
 * ledger statement for the balance, the party master for the credit limit.
 *
 * Sorted by what is overdue rather than by name or by size. The largest debtor is usually the one
 * who always pays; the one worth calling is the one who has not.
 */
const COLUMNS: PdfColumn[] = [
  { label: 'Party', align: 'l' },
  { label: 'Balance', align: 'r' },
  { label: 'Open bills', align: 'r' },
  { label: 'Oldest', align: 'r' },
  { label: 'Overdue by', align: 'r' },
  { label: 'Credit limit', align: 'r' },
  { label: 'Last paid', align: 'l' }
]

export function KhataScreen(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [side, setSide] = useStickyTab<'receivable' | 'payable'>(
    'khata-side',
    ['receivable', 'payable'],
    'receivable'
  )
  const [overdueOnly, setOverdueOnly] = useStickyFlag('khata-overdue-only', false)
  const [filter, setFilter] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['khata', side, to],
    queryFn: () => api.analysis.khata(side, to)
  })

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (data ?? [])
      .filter((p) => (overdueOnly ? p.worstOverdueDays > 0 : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      // Most overdue first, then largest — the one worth calling, not the one worth the most.
      .sort((a, b) => b.worstOverdueDays - a.worstOverdueDays || b.pending - a.pending)
  }, [data, overdueOnly, filter])

  const table = useTableNav(rows, {
    rowId: (p) => p.ledgerId,
    onEnter: (p) => nav.go({ name: 'ledger-statement', ledgerId: p.ledgerId })
  })

  const totalPending = rows.reduce((s, p) => s + p.pending, 0)
  const overdueCount = rows.filter((p) => p.worstOverdueDays > 0).length
  const overLimit = rows.filter((p) => p.creditUsed != null && p.creditUsed > 1)

  const exportRows = rows.map((p) => ({
    cells: [
      p.name,
      formatPaise(p.balance),
      String(p.billCount),
      p.oldestBillDays ? `${p.oldestBillDays}d` : '–',
      p.worstOverdueDays ? `${p.worstOverdueDays}d` : '–',
      p.creditLimit == null ? '–' : formatPaise(p.creditLimit),
      p.lastPaymentDate ? toDisplayDate(p.lastPaymentDate) : 'never'
    ]
  }))

  const title = side === 'receivable' ? 'Khata · who owes me' : 'Khata · who I owe'

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <div className="flex gap-1" role="group" aria-label="Khata side">
              {(['receivable', 'payable'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  data-testid={`tab-khata-${s}`}
                  aria-pressed={side === s}
                  onClick={() => setSide(s)}
                  className={`rounded-md px-2.5 py-1 text-small ${side === s ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'}`}
                >
                  {s === 'receivable' ? 'Receivable' : 'Payable'}
                </button>
              ))}
            </div>
            <TextInput
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Type to filter…"
              data-filter-box
              className="w-48"
            />
            <Button
              variant="ghost"
              data-testid="btn-khata-overdue-only"
              onClick={() => setOverdueOnly(!overdueOnly)}
            >
              {overdueOnly ? 'Show all' : 'Overdue only'}
            </Button>
            <Button
              variant="ghost"
              disabled={!rows.length}
              onClick={() =>
                void printReport(
                  {
                    title,
                    periodLabel: `as on ${toDisplayDate(to)}`,
                    columns: COLUMNS,
                    rows: exportRows,
                    filename: `khata-${side}`
                  },
                  toast
                )
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              disabled={!rows.length}
              onClick={() =>
                void csvReport(COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), `khata-${side}`, toast)
              }
            >
              CSV
            </Button>
          </div>
        }
      >
        {title}
      </SectionTitle>

      {overLimit.length > 0 && (
        <div
          className="mb-3 rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr"
          data-testid="khata-over-limit"
        >
          <b>{overLimit.length}</b> part{overLimit.length === 1 ? 'y is' : 'ies are'} over their credit
          limit: {overLimit.slice(0, 3).map((p) => p.name).join(', ')}
          {overLimit.length > 3 ? ` and ${overLimit.length - 3} more` : ''}.
        </div>
      )}

      <Panel scroll={{ maxH: '70vh' }}>
        {isLoading ? (
          <SkeletonRows rows={10} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={overdueOnly ? 'Nothing overdue' : side === 'receivable' ? 'Nobody owes you' : 'You owe nobody'}
            hint={overdueOnly ? 'Every open bill is still within its terms.' : undefined}
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Party</th>
                <th scope="col" className="r w-36">Balance</th>
                <th scope="col" className="r w-24">Bills</th>
                <th scope="col" className="r w-24">Oldest</th>
                <th scope="col" className="r w-28">Overdue by</th>
                <th scope="col" className="r w-40">Credit limit</th>
                <th scope="col" className="w-28">Last paid</th>
                <th scope="col" className="w-24" />
              </tr>
            </thead>
            <tbody data-testid="rows-khata">
              {rows.map((p, i) => (
                <KhataRow key={p.ledgerId} party={p} rowProps={table.rowProps(i, p)} />
              ))}
              <tr className="total-row">
                <td>Total · {rows.length} parties</td>
                <td className="r"><Money paise={rows.reduce((s, p) => s + p.balance, 0)} /></td>
                <td className="r num">{rows.reduce((s, p) => s + p.billCount, 0)}</td>
                <td colSpan={5} className="text-hint text-muted">
                  <Money paise={totalPending} /> open · {overdueCount} overdue
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Sorted by how overdue they are, not by size — the largest debtor is usually the one who
        always pays. Enter opens the party&rsquo;s ledger.
      </p>
    </div>
  )
}

function KhataRow({
  party,
  rowProps
}: {
  party: KhataParty
  rowProps: ReturnType<ReturnType<typeof useTableNav<KhataParty>>['rowProps']>
}): React.JSX.Element {
  const { info } = useSession()
  const toast = useToasts()

  // Built here rather than on the server: the reminder text is the same one the Outstandings
  // screen sends, so a party gets one message whichever screen it was sent from.
  const remind = (): void => {
    const reminder = buildReminder(
      { name: info?.name ?? 'We' },
      { name: party.name, email: party.email, phone: party.phone },
      []
    )
    if (!reminder.whatsapp) {
      toast.push('error', `No usable phone number for ${party.name}`)
      return
    }
    window.open(reminder.whatsapp, '_blank')
  }

  const over = party.creditUsed != null && party.creditUsed > 1

  return (
    <tr {...rowProps}>
      <td>{party.name}</td>
      <td className="r"><Money paise={party.balance} /></td>
      <td className="r num text-muted">{party.billCount || '–'}</td>
      <td className="r num text-muted">{party.oldestBillDays ? `${party.oldestBillDays}d` : '–'}</td>
      <td className={`r num ${party.worstOverdueDays > 0 ? 'text-cr font-semibold' : 'text-muted'}`}>
        {party.worstOverdueDays ? `${party.worstOverdueDays}d` : '–'}
      </td>
      <td className="r">
        {party.creditLimit == null ? (
          <span className="text-muted">–</span>
        ) : (
          <span className={over ? 'text-cr font-semibold' : ''}>
            <Money paise={party.creditLimit} />
            <span className="ml-1.5 text-hint">{Math.round((party.creditUsed ?? 0) * 100)}%</span>
          </span>
        )}
      </td>
      <td className="num text-muted">
        {party.lastPaymentDate ? toDisplayDate(party.lastPaymentDate) : 'never'}
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        {party.phone && (
          <Button
            variant="ghost"
            className="whitespace-nowrap"
            data-testid={`btn-khata-remind-${party.ledgerId}`}
            onClick={remind}
          >
            Remind
          </Button>
        )}
      </td>
    </tr>
  )
}
