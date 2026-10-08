import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { receivablesApi, type FollowupRow } from '../lib/receivablesClient'
import { useNav, useSession, useToasts, type ToastState } from '../state/stores'
import { useFeatures } from '../lib/useFeatures'
import { confirmDialog } from '../lib/dialogs'
import { AmountInput, Button, DateInput, DrawerSection, Money, Page, PageHeader, Panel, Select, TextInput } from '../components/ui'
import { OptionToggle, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { TabBar } from '../components/TabBar'
import { DataTable, defineColumns, type RowKey } from '../components/table'
import { fyOf, todayISO, toDisplayDate } from '@shared/dates'
import { REMINDER_BUCKET_LABELS } from '@shared/receivables/config'
import { billKeyOf } from '@shared/receivables/types'
import type { OutstandingBill, OutstandingParty } from '@shared/reports'
import { LedgerLink, VoucherLink } from '../components/links'
import { openLedgerStatement } from '../lib/drill'
import { StatementModal } from '../components/receivables/StatementModal'

const bucket = (i: 0 | 1 | 2 | 3) => (p: OutstandingParty) => p.buckets[i]

export const OUTSTANDING_COLUMNS = defineColumns<OutstandingParty>([
  {
    id: 'party',
    header: 'Party',
    kind: 'text',
    value: (p) => p.name,
    hideable: false,
    groupable: false,
    minWidth: 170, // 170 + 4 × 122 + 136 + chevron + 170 actions = the 1022px panel at 1440 wide
    // The row expands its bills; the party NAME opens the ledger's edit window.
    cell: (p) => <LedgerLink ledgerId={p.ledgerId} name={p.name} />
  },
  { id: 'bills', header: 'Bills', kind: 'number', value: (p) => p.bills.length, aggregate: 'sum', width: 80, defaultHidden: true },
  { id: 'b0', header: '0–30 d', kind: 'money', value: bucket(0), aggregate: 'sum', width: 122 },
  { id: 'b1', header: '31–60 d', kind: 'money', value: bucket(1), aggregate: 'sum', width: 122 },
  { id: 'b2', header: '61–90 d', kind: 'money', value: bucket(2), aggregate: 'sum', width: 122 },
  {
    id: 'b3',
    header: '90+ d',
    kind: 'money',
    value: bucket(3),
    aggregate: 'sum',
    width: 122,
    cell: (p) => (
      <span className={p.buckets[3] > 0 ? 'text-cr' : ''}>
        <Money paise={p.buckets[3]} />
      </span>
    )
  },
  { id: 'pending', header: 'Pending', kind: 'money', value: (p) => p.pending, aggregate: 'sum', width: 136, className: 'font-medium' }
])

/** "Remind" (WP 4.2): the letter for the party's ageing bucket is generated and logged (PDF in
 *  exports/reminders), then the email draft opens with its text — the app has no SMTP. Inside
 *  the "don't remind again within N days" window it asks first. */
async function remind(party: OutstandingParty, asOn: string, toast: ToastState): Promise<void> {
  const send = async (force: boolean): Promise<void> => {
    const r = await receivablesApi.remind(party.ledgerId, asOn, 'email', force)
    let copied = true
    try {
      await navigator.clipboard.writeText(r.body)
    } catch {
      // Clipboard access can fail in some sandboxes — the mailto still opens with the body.
      copied = false
    }
    window.open(r.mailto)
    toast.push('success', `${REMINDER_BUCKET_LABELS[r.bucket]} reminder logged${copied ? ' and copied' : ''} — email draft opened`)
  }
  try {
    await send(false)
  } catch (err) {
    const msg = (err as Error).message
    if (msg.startsWith('Reminder cadence:')) {
      const ok = await confirmDialog({ title: 'Reminded recently', message: `${msg.replace('Reminder cadence: ', '')}. Send another now anyway?`, confirmLabel: 'Send anyway' })
      if (ok) await send(true).catch((e: Error) => toast.push('error', e.message))
    } else toast.push(msg.startsWith('Nothing is overdue') ? 'warning' : 'error', msg)
  }
}

/** The inline "add a follow-up" row under a bill. */
function FollowupForm({ party, bill, onDone }: { party: OutstandingParty; bill: OutstandingBill; onDone: () => void }): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const qc = useQueryClient()
  const [date, setDate] = useState(() => (to > todayISO() ? todayISO() : to))
  const [note, setNote] = useState('')
  const [promised, setPromised] = useState('')
  const [amount, setAmount] = useState<number | null>(null)
  const save = async (): Promise<void> => {
    try {
      await receivablesApi.addFollowup({
        ledgerId: party.ledgerId, billVoucherId: bill.voucherId, billRef: bill.number, date, note: note.trim(),
        promisedDate: promised || null, promisedAmount: amount && amount > 0 ? amount : null
      })
      await qc.invalidateQueries({ queryKey: ['followups'] })
      toast.push('success', `Follow-up saved on ${bill.number}`)
      onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-2 py-1" data-testid="followup-form">
      <label className="flex flex-col text-caption text-muted">Date<DateInput value={date} context={to} onChange={setDate} testId="input-followup-date" className="w-28" /></label>
      <label className="flex min-w-[220px] flex-1 flex-col text-caption text-muted">
        Note
        <TextInput value={note} autoFocus data-testid="input-followup-note" placeholder="Called accounts — cheque ready Friday" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </label>
      <label className="flex flex-col text-caption text-muted">Promised for<DateInput value={promised} context={to} onChange={setPromised} allowEmpty testId="input-followup-promised" className="w-28" /></label>
      <label className="flex flex-col text-caption text-muted">Amount<AmountInput paise={amount} onPaise={setAmount} testId="input-followup-amount" className="w-28" placeholder={(bill.pending / 100).toFixed(2)} /></label>
      <Button size="sm" variant="primary" data-testid="btn-followup-save" onClick={() => void save()}>Save</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
    </div>
  )
}

/** A party's open bills, shown in its expanded detail row, with each bill's latest follow-up
 *  (note / promised date) and an inline "+ Note". */
function BillsDetail({ party }: { party: OutstandingParty }): React.JSX.Element {
  const [adding, setAdding] = useState<string | null>(null)
  const { data: followups } = useQuery({ queryKey: ['followups', party.ledgerId], queryFn: () => receivablesApi.followups(party.ledgerId) })
  const latest = new Map<string, FollowupRow>()
  for (const f of followups ?? []) if (!latest.has(billKeyOf(f))) latest.set(billKeyOf(f), f) // newest first
  const count = (k: string): number => (followups ?? []).filter((f) => billKeyOf(f) === k).length
  return (
    <table className="ledger-table" data-testid={`outstandings-bills-${party.ledgerId}`}>
      <thead>
        <tr>
          <th scope="col">Bill</th>
          <th scope="col" className="w-28">Bill date</th>
          <th scope="col" className="r w-20">Age</th>
          <th scope="col" className="w-44">Due date</th>
          <th scope="col" className="r w-32">Bill amount</th>
          <th scope="col" className="r w-32">Pending</th>
          <th scope="col">Follow-up</th>
          <th scope="col" className="w-16" aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {party.bills.map((b) => {
          const key = billKeyOf({ billVoucherId: b.voucherId, billRef: b.number })
          const f = latest.get(key)
          const n = count(key)
          return [
            <tr key={key} className={b.overdueDays > 0 ? 'text-cr' : ''} data-bill={b.number}>
              <td>
                <VoucherLink voucherId={b.voucherId} label={b.number} className="hover:text-blue" />
              </td>
              <td className="num">{toDisplayDate(b.date)}</td>
              <td className="r num">{b.ageDays} days</td>
              <td className="num">
                {b.dueDate ? toDisplayDate(b.dueDate) : ''}
                {b.overdueDays > 0 && <span className="ml-1.5">· {b.overdueDays}d overdue</span>}
              </td>
              <td className="r">
                <Money paise={b.amount} />
              </td>
              <td className="r">
                <Money paise={b.pending} />
              </td>
              <td className="text-small text-ink" data-testid="bill-followup">
                {f ? (
                  <span title={(followups ?? []).filter((x) => billKeyOf(x) === key).map((x) => `${toDisplayDate(x.date)} ${x.userName ?? ''}: ${x.note}${x.promisedDate ? ` (promised ${toDisplayDate(x.promisedDate)})` : ''}`).join('\n')}>
                    {f.promisedDate && <span className="mr-1.5 font-medium text-warning">Promised {toDisplayDate(f.promisedDate)}{f.promisedAmount ? ` · ₹${(f.promisedAmount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : ''}</span>}
                    <span className="text-muted">{f.note}</span>
                    {n > 1 && <span className="ml-1 text-hint text-muted">(+{n - 1})</span>}
                  </span>
                ) : null}
              </td>
              <td className="r">
                <button type="button" data-testid="btn-followup-add" className="text-hint text-blue hover:underline" onClick={() => setAdding(adding === key ? null : key)}>
                  + Note
                </button>
              </td>
            </tr>,
            adding === key ? (
              <tr key={`${key}-form`}>
                <td colSpan={8}>
                  <FollowupForm party={party} bill={b} onDone={() => setAdding(null)} />
                </td>
              </tr>
            ) : null
          ]
        })}
      </tbody>
    </table>
  )
}

/** Options → Statements: preview one party's statement, or write every party's to a folder. */
function StatementsSection({ parties, onPreview }: { parties: OutstandingParty[]; onPreview: (p: OutstandingParty) => void }): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const [pick, setPick] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const from = fyOf(to).from
  const bulk = async (pickFolder: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await receivablesApi.statementsBulk(from, to, pickFolder)
      if (r.cancelled) return
      toast.push('success', `${r.files.length} statement${r.files.length === 1 ? '' : 's'} saved to …/${r.folder.split('/').slice(-2).join('/')}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <DrawerSection title="Statements" testId="options-statements">
      <p className="text-hint text-muted">Statement of account {toDisplayDate(from)} → {toDisplayDate(to)}: every voucher with its bill-wise allocation, open bills, ageing and your bank details.</p>
      <div className="flex items-center gap-2">
        <Select aria-label="Party" data-testid="input-statement-party" value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Choose a party…</option>
          {parties.map((p) => (
            <option key={p.ledgerId} value={p.ledgerId}>{p.name}</option>
          ))}
        </Select>
        <Button size="sm" data-testid="btn-statement-preview" disabled={pick === ''} onClick={() => { const p = parties.find((x) => x.ledgerId === pick); if (p) onPreview(p) }}>
          Preview
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" data-testid="btn-statements-bulk" disabled={busy} onClick={() => void bulk(false)}>All parties → exports</Button>
        <Button size="sm" variant="ghost" data-testid="btn-statements-folder" disabled={busy} onClick={() => void bulk(true)}>All parties → folder…</Button>
      </div>
    </DrawerSection>
  )
}

export function OutstandingsScreen(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const [side, setSide] = useState<'receivable' | 'payable'>('receivable')
  const features = useFeatures()
  const nav = useNav()
  const [expanded, setExpanded] = useState<Set<RowKey>>(() => new Set())
  const [soa, setSoa] = useState<OutstandingParty | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['outstandings', side, to],
    queryFn: () => api.analysis.outstandings(side, to)
  })
  const opts = useScreenOptions('outstandings', { overdueOnly: false })
  // "Over 30 days only": parties with something in the 31–60, 61–90 or 90+ buckets.
  const parties = (data ?? []).filter((p) => !opts.options.overdueOnly || p.buckets[1] + p.buckets[2] + p.buckets[3] > 0)
  const periodLabel = `as on ${toDisplayDate(to)}`
  const title = side === 'receivable' ? 'Receivables' : 'Payables'
  const receivable = side === 'receivable'

  const toggle = (p: OutstandingParty): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(p.ledgerId)) n.delete(p.ledgerId)
      else n.add(p.ledgerId)
      return n
    })

  return (
    <Page>
      <PageHeader
        title={`${title} · ageing`}
        period={periodLabel}
        tabs={
          <TabBar
            screen="outstandings"
            tabs={[
              { id: 'receivable', label: 'Receivables' },
              { id: 'payable', label: 'Payables' }
            ]}
            active={side}
            onSelect={(s) => {
              setSide(s)
              setExpanded(new Set())
            }}
          />
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod asOn />
              <DrawerSection title="Display">
                <OptionToggle
                  label="Only parties overdue more than 30 days"
                  checked={opts.options.overdueOnly}
                  onChange={(v) => opts.set('overdueOnly', v)}
                  testId="input-outstandings-overdue-only"
                />
              </DrawerSection>
              <OptionsTable area="outstandings" />
              {receivable && <StatementsSection parties={data ?? []} onPreview={setSoa} />}
              {receivable && (
                <DrawerSection title="Collections" testId="options-collections">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" data-testid="btn-outstandings-credit-control" onClick={() => nav.go({ name: 'receivables', tab: 'control' })}>Credit control</Button>
                    <Button size="sm" data-testid="btn-outstandings-reminders" onClick={() => nav.go({ name: 'receivables', tab: 'reminders' })}>Reminder letters</Button>
                    <Button size="sm" data-testid="btn-outstandings-interest" onClick={() => nav.go({ name: 'receivables', tab: 'interest' })}>Interest</Button>
                    <Button size="sm" onClick={() => nav.go({ name: 'receivables', tab: 'collections' })}>Collection reports</Button>
                  </div>
                  <p className="text-hint text-muted">Reminder templates, the email subject / body and the cadence: Settings → Receivables.</p>
                </DrawerSection>
              )}
              {features.orders && (
                <DrawerSection title="Goods not yet invoiced">
                  <p className="text-hint text-muted">
                    Challans and GRNs post nothing, so they are not in these buckets until the invoice or bill.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" data-testid="btn-outstandings-pending-challans" onClick={() => nav.go({ name: 'pending-challans' })}>
                      Pending challans
                    </Button>
                    <Button size="sm" data-testid="btn-outstandings-pending-grns" onClick={() => nav.go({ name: 'pending-grns' })}>
                      Pending GRNs
                    </Button>
                  </div>
                </DrawerSection>
              )}
              <DrawerSection title="About the buckets">
                <p className="text-hint text-muted">
                  Ageing buckets count days overdue past each bill&apos;s due date (or the bill date when none is set). Receipts
                  settle the oldest bills first. Click a party row to see its open bills (and add follow-up notes or promised dates), its
                  name to edit the ledger, Ledger for its ledger statement, SOA for the printable statement of account; click a bill
                  number to open the voucher.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <Panel>
        <DataTable
          key={side}
          viewId="outstandings"
          testId="outstandings"
          ariaLabel={`${title} ageing`}
          columns={OUTSTANDING_COLUMNS}
          rows={parties}
          rowKey={(p) => p.ledgerId}
          rowAttrs={(p) => ({ 'data-row-id': p.ledgerId })}
          loading={isLoading}
          empty={{
            title: opts.options.overdueOnly
              ? 'No party is overdue more than 30 days'
              : `Nothing ${side === 'receivable' ? 'to collect' : 'to pay'} as on ${toDisplayDate(to)}`
          }}
          // Clicking (or Enter on) a party opens its bills, as before; → / ← also expand/collapse.
          onRowActivate={toggle}
          isRowActivatable={(p) => p.bills.length > 0}
          renderDetail={(p) => <BillsDetail party={p} />}
          isRowExpandable={(p) => p.bills.length > 0}
          expanded={expanded}
          onExpandedChange={setExpanded}
          detailHeightEstimate={80}
          trailing={(p) => (
            <span className="flex justify-end gap-3">
              <button
                type="button"
                data-testid="btn-outstandings-statement"
                className="text-hint text-blue hover:underline"
                title={`Open ${p.name} ledger statement`}
                onClick={() => openLedgerStatement(p.ledgerId)}
              >
                Ledger
              </button>
              {receivable && (
                <button
                  type="button"
                  data-testid="btn-outstandings-soa"
                  className="text-hint text-blue hover:underline"
                  title={`Statement of account for ${p.name}`}
                  onClick={() => setSoa(p)}
                >
                  SOA
                </button>
              )}
              {receivable && (
                <button
                  type="button"
                  data-testid="btn-outstandings-remind"
                  className="text-hint text-blue hover:underline"
                  onClick={() => void remind(p, to > todayISO() ? todayISO() : to, toast)}
                >
                  Remind
                </button>
              )}
            </span>
          )}
          trailingWidth={170}
          maxHeight="70vh"
          exportOptions={{ title: `${title} · ageing`, periodLabel, filename: `outstandings-${side}` }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Buckets are days overdue past each bill&apos;s due date. Click a party to see its open bills and follow-ups · F12 for options.</p>
      {soa && <StatementModal ledgerId={soa.ledgerId} name={soa.name} onClose={() => setSoa(null)} />}
    </Page>
  )
}
