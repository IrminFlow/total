import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  AmountInput,
  Button,
  EmptyState,
  Field,
  Modal,
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
import type { KhataParty } from '@shared/reports'
import { csvReport, printReport } from '../lib/reportExport'
import { StatementModal } from './Collections'
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
  const [noting, setNoting] = useState<KhataParty | null>(null)
  const [statement, setStatement] = useState<KhataParty | null>(null)

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
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
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
                  className={`rounded-md px-2.5 py-1 text-small ${side === s ? 'bg-accentbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'}`}
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

      <FollowUpList />

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
                <th scope="col" className="w-56" />
              </tr>
            </thead>
            <tbody data-testid="rows-khata">
              {rows.map((p, i) => (
                <KhataRow
                  key={p.ledgerId}
                  party={p}
                  side={side}
                  rowProps={table.rowProps(i, p)}
                  onNote={() => setNoting(p)}
                  onStatement={() => setStatement(p)}
                />
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
      {noting && <NotesModal party={noting} onClose={() => setNoting(null)} />}
      {statement && (
        <StatementModal
          ledgerId={statement.ledgerId}
          name={statement.name}
          side={side}
          onClose={() => setStatement(null)}
        />
      )}

      <p className="mt-2 text-hint text-muted">
        Sorted by how overdue they are, not by size — the largest debtor is usually the one who
        always pays. Enter opens the party&rsquo;s ledger.
      </p>
    </div>
  )
}

function KhataRow({
  party,
  side,
  rowProps,
  onNote,
  onStatement
}: {
  party: KhataParty
  side: 'receivable' | 'payable'
  rowProps: ReturnType<ReturnType<typeof useTableNav<KhataParty>>['rowProps']>
  onNote: () => void
  onStatement: () => void
}): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()

  /**
   * Ask main for this party's reminder rather than composing one here.
   *
   * The message has to list the bills, grouped by ageing band, at whatever tone the oldest one
   * earns — and only main knows which bills are open. This screen used to build the text locally
   * with an empty bill list, which sent a reminder that named no invoices at all.
   */
  const remind = async (): Promise<void> => {
    try {
      const rows = await api.receivables.reminders(side, to, { minOverdueDays: 0 })
      const mine = rows.find((r) => r.ledgerId === party.ledgerId)
      if (!mine?.whatsapp) {
        toast.push('error', `No usable phone number for ${party.name}`)
        return
      }
      window.open(mine.whatsapp, '_blank')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
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
      <td onClick={(e) => e.stopPropagation()} className="whitespace-nowrap">
        <Button
          variant="ghost"
          className="whitespace-nowrap"
          data-testid={`btn-khata-note-${party.ledgerId}`}
          onClick={onNote}
          title="What was said, and what was promised"
        >
          Note
        </Button>
        <Button
          variant="ghost"
          className="whitespace-nowrap"
          data-testid={`btn-khata-statement-${party.ledgerId}`}
          onClick={onStatement}
          title="Statement of account, printable and sendable"
        >
          Statement
        </Button>
        {party.phone && (
          <Button
            variant="ghost"
            className="whitespace-nowrap"
            data-testid={`btn-khata-remind-${party.ledgerId}`}
            onClick={() => void remind()}
          >
            Remind
          </Button>
        )}
      </td>
    </tr>
  )
}

/**
 * Open promises, most overdue first — the morning's calls.
 *
 * A broken promise sorts above one still in the future, which is the order the calls actually go
 * in. Promises still to come are included rather than hidden: knowing four people have promised
 * this week is the point of writing them down.
 *
 * Renders nothing when nobody has promised anything, because an empty follow-up list on a screen
 * someone opens daily is a panel they learn to skip past.
 */
function FollowUpList(): React.JSX.Element | null {
  const nav = useNav()
  const queryClient = useQueryClient()
  const toast = useToasts()
  const { data } = useQuery({ queryKey: ['promises'], queryFn: api.analysis.promises })
  const rows = data ?? []
  if (rows.length === 0) return null

  const close = async (id: number): Promise<void> => {
    try {
      await api.analysis.closeNote(id)
      await queryClient.invalidateQueries({ queryKey: ['promises'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="mb-3 p-3" data-testid="follow-up-list">
      <p className="mb-1.5 text-body-sm font-medium">
        Promised to pay — {rows.length} open
      </p>
      <div className="flex flex-col gap-1">
        {rows.map((p) => (
          <div key={p.id} className="flex items-baseline gap-2 text-body-sm">
            <button
              className="text-blue hover:underline"
              onClick={() => nav.go({ name: 'ledger-statement', ledgerId: p.ledgerId })}
            >
              {p.partyName}
            </button>
            <span className={p.overdueDays > 0 ? 'text-cr' : 'text-muted'}>
              {p.overdueDays > 0
                ? `${p.overdueDays}d overdue`
                : p.overdueDays === 0
                  ? 'today'
                  : `in ${-p.overdueDays}d`}
            </span>
            {p.promisedAmount != null && <Money paise={p.promisedAmount} className="text-detail" />}
            <span className="min-w-0 flex-1 truncate text-hint text-muted">{p.note}</span>
            <button
              className="shrink-0 text-hint text-muted hover:text-ink"
              data-testid={`btn-close-promise-${p.id}`}
              title="Settled, or written off"
              onClick={() => void close(p.id)}
            >
              Done
            </button>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/**
 * The call log for one party.
 *
 * Chasing money is a conversation, and the app remembered none of it: "he said he'd pay on the
 * 20th" lived in someone's head, so the next call started from nothing.
 *
 * A promise is a note with a date on it. A party can promise more than once, and a promise made
 * and broken is exactly what the next call needs to know — so nothing is overwritten and nothing
 * is deleted.
 */
function NotesModal({ party, onClose }: { party: KhataParty; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const [promisedDate, setPromisedDate] = useState('')
  const [promisedAmount, setPromisedAmount] = useState<number | null>(null)
  const { data } = useQuery({
    queryKey: ['partyNotes', party.ledgerId],
    queryFn: () => api.analysis.notes(party.ledgerId)
  })

  const save = async (): Promise<void> => {
    if (!note.trim()) return void toast.push('error', 'Write what was said')
    try {
      await api.analysis.addNote({
        ledgerId: party.ledgerId,
        note: note.trim(),
        promisedDate: promisedDate || null,
        promisedAmount
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['partyNotes', party.ledgerId] }),
        queryClient.invalidateQueries({ queryKey: ['promises'] })
      ])
      setNote('')
      setPromisedDate('')
      setPromisedAmount(null)
      toast.push('success', 'Noted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={party.name} onClose={onClose} dirty={note.trim().length > 0}>
      <div className="flex flex-col gap-3">
        <Field label="What was said">
          <TextInput
            data-testid="input-party-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Spoke to Ramesh — cheque on Friday"
            autoFocus
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Promised to pay on" hint="Leave blank for an ordinary note">
            <TextInput
              data-testid="input-promise-date"
              type="date"
              value={promisedDate}
              onChange={(e) => setPromisedDate(e.target.value)}
            />
          </Field>
          <Field label="Amount promised" hint="Blank means the balance, or nothing specific">
            <AmountInput paise={promisedAmount} onPaise={setPromisedAmount} testId="input-promise-amount" />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" data-testid="btn-save-party-note" onClick={() => void save()}>
            Save note
          </Button>
        </div>

        {data && data.length > 0 && (
          <div className="mt-2 border-t border-line pt-3" data-testid="party-note-list">
            <ol className="flex flex-col gap-2">
              {data.map((n) => (
                <li key={n.id} className="text-body-sm">
                  <span className="num text-hint text-muted">{n.at}</span>
                  <span className="text-hint text-muted"> · {n.userName ?? 'someone'}</span>
                  {n.promisedDate && (
                    <span className={`ml-2 text-hint ${n.closedAt ? 'text-muted' : 'text-accent'}`}>
                      promised {toDisplayDate(n.promisedDate)}
                      {n.promisedAmount != null && <> · <Money paise={n.promisedAmount} /></>}
                      {n.closedAt && ' (closed)'}
                    </span>
                  )}
                  <div>{n.note}</div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </Modal>
  )
}
