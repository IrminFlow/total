import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type BulkReminderRow, type PartyStatement } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  Button,
  EmptyState,
  Modal,
  Money,
  Panel,
  SectionTitle,
  Select,
  SkeletonRows,
  useTableNav
} from '../components/ui'
import { useStickyNumber, useStickyTab } from '../lib/useStickyTab'
import { addDays, toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { csvReport, printReport } from '../lib/reportExport'

/**
 * The collections desk.
 *
 * Chasing money is its own job, and until now it was scattered: the ageing lived in Outstandings,
 * the balances in Khata, the reminder text nowhere. Each tab here answers one question a person
 * asks while working through a list of parties on a Tuesday morning — who to write to, who owes
 * interest, who can be trusted, whose money is sitting unallocated, what has to go out this month,
 * and what should honestly be provided against.
 *
 * Nothing on this screen posts anything. The provisioning tab produces a draft journal that opens
 * in the voucher form; every other tab produces text or a report.
 */
type Tab = 'reminders' | 'interest' | 'scores' | 'ageing' | 'advances' | 'schedule' | 'provision'

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'reminders', label: 'Reminders', hint: 'One message per overdue party, ready to send' },
  { id: 'interest', label: 'Interest', hint: 'What overdue bills have cost, at each party’s terms' },
  { id: 'scores', label: 'Credit scores', hint: 'How each customer has actually paid, historically' },
  { id: 'ageing', label: 'Ageing by', hint: 'The same ageing, grouped by who owns the relationship' },
  { id: 'advances', label: 'Advances', hint: 'Money on account that no bill has claimed' },
  { id: 'schedule', label: 'Payment run', hint: 'What has to go out, when, and whether it is covered' },
  { id: 'provision', label: 'Provision', hint: 'What the ageing says is doubtful' }
]

export function CollectionsScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab<Tab>('collections-tab', TABS.map((t) => t.id), 'reminders')
  const active = TABS.find((t) => t.id === tab) ?? TABS[0]!

  return (
    <div className="mx-auto max-w-6xl">
      <SectionTitle
        right={
          <div className="flex flex-wrap gap-1" role="group" aria-label="Collections view">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`tab-collections-${t.id}`}
                aria-pressed={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-md px-2.5 py-1 text-small ${
                  tab === t.id ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      >
        Collections
      </SectionTitle>

      <p className="mb-3 text-hint text-muted">{active.hint}</p>

      {tab === 'reminders' && <RemindersTab />}
      {tab === 'interest' && <InterestTab />}
      {tab === 'scores' && <ScoresTab />}
      {tab === 'ageing' && <AgeingTab />}
      {tab === 'advances' && <AdvancesTab />}
      {tab === 'schedule' && <ScheduleTab />}
      {tab === 'provision' && <ProvisionTab />}
    </div>
  )
}

// ---------- reminders (#151, #161) ----------

const TONE_CLASS: Record<string, string> = {
  gentle: 'border-line text-muted',
  firm: 'border-amberbar/60 text-ink',
  final: 'border-cr/50 text-cr'
}

/**
 * A reminder per overdue party, generated and shown before anything is opened.
 *
 * The app never sends: it opens a WhatsApp or mail link with the text filled in, and the person
 * presses send. That is deliberate — a bulk send that fires without a preview is how the wrong
 * tone reaches your biggest customer.
 */
function RemindersTab(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const [minOverdue, setMinOverdue] = useState(1)
  const [preview, setPreview] = useState<BulkReminderRow | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['recvReminders', to, minOverdue],
    queryFn: () => api.receivables.reminders('receivable', to, { minOverdueDays: minOverdue })
  })
  const rows = data ?? []
  const table = useTableNav(rows, { rowId: (r) => r.ledgerId, onEnter: (r) => setPreview(r) })

  const open = (row: BulkReminderRow, channel: 'whatsapp' | 'email'): void => {
    const url = channel === 'whatsapp' ? row.whatsapp : row.mailto
    if (!url) {
      toast.push('error', `No usable ${channel === 'whatsapp' ? 'phone number' : 'email address'} for ${row.name}`)
      return
    }
    window.open(url, '_blank')
  }

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-small text-muted">
        <span>Overdue by at least</span>
        <Select
          className="w-28"
          data-testid="select-reminder-min-overdue"
          value={minOverdue}
          onChange={(e) => setMinOverdue(Number(e.target.value))}
        >
          {[0, 1, 7, 15, 30, 60, 90].map((d) => (
            <option key={d} value={d}>
              {d === 0 ? 'any' : `${d} days`}
            </option>
          ))}
        </Select>
        <span>· {rows.length} to write to</span>
      </div>

      <Panel scroll={{ maxH: '68vh' }} data-testid="panel-reminders">
        {isLoading ? (
          <SkeletonRows rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState title="Nobody to chase" hint="Every open bill is still within its terms." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Party</th>
                <th scope="col" className="r w-36">Overdue</th>
                <th scope="col" className="r w-24">Days</th>
                <th scope="col" className="r w-32">Interest</th>
                <th scope="col" className="w-24">Tone</th>
                <th scope="col" className="w-56" />
              </tr>
            </thead>
            <tbody data-testid="rows-reminders">
              {rows.map((r, i) => (
                <tr key={r.ledgerId} {...table.rowProps(i, r)}>
                  <td>{r.name}</td>
                  <td className="r"><Money paise={r.pending} /></td>
                  <td className="r num text-cr font-semibold">{r.worstOverdueDays}d</td>
                  <td className="r">{r.interest > 0 ? <Money paise={r.interest} /> : <span className="text-muted">–</span>}</td>
                  <td>
                    <span className={`rounded-full border px-2 py-0.5 text-caption capitalize ${TONE_CLASS[r.tone]}`}>
                      {r.tone}
                    </span>
                  </td>
                  <td onClick={(e) => e.stopPropagation()} className="whitespace-nowrap">
                    <Button variant="ghost" data-testid={`btn-reminder-preview-${r.ledgerId}`} onClick={() => setPreview(r)}>
                      Preview
                    </Button>
                    {r.phone && (
                      <Button variant="ghost" onClick={() => open(r, 'whatsapp')}>
                        WhatsApp
                      </Button>
                    )}
                    {r.email && (
                      <Button variant="ghost" onClick={() => open(r, 'email')}>
                        Email
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {preview && (
        <Modal title={`Reminder — ${preview.name}`} onClose={() => setPreview(null)} wide>
          <div className="text-hint text-muted">Subject: {preview.subject}</div>
          <pre
            data-testid="reminder-body"
            className="mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-panel2 p-3 text-small"
          >
            {preview.body}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(preview.body)
                toast.push('success', 'Reminder copied')
              }}
            >
              Copy
            </Button>
            {preview.phone && (
              <Button variant="primary" onClick={() => open(preview, 'whatsapp')}>
                Open WhatsApp
              </Button>
            )}
            {preview.email && (
              <Button variant={preview.phone ? 'default' : 'primary'} onClick={() => open(preview, 'email')}>
                Open email
              </Button>
            )}
          </div>
        </Modal>
      )}
      <p className="mt-2 text-hint text-muted">
        Total is never the sender — it fills in the message and you press send. Tone rises with the
        oldest overdue bill; interest appears only for parties who have agreed terms.
      </p>
    </>
  )
}

// ---------- interest (#153) ----------

function InterestTab(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const [expanded, setExpanded] = useState<number | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['recvInterest', to],
    queryFn: () => api.receivables.interest('receivable', to)
  })
  const rows = data ?? []
  const total = rows.reduce((s, r) => s + r.interest.total, 0)

  const exportRows = rows.map((r) => ({
    cells: [r.name, formatPaise(r.pending), r.termsLabel, formatPaise(r.interest.total)]
  }))

  return (
    <>
      <div className="mb-3 flex justify-end gap-2">
        <Button
          variant="ghost"
          disabled={!rows.length}
          onClick={() =>
            void printReport(
              {
                title: 'Interest on overdue bills',
                periodLabel: `as on ${toDisplayDate(to)}`,
                columns: [
                  { label: 'Party', align: 'l' },
                  { label: 'Overdue', align: 'r' },
                  { label: 'Terms', align: 'l' },
                  { label: 'Interest', align: 'r' }
                ],
                rows: exportRows,
                footNote: 'Interest is shown for information and is not posted to the books.',
                filename: 'interest-on-overdue'
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
          onClick={() => void csvReport(['Party', 'Overdue', 'Terms', 'Interest'], exportRows.map((r) => r.cells), 'interest-on-overdue', toast)}
        >
          CSV
        </Button>
      </div>
      <Panel scroll={{ maxH: '68vh' }} data-testid="panel-interest">
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No interest to charge"
            hint="Set a rate on a party in Masters, or a company default under Settings → Collections."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Party</th>
                <th scope="col" className="r w-40">Overdue</th>
                <th scope="col" className="w-52">Terms</th>
                <th scope="col" className="r w-36">Interest</th>
              </tr>
            </thead>
            <tbody data-testid="rows-interest">
              {rows.map((r) => (
                <Fragment key={r.ledgerId}>
                  <tr
                    className="cursor-pointer"
                    onClick={() => setExpanded(expanded === r.ledgerId ? null : r.ledgerId)}
                  >
                    <td>
                      <span className="mr-1.5 inline-block w-3 text-muted">{expanded === r.ledgerId ? '−' : '+'}</span>
                      {r.name}
                    </td>
                    <td className="r"><Money paise={r.pending} /></td>
                    <td className="text-muted">{r.termsLabel}</td>
                    <td className="r"><Money paise={r.interest.total} /></td>
                  </tr>
                  {expanded === r.ledgerId &&
                    r.interest.lines.map((l) => (
                      <tr key={`${r.ledgerId}-${l.number}`} className="text-small text-muted">
                        <td className="pl-8">
                          {l.number} · {toDisplayDate(l.date)}
                          {l.dueDate ? ` · due ${toDisplayDate(l.dueDate)}` : ''}
                        </td>
                        <td className="r"><Money paise={l.pending} /></td>
                        <td>
                          {l.overdueDays}d overdue
                          {l.chargeableDays !== l.overdueDays ? ` · ${l.chargeableDays}d chargeable` : ''}
                        </td>
                        <td className="r"><Money paise={l.interest} /></td>
                      </tr>
                    ))}
                </Fragment>
              ))}
              <tr className="total-row">
                <td colSpan={3}>Total · {rows.length} parties</td>
                <td className="r"><Money paise={total} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Simple interest on actual days, floored to the paisa. Nothing here is posted — an interest
        note is a document you raise deliberately, not a figure that appears in the books by itself.
      </p>
    </>
  )
}

// ---------- credit scores (#159) ----------

const BAND_CLASS: Record<string, string> = {
  excellent: 'border-dr/50 text-dr',
  good: 'border-dr/30 text-dr',
  fair: 'border-amberbar/60 text-ink',
  poor: 'border-cr/50 text-cr'
}

function ScoresTab(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const { data, isLoading } = useQuery({ queryKey: ['recvScores', to], queryFn: () => api.receivables.creditScores(to) })
  const rows = data ?? []
  const table = useTableNav(rows, {
    rowId: (r) => r.ledgerId,
    onEnter: (r) => nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })
  })

  return (
    <>
      <Panel scroll={{ maxH: '68vh' }} data-testid="panel-scores">
        {isLoading ? (
          <SkeletonRows rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState title="No customers yet" hint="A score needs a few settled bills before it means anything." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Party</th>
                <th scope="col" className="r w-24">Score</th>
                <th scope="col" className="w-24">Band</th>
                <th scope="col" className="w-64">Why</th>
                <th scope="col" className="r w-36">Open</th>
                <th scope="col" className="r w-36">Limit</th>
              </tr>
            </thead>
            <tbody data-testid="rows-scores">
              {rows.map((r, i) => (
                <tr key={r.ledgerId} {...table.rowProps(i, r)}>
                  <td>{r.name}</td>
                  <td className="r num">{r.score ? r.score.score : <span className="text-muted">–</span>}</td>
                  <td>
                    {r.score ? (
                      <span className={`rounded-full border px-2 py-0.5 text-caption capitalize ${BAND_CLASS[r.score.band]}`}>
                        {r.score.band}
                      </span>
                    ) : (
                      <span className="text-hint text-muted">too new</span>
                    )}
                  </td>
                  <td className="text-small text-muted">
                    {r.score
                      ? `${
                          r.score.avgDaysLate <= 0
                            ? `${Math.abs(Math.round(r.score.avgDaysLate))}d early`
                            : `${Math.round(r.score.avgDaysLate)}d late`
                        } on average · ${Math.round(r.score.onTimeRate * 100)}% of ${r.score.sample} on time`
                      : 'not enough settled bills'}
                  </td>
                  <td className="r"><Money paise={r.pending} /></td>
                  <td className="r">
                    {r.creditLimit == null ? <span className="text-muted">–</span> : <Money paise={r.creditLimit} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Worst first. The score weights how promptly a party pays, how often they are on time at all,
        their worst lapse and what is overdue right now — and refuses to guess below four settled bills.
      </p>
    </>
  )
}

// ---------- ageing by salesperson or territory (#156) ----------

function AgeingTab(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const [dimension, setDimension] = useStickyTab<'salesperson' | 'territory' | 'party'>(
    'collections-ageing-dim',
    ['salesperson', 'territory', 'party'],
    'salesperson'
  )
  const [side, setSide] = useStickyTab<'receivable' | 'payable'>(
    'collections-ageing-side',
    ['receivable', 'payable'],
    'receivable'
  )
  const { data, isLoading } = useQuery({
    queryKey: ['recvAgeing', side, to, dimension],
    queryFn: () => api.receivables.ageingBy(side, to, dimension)
  })

  const exportRows = useMemo(
    () =>
      (data?.rows ?? []).map((r) => ({
        cells: [r.key, String(r.partyCount), formatPaise(r.pending), ...r.buckets.map((b) => formatPaise(b))]
      })),
    [data]
  )

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-small text-muted">
          <span>Group by</span>
          <Select
            className="w-40"
            data-testid="select-ageing-dimension"
            value={dimension}
            onChange={(e) => setDimension(e.target.value as typeof dimension)}
          >
            <option value="salesperson">Salesperson</option>
            <option value="territory">Territory</option>
            <option value="party">Party</option>
          </Select>
          <Select className="w-32" value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
            <option value="receivable">Receivable</option>
            <option value="payable">Payable</option>
          </Select>
        </div>
        <Button
          variant="ghost"
          disabled={!data?.rows.length}
          onClick={() =>
            void csvReport(
              ['Group', 'Parties', 'Total', ...(data?.bandLabels ?? [])],
              exportRows.map((r) => r.cells),
              `ageing-by-${dimension}`,
              toast
            )
          }
        >
          CSV
        </Button>
      </div>

      <Panel scroll={{ maxH: '68vh' }} data-testid="panel-ageing-by">
        {isLoading || !data ? (
          <SkeletonRows rows={6} />
        ) : data.rows.length === 0 ? (
          <EmptyState title="Nothing open" hint="No bills are outstanding on this side." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">{dimension === 'party' ? 'Party' : dimension === 'salesperson' ? 'Salesperson' : 'Territory'}</th>
                <th scope="col" className="r w-24">Parties</th>
                <th scope="col" className="r w-36">Total</th>
                {data.bandLabels.map((l) => (
                  <th key={l} scope="col" className="r w-32">
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody data-testid="rows-ageing-by">
              {data.rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td className="r num text-muted">{r.partyCount}</td>
                  <td className="r"><Money paise={r.pending} /></td>
                  {r.buckets.map((b, i) => (
                    <td key={i} className="r">
                      {b === 0 ? <span className="text-muted">–</span> : <Money paise={b} />}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="r num">{data.rows.reduce((s, r) => s + r.partyCount, 0)}</td>
                <td className="r"><Money paise={data.total} /></td>
                {data.totals.map((t, i) => (
                  <td key={i} className="r"><Money paise={t} /></td>
                ))}
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Set a salesperson and territory on the party in Masters. Unassigned is a real row, not a
        hidden one — on most books it starts out as all of the money.
      </p>
    </>
  )
}

// ---------- advances (#164) ----------

function AdvancesTab(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const [side, setSide] = useStickyTab<'receivable' | 'payable'>(
    'collections-advances-side',
    ['receivable', 'payable'],
    'receivable'
  )
  const { data, isLoading } = useQuery({
    queryKey: ['recvAdvances', side, to],
    queryFn: () => api.receivables.advances(side, to)
  })
  const rows = data ?? []
  const table = useTableNav(rows, {
    rowId: (r) => r.ledgerId,
    onEnter: (r) => nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })
  })

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-small text-muted">
        <Select className="w-40" value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
          <option value="receivable">Received from customers</option>
          <option value="payable">Paid to suppliers</option>
        </Select>
      </div>
      <Panel scroll={{ maxH: '68vh' }} data-testid="panel-advances">
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing unallocated" hint="Every receipt has found a bill to sit against." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Party</th>
                <th scope="col" className="r w-40">On account</th>
                <th scope="col" className="r w-28">Open bills</th>
                <th scope="col" className="w-32">Last {side === 'receivable' ? 'receipt' : 'payment'}</th>
              </tr>
            </thead>
            <tbody data-testid="rows-advances">
              {rows.map((r, i) => (
                <tr key={r.ledgerId} {...table.rowProps(i, r)}>
                  <td>{r.name}</td>
                  <td className="r"><Money paise={r.unapplied} /></td>
                  <td className="r num text-muted">{r.openBills || '–'}</td>
                  <td className="num text-muted">{r.lastReceiptDate ? toDisplayDate(r.lastReceiptDate) : 'never'}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total · {rows.length} parties</td>
                <td className="r"><Money paise={rows.reduce((s, r) => s + r.unapplied, 0)} /></td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        This is the number that makes a customer angry: they paid an advance, the next invoice went
        out for the full amount, and nobody netted it off. It clears itself as bills are raised.
      </p>
    </>
  )
}

// ---------- payment run (#165) ----------

function ScheduleTab(): React.JSX.Element {
  const { to } = useSession()
  // Counted forward from the as-on date, not from the start of the financial year: a payment run
  // is about the next few weeks, and funds "as on 1 April" is the wrong number to plan against
  // in November. The horizon is the question the user is actually asking.
  const [horizon, setHorizon] = useStickyNumber('collections-schedule-horizon', 30)
  const until = useMemo(() => addDays(to, horizon), [to, horizon])
  const { data, isLoading } = useQuery({
    queryKey: ['recvSchedule', to, until],
    queryFn: () => api.receivables.paymentSchedule(to, until)
  })

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-small text-muted">
        <span>Due within</span>
        <Select
          className="w-32"
          data-testid="select-schedule-horizon"
          value={horizon}
          onChange={(e) => setHorizon(Number(e.target.value))}
        >
          {[15, 30, 60, 90, 180].map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </Select>
        <span>· from {toDisplayDate(to)}</span>
      </div>
      {data && (
        <div className="mb-3 grid grid-cols-4 gap-3">
          <Stat label="Funds on hand" value={<Money paise={data.funds} />} />
          <Stat label="Already overdue" value={<Money paise={data.overdueTotal} />} tone={data.overdueTotal > 0 ? 'cr' : undefined} />
          <Stat label="Due in period" value={<Money paise={data.total} />} />
          <Stat
            label="Runs short on"
            value={data.shortfallDate ? toDisplayDate(data.shortfallDate) : 'never'}
            tone={data.shortfallDate ? 'cr' : undefined}
          />
        </div>
      )}

      <Panel scroll={{ maxH: '62vh' }} data-testid="panel-schedule">
        {isLoading || !data ? (
          <SkeletonRows rows={8} />
        ) : data.overdue.length === 0 && data.days.length === 0 ? (
          <EmptyState title="Nothing to pay" hint="No supplier bill falls due in this period." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Due</th>
                <th scope="col">Party</th>
                <th scope="col" className="w-32">Bill</th>
                <th scope="col" className="r w-24">Overdue</th>
                <th scope="col" className="r w-36">Amount</th>
                <th scope="col" className="r w-36">Left after</th>
              </tr>
            </thead>
            <tbody data-testid="rows-schedule">
              {data.overdue.length > 0 && (
                <>
                  <tr className="bg-panel2">
                    <td colSpan={6} className="text-small font-medium">
                      Already overdue — payable now · <Money paise={data.overdueTotal} />
                    </td>
                  </tr>
                  {data.overdue.map((b) => (
                    <tr key={`o-${b.ledgerId}-${b.number}`}>
                      <td className="num text-cr">now</td>
                      <td>{b.party}</td>
                      <td className="num text-muted">{b.number}</td>
                      <td className="r num text-cr font-semibold">{b.overdueDays}d</td>
                      <td className="r"><Money paise={b.pending} /></td>
                      <td />
                    </tr>
                  ))}
                </>
              )}
              {data.days.map((d) => (
                <Fragment key={`d-${d.date}`}>
                  <tr className="bg-panel2">
                    <td className="num">{toDisplayDate(d.date)}</td>
                    <td colSpan={3} className="text-small text-muted">
                      {d.bills.length} bill{d.bills.length === 1 ? '' : 's'}
                    </td>
                    <td className="r"><Money paise={d.due} /></td>
                    <td className={`r ${d.balanceAfter < 0 ? 'text-cr font-semibold' : 'text-muted'}`}>
                      <Money paise={d.balanceAfter} signed />
                    </td>
                  </tr>
                  {d.bills.map((b) => (
                    <tr key={`${d.date}-${b.ledgerId}-${b.number}`} className="text-small">
                      <td />
                      <td>{b.party}</td>
                      <td className="num text-muted">{b.number}</td>
                      <td />
                      <td className="r"><Money paise={b.pending} /></td>
                      <td />
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        The useful line is not &ldquo;₹4.2 lakh is due this month&rdquo; but the date the balance goes
        negative. Funds are cash plus bank as on the period start; bills due after the period end are
        not counted.
      </p>
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'cr' }): React.JSX.Element {
  return (
    <Panel className="p-3">
      <div className="text-caption uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-body font-semibold ${tone === 'cr' ? 'text-cr' : ''}`}>{value}</div>
    </Panel>
  )
}

// ---------- provisioning (#157) ----------

function ProvisionTab(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [expanded, setExpanded] = useState<number | null>(null)
  const { data, isLoading } = useQuery({ queryKey: ['recvProvision', to], queryFn: () => api.receivables.provision(to) })

  const postDraft = (): void => {
    const draft = data?.draft
    if (!draft) return
    if (draft.missingLedgers.length > 0) {
      toast.push(
        'error',
        `Create ${draft.missingLedgers.join(' and ')} in Masters first — a provision needs somewhere to sit.`
      )
      return
    }
    nav.go({
      name: 'voucher-entry',
      kindHint: 'journal',
      draft: {
        date: draft.date,
        narration: draft.narration,
        lines: draft.lines.map((l) => ({ ledgerName: l.ledgerName, drCr: l.drCr, amount: l.amount }))
      },
      draftId: Date.now()
    } as never)
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-small text-muted">
          {data ? `${describeRules(data.result.policy)} · as on ${toDisplayDate(to)}` : ''}
        </div>
        <Button
          variant="primary"
          data-testid="btn-provision-draft"
          disabled={!data?.draft}
          onClick={postDraft}
        >
          Draft the journal
        </Button>
      </div>

      <Panel scroll={{ maxH: '62vh' }} data-testid="panel-provision">
        {isLoading || !data ? (
          <SkeletonRows rows={6} />
        ) : data.result.parties.length === 0 ? (
          <EmptyState title="Nothing doubtful" hint="No open bill is old enough to meet the provisioning policy." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Party</th>
                <th scope="col" className="r w-40">Open</th>
                <th scope="col" className="r w-40">Provision</th>
              </tr>
            </thead>
            <tbody data-testid="rows-provision">
              {data.result.parties.map((p) => (
                <Fragment key={p.ledgerId}>
                  <tr className="cursor-pointer" onClick={() => setExpanded(expanded === p.ledgerId ? null : p.ledgerId)}>
                    <td>
                      <span className="mr-1.5 inline-block w-3 text-muted">{expanded === p.ledgerId ? '−' : '+'}</span>
                      {p.name}
                    </td>
                    <td className="r"><Money paise={p.pending} /></td>
                    <td className="r"><Money paise={p.provision} /></td>
                  </tr>
                  {expanded === p.ledgerId &&
                    p.bills.map((b) => (
                      <tr key={`${p.ledgerId}-${b.number}`} className="text-small text-muted">
                        <td className="pl-8">
                          {b.number} · {toDisplayDate(b.date)} · {b.overdueDays}d overdue · {b.pct}%
                        </td>
                        <td className="r"><Money paise={b.pending} /></td>
                        <td className="r"><Money paise={b.provision} /></td>
                      </tr>
                    ))}
                </Fragment>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td />
                <td className="r"><Money paise={data.result.total} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      {data?.draft && (
        <p className="mt-2 text-hint text-muted">
          The draft debits {data.draft.lines[0]!.ledgerName} and credits {data.draft.lines[1]!.ledgerName}. It never
          credits the customer — a provision is an estimate against the receivable, not a write-off
          of it, and they still owe you the money.
        </p>
      )}
    </>
  )
}

function describeRules(policy: { afterDays: number; pct: number }[]): string {
  return policy.map((r) => `${r.pct}% over ${r.afterDays}d`).join(' · ')
}

/**
 * The statement of account, previewed on screen before it is printed.
 *
 * Opened from the Khata row rather than living in a tab of its own: a statement is always about
 * one party, and the moment you want one is while you are looking at them.
 */
export function StatementModal({
  ledgerId,
  name,
  side,
  onClose
}: {
  ledgerId: number
  name: string
  side: 'receivable' | 'payable'
  onClose: () => void
}): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const [busy, setBusy] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['recvStatement', ledgerId, from, to],
    queryFn: () => api.receivables.statement(ledgerId, from, to)
  })

  const print = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.receivables.statementPdf(ledgerId, from, to, side)
      toast.push('success', `Saved to exports — ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Statement — ${name}`} onClose={onClose} wide>
      {isLoading || !data ? (
        <SkeletonRows rows={8} />
      ) : (
        <StatementBody statement={data} side={side} />
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" data-testid="btn-statement-pdf" disabled={busy || !data} onClick={() => void print()}>
          {busy ? 'Printing…' : 'PDF'}
        </Button>
      </div>
    </Modal>
  )
}

function StatementBody({ statement, side }: { statement: PartyStatement; side: 'receivable' | 'payable' }): React.JSX.Element {
  const label = side === 'receivable' ? 'receivable' : 'payable'
  return (
    <div data-testid="statement-body">
      <div className="flex items-baseline justify-between">
        <div className="text-hint text-muted">
          {toDisplayDate(statement.from)} to {toDisplayDate(statement.to)}
        </div>
        <div className="text-body font-semibold">
          <Money paise={statement.closingBalance} /> <span className="text-hint text-muted">{label}</span>
        </div>
      </div>
      <div className="mt-2 max-h-[45vh] overflow-auto">
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col" className="w-24">Date</th>
              <th scope="col" className="w-28">Number</th>
              <th scope="col">Particulars</th>
              <th scope="col" className="r w-28">Debit</th>
              <th scope="col" className="r w-28">Credit</th>
              <th scope="col" className="r w-32">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="num text-muted">{toDisplayDate(statement.from)}</td>
              <td />
              <td className="text-muted">Opening balance</td>
              <td /> <td />
              <td className="r"><Money paise={statement.openingBalance} /></td>
            </tr>
            {statement.lines.map((l) => (
              <tr key={`${l.voucherId}-${l.number}`}>
                <td className="num text-muted">{toDisplayDate(l.date)}</td>
                <td className="num">{l.number}</td>
                <td>{l.particulars}</td>
                <td className="r">{l.debit === null ? '' : <Money paise={l.debit} />}</td>
                <td className="r">{l.credit === null ? '' : <Money paise={l.credit} />}</td>
                <td className="r"><Money paise={l.balance} /></td>
              </tr>
            ))}
            <tr className="total-row">
              <td colSpan={5}>Closing balance</td>
              <td className="r"><Money paise={statement.closingBalance} /></td>
            </tr>
          </tbody>
        </table>
      </div>
      {statement.openBills.length > 0 && (
        <div className="mt-3">
          <div className="text-caption uppercase tracking-wide text-muted">Ageing of what is still open</div>
          <div className="mt-1 flex gap-4 text-small">
            {statement.bandLabels.map((l, i) => (
              <div key={l}>
                <span className="text-muted">{l}: </span>
                <Money paise={statement.buckets[i] ?? 0} />
              </div>
            ))}
          </div>
        </div>
      )}
      {statement.interest && statement.interest.total > 0 && statement.termsLabel && (
        <div className="mt-3 text-small text-muted">
          Interest on overdue bills at {statement.termsLabel}: <Money paise={statement.interest.total} /> — shown for
          information, not included in the balance.
        </div>
      )}
    </div>
  )
}
