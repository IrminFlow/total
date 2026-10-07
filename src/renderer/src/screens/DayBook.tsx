import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Badge, Chip, Page, PageHeader, Panel } from '../components/ui'
import { OptionChoice, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns, type DataTableFooterContext } from '../components/table'
import { toDisplayDate } from '@shared/dates'
import type { DayBookRow } from '@shared/reports'
import { printKindForVoucherKind } from '@shared/printTemplates'
import { LedgerLink } from '../components/links'

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

/** Totals stay honest: only in-books rows (never optional/PDC) count, whatever the scope shows. */
const inBooks = (r: DayBookRow): boolean => !r.isOptional && !r.postDated
const badge = (r: DayBookRow): string =>
  (r.isOptional ? ' [Optional]' : r.postDated ? ' [PDC]' : '') + (r.yearEndClose ? ' [Year-end closing entry]' : '')

export const DAYBOOK_COLUMNS = defineColumns<DayBookRow>([
  {
    id: 'date',
    header: 'Date',
    kind: 'date',
    value: (r) => r.date,
    className: 'text-muted',
    hideable: false,
    groupKey: (r) => monthLabel(r.date.slice(0, 7))
  },
  { id: 'type', header: 'Type', kind: 'text', value: (r) => r.voucherType, className: 'text-muted', width: 130 },
  { id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, className: 'num text-muted', width: 100, groupable: false },
  {
    id: 'account',
    header: 'Account',
    kind: 'text',
    value: (r) => r.account,
    text: (r) => `${r.account}${badge(r)}`,
    minWidth: 160,
    // The row opens the voucher; only the account NAME drills to the ledger's edit window.
    cell: (r) => (
      <>
        <LedgerLink ledgerId={r.accountLedgerId} name={r.account} />
        {r.isOptional && (
          <Badge tone="amber" className="ml-2">
            Optional
          </Badge>
        )}
        {r.postDated && (
          <Badge tone="info" className="ml-2">
            PDC
          </Badge>
        )}
        {r.yearEndClose && (
          <Badge tone="info" className="ml-2" testId="daybook-year-end-chip">
            Year-end closing entry
          </Badge>
        )}
      </>
    )
  },
  { id: 'narration', header: 'Narration', kind: 'text', value: (r) => r.narration ?? '', className: 'text-muted', groupable: false },
  {
    id: 'debit',
    header: 'Debit',
    kind: 'money',
    value: (r) => r.debit,
    width: 140,
    aggregate: (rows) => rows.filter(inBooks).reduce((s, r) => s + r.debit, 0)
  },
  {
    id: 'credit',
    header: 'Credit',
    kind: 'money',
    value: (r) => r.credit,
    width: 140,
    aggregate: (rows) => rows.filter(inBooks).reduce((s, r) => s + r.credit, 0)
  }
])

/** "Total (in books) · 12 vouchers" — the count is of rows that reach the books, out of the rows
 *  in view (filters and the quick filter applied). The table lays the row out (label spanning the
 *  columns before the first total, sums under Debit / Credit). */
function dayBookTotalsLabel({ rows }: DataTableFooterContext<DayBookRow>): string {
  const bookCount = rows.filter(inBooks).length
  return `Total${bookCount !== rows.length ? ' (in books)' : ''} · ${bookCount} vouchers`
}

export function DayBook({ month, kind }: { month?: string; kind?: string } = {}): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  // Scope is a saved screen option (Options drawer, F12); a non-default scope shows as a chip.
  const opts = useScreenOptions('daybook', { scope: 'books' as Scope }, { scope: SCOPE_LABELS.map((s) => s.value) })
  const scope = opts.options.scope
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

  // Scope + Registers drill are screen-level pre-filters; everything else is the table's view.
  const rows = useMemo(() => {
    let all = data ?? []
    if (scope === 'books') all = all.filter(inBooks)
    else if (scope === 'optional') all = all.filter((r) => r.isOptional)
    else if (scope === 'post-dated') all = all.filter((r) => r.postDated)
    if (drill.month) all = all.filter((r) => r.date.startsWith(drill.month!))
    if (drill.kind) all = all.filter((r) => r.kind === drill.kind)
    return all
  }, [data, scope, drill])

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`

  const scopeLabel = SCOPE_LABELS.find((x) => x.value === scope)?.label ?? ''

  return (
    <Page width="wide">
      <PageHeader
        title="Day book"
        period={periodLabel}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod />
              <OptionChoice
                label="Show"
                value={scope}
                options={SCOPE_LABELS}
                onChange={(v) => opts.set('scope', v)}
                testId="input-daybook-scope"
              />
              <div className="mt-5">
                <OptionsTable area="daybook" />
              </div>
            </>
          )
        }}
      />
      {(scope !== 'books' || drill.month || drill.kind) && (
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="daybook-filters">
          {scope !== 'books' && (
            <Chip onRemove={() => opts.set('scope', 'books')} removeLabel={`Show in-books vouchers only (now: ${scopeLabel})`} testId="daybook-scope-chip">
              {scopeLabel}
            </Chip>
          )}
          {(drill.month || drill.kind) && (
            <>
              <span className="flex items-center gap-1.5 rounded-full border border-amberbar/50 bg-amberbar/10 py-0.5 pr-1 pl-2.5 text-small">
                {drill.month ? monthLabel(drill.month) : null}
                {drill.month && drill.kind ? ' · ' : ''}
                {drill.kind ? <span className="capitalize">{drill.kind.replace('_', ' ')}</span> : null}
                <button
                  type="button"
                  data-testid="daybook-clear-drill"
                  aria-label="Clear the month/kind filter"
                  className="rounded-full px-1 text-muted hover:text-ink"
                  onClick={() => setDrill({})}
                >
                  ✕
                </button>
              </span>
              <span className="text-hint text-muted">Filtered from Registers</span>
            </>
          )}
        </div>
      )}
      <Panel>
        <DataTable
          viewId="daybook"
          legacyReportKey="daybook"
          testId="daybook"
          ariaLabel="Day book"
          columns={DAYBOOK_COLUMNS}
          rows={rows}
          rowKey={(r) => r.voucherId}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
          loading={isLoading}
          empty={{
            title: scope === 'books' ? 'No entries in this period' : `No ${scope === 'all' ? '' : scope + ' '}vouchers in this period`,
            hint: 'Press V for voucher entry'
          }}
          onRowActivate={(r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
          trailing={(r) =>
            printKindForVoucherKind(r.kind) ? (
              <button
                type="button"
                className="text-hint text-blue hover:underline"
                title={r.kind === 'sales' ? 'Invoice PDF' : 'Print PDF (default template for this kind)'}
                data-testid="btn-daybook-invoice-pdf"
                onClick={() => {
                  api.invoice.pdf(r.voucherId).catch((err: Error) => toast.push('error', err.message))
                }}
              >
                PDF
              </button>
            ) : null
          }
          trailingWidth={56}
          totalsLabel={dayBookTotalsLabel}
          exportOptions={{ title: 'Day book', periodLabel, filename: 'day-book', totalsLabel: 'Total (in books)' }}
        />
      </Panel>
    </Page>
  )
}
