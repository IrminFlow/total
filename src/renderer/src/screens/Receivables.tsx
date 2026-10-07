// WP 4.2 — Credit control: parties by exposure (holds, limits, DSO, promises), reminder letters
// by ageing bucket with their log, interest on overdue bills (preview → debit note) and the
// collection reports (DSO by month, collection efficiency, ageing trend, top overdue). Every
// figure is computed from the books at query time (services/receivables.ts).
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { todayISO, toDisplayDate, toMonthLabel } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { REMINDER_BUCKET_LABELS, type ReminderBucket } from '@shared/receivables/config'
import { bpToPercent } from '@shared/receivables/interest'
import {
  receivablesApi, type CollectionReport, type CreditControlRow, type FollowupRow, type InterestChargeRow, type InterestRow,
  type ReminderCandidate, type ReminderLogRow, type TopOverdueRow
} from '../lib/receivablesClient'
import { useSession, useToasts } from '../state/stores'
import { useFeatures } from '../lib/useFeatures'
import { promptDialog, confirmDialog } from '../lib/dialogs'
import { Badge, Button, DrawerSection, Page, PageHeader, Panel, StatGrid, StatTile, TextInput, Checkbox } from '../components/ui'
import { OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink, VoucherLink } from '../components/links'
import { TabBar } from '../components/TabBar'

export type ReceivablesTab = 'control' | 'reminders' | 'interest' | 'collections'

const rupees = (p: number): string => formatPaise(p, { symbol: true })

/** The as-on date for credit control, reminders and interest: the period end, but never a day in
 *  the future (the working period usually runs to 31 March — interest can't accrue to then). */
export function useAsOn(): string {
  const { to } = useSession()
  const today = todayISO()
  return to > today ? today : to
}
const pct = (x: number | null): string => (x == null ? '—' : `${Math.round(x * 1000) / 10} %`)
const BUCKET_TONE: Record<ReminderBucket, 'info' | 'warning' | 'danger'> = { gentle: 'info', firm: 'warning', final: 'danger' }

// ---------------------------------------------------------------- columns

function controlColumns(orders: boolean) {
  return defineColumns<CreditControlRow>([
    { id: 'party', header: 'Party', kind: 'text', value: (r) => r.name, minWidth: 160, hideable: false, groupable: false, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.name} /> },
    { id: 'outstanding', header: 'Outstanding', kind: 'money', value: (r) => r.outstanding, aggregate: 'sum', width: 130, signed: true },
    { id: 'overdue', header: 'Overdue', kind: 'money', value: (r) => r.overdue, aggregate: 'sum', width: 110, cell: (r) => <span className={`num ${r.overdue > 0 ? 'text-cr' : ''}`}>{formatPaise(r.overdue, { zeroDash: true })}</span> },
    ...(orders ? [{ id: 'orders', header: 'Open orders', kind: 'money' as const, value: (r: CreditControlRow) => r.openOrders, aggregate: 'sum' as const, width: 120 }] : []),
    { id: 'exposure', header: 'Exposure', kind: 'money', value: (r) => r.exposure, aggregate: 'sum', width: 120, className: 'font-medium' },
    { id: 'limit', header: 'Credit limit', kind: 'money', value: (r) => r.creditLimit, width: 110 },
    {
      id: 'util', header: 'Limit used', kind: 'number', value: (r) => (r.utilisation == null ? null : Math.round(r.utilisation * 1000) / 10), width: 108,
      text: (r) => pct(r.utilisation),
      cell: (r) => <span className={`num ${r.utilisation != null && r.utilisation > 1 ? 'font-medium text-cr' : ''}`}>{pct(r.utilisation)}</span>
    },
    { id: 'dso', header: 'DSO', kind: 'number', value: (r) => r.dso, width: 76, text: (r) => (r.dso == null ? '—' : `${r.dso} d`) },
    { id: 'days', header: 'Oldest overdue', kind: 'number', value: (r) => r.maxOverdueDays, width: 110, defaultHidden: true, text: (r) => (r.maxOverdueDays ? `${r.maxOverdueDays} d` : '—') },
    {
      id: 'hold', header: 'Hold', kind: 'text', value: (r) => (r.hold ? `On hold${r.holdReason ? ` — ${r.holdReason}` : ''}` : ''), minWidth: 120,
      cell: (r) => (r.hold ? <span title={r.holdReason ?? ''}><Badge tone="danger" testId="badge-credit-hold">On hold</Badge> <span className="text-hint text-muted">{r.holdReason}</span></span> : null)
    },
    { id: 'promised', header: 'Promised', kind: 'date', value: (r) => r.promisedDate ?? '', width: 100 },
    { id: 'promisedAmount', header: 'Promised ₹', kind: 'money', value: (r) => r.promisedAmount, width: 110, defaultHidden: true },
    { id: 'lastReminder', header: 'Last reminder', kind: 'date', value: (r) => r.lastReminder ?? '', width: 120, defaultHidden: true }
  ])
}
const CONTROL_COLUMNS = { on: controlColumns(true), off: controlColumns(false) }

const PROMISE_COLUMNS = defineColumns<FollowupRow & { stillPending: number }>([
  { id: 'promised', header: 'Promised for', kind: 'date', value: (r) => r.promisedDate ?? '', width: 120 },
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 150, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.partyName} /> },
  { id: 'bill', header: 'Bill', kind: 'text', value: (r) => r.billRef, width: 130, cell: (r) => <VoucherLink voucherId={r.billVoucherId} label={r.billRef} /> },
  { id: 'amount', header: 'Promised ₹', kind: 'money', value: (r) => r.promisedAmount ?? r.stillPending, aggregate: 'sum', width: 120 },
  { id: 'pending', header: 'Still pending', kind: 'money', value: (r) => r.stillPending, aggregate: 'sum', width: 120 },
  { id: 'note', header: 'Note', kind: 'text', value: (r) => r.note, minWidth: 160 },
  { id: 'by', header: 'By', kind: 'text', value: (r) => r.userName ?? '', width: 110, defaultHidden: true }
])

const CANDIDATE_COLUMNS = defineColumns<ReminderCandidate>([
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.name, minWidth: 160, hideable: false, groupable: false, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.name} /> },
  {
    id: 'bucket', header: 'Letter', kind: 'enum', value: (r) => r.bucket, width: 100,
    options: (['gentle', 'firm', 'final'] as const).map((b) => ({ value: b, label: REMINDER_BUCKET_LABELS[b] })),
    cell: (r) => <Badge tone={BUCKET_TONE[r.bucket]} testId={`badge-bucket-${r.bucket}`}>{REMINDER_BUCKET_LABELS[r.bucket]}</Badge>
  },
  { id: 'overdue', header: 'Overdue', kind: 'money', value: (r) => r.overdue, aggregate: 'sum', width: 120 },
  { id: 'total', header: 'Total due', kind: 'money', value: (r) => r.total, aggregate: 'sum', width: 120, defaultHidden: true },
  { id: 'bills', header: 'Bills', kind: 'number', value: (r) => r.billCount, width: 70 },
  { id: 'oldest', header: 'Oldest bill', kind: 'text', value: (r) => r.oldestBill, width: 120 },
  { id: 'days', header: 'Days overdue', kind: 'number', value: (r) => r.maxOverdueDays, width: 110, text: (r) => `${r.maxOverdueDays} d` },
  { id: 'last', header: 'Last sent', kind: 'date', value: (r) => r.lastSent ?? '', width: 110 },
  {
    id: 'next', header: 'Next allowed', kind: 'date', value: (r) => r.nextAllowed ?? '', width: 120,
    cell: (r) => (r.allowed ? <span className="text-hint text-muted">now</span> : <span className="num text-warning">{toDisplayDate(r.nextAllowed!)}</span>)
  },
  { id: 'email', header: 'Email', kind: 'text', value: (r) => r.email ?? '', width: 160, defaultHidden: true }
])

const LOG_COLUMNS = defineColumns<ReminderLogRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, width: 100 },
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 150, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.partyName} /> },
  {
    id: 'bucket', header: 'Letter', kind: 'enum', value: (r) => r.bucket, width: 90,
    options: (['gentle', 'firm', 'final'] as const).map((b) => ({ value: b, label: REMINDER_BUCKET_LABELS[b] }))
  },
  { id: 'amount', header: 'Overdue', kind: 'money', value: (r) => r.amount, width: 120 },
  { id: 'oldest', header: 'Oldest bill', kind: 'text', value: (r) => r.oldestBill ?? '', width: 110 },
  { id: 'days', header: 'Days', kind: 'number', value: (r) => r.days, width: 70 },
  { id: 'channel', header: 'Channel', kind: 'text', value: (r) => r.channel, width: 80 },
  { id: 'by', header: 'By', kind: 'text', value: (r) => r.userName ?? '', width: 110 },
  { id: 'doc', header: 'Document', kind: 'text', value: (r) => r.documentPath?.split('/').pop() ?? '', minWidth: 150, defaultHidden: true }
])

const INTEREST_COLUMNS = defineColumns<InterestRow>([
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 130, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.partyName} /> },
  { id: 'bill', header: 'Bill', kind: 'text', value: (r) => r.billRef, width: 110, hideable: false, cell: (r) => <VoucherLink voucherId={r.billVoucherId} label={r.billRef} /> },
  { id: 'due', header: 'Due', kind: 'date', value: (r) => r.dueDate ?? r.billDate, width: 96 },
  { id: 'grace', header: 'Grace', kind: 'number', value: (r) => r.graceDays, width: 70, defaultHidden: true },
  { id: 'from', header: 'From', kind: 'date', value: (r) => r.from, width: 96 },
  { id: 'to', header: 'To', kind: 'date', value: (r) => r.to, width: 96, defaultHidden: true },
  { id: 'days', header: 'Days', kind: 'number', value: (r) => r.days, width: 60 },
  { id: 'pending', header: 'Pending', kind: 'money', value: (r) => r.pendingPaise, width: 110 },
  { id: 'rate', header: 'Rate', kind: 'number', value: (r) => r.rateBp / 100, width: 70, text: (r) => `${bpToPercent(r.rateBp)} %` },
  { id: 'interest', header: 'Interest', kind: 'money', value: (r) => r.interestPaise, aggregate: 'sum', width: 110, className: 'font-medium' },
  { id: 'gstRate', header: 'GST rate', kind: 'text', value: (r) => r.gst.filter((g) => g.rate > 0).map((g) => `${g.rate}%`).join(' + ') || 'none', width: 80 },
  { id: 'gst', header: 'GST', kind: 'money', value: (r) => r.gstPaise, aggregate: 'sum', width: 90 },
  { id: 'total', header: 'Debit note', kind: 'money', value: (r) => r.totalPaise, aggregate: 'sum', width: 110 },
  { id: 'charged', header: 'Charged to', kind: 'date', value: (r) => r.chargedTo ?? '', width: 110, defaultHidden: true }
])

const CHARGE_COLUMNS = defineColumns<InterestChargeRow>([
  { id: 'note', header: 'Debit note', kind: 'text', value: (r) => r.debitNoteNumber, width: 120, cell: (r) => <VoucherLink voucherId={r.debitNoteVoucherId} label={r.debitNoteNumber} /> },
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 140 },
  { id: 'bill', header: 'Bill', kind: 'text', value: (r) => r.billRef, width: 110 },
  { id: 'from', header: 'From', kind: 'date', value: (r) => r.periodFrom, width: 100 },
  { id: 'to', header: 'To', kind: 'date', value: (r) => r.periodTo, width: 100 },
  { id: 'days', header: 'Days', kind: 'number', value: (r) => r.days, width: 70 },
  { id: 'principal', header: 'On', kind: 'money', value: (r) => r.principalPaise, width: 110 },
  { id: 'interest', header: 'Interest', kind: 'money', value: (r) => r.interestPaise, aggregate: 'sum', width: 110 },
  { id: 'gst', header: 'GST', kind: 'money', value: (r) => r.gstPaise, aggregate: 'sum', width: 90 },
  { id: 'status', header: 'Status', kind: 'text', value: (r) => (r.binned ? 'In the bin' : 'Live'), width: 90, cell: (r) => (r.binned ? <Badge tone="neutral">In the bin</Badge> : <Badge tone="success">Live</Badge>) }
])

type MonthRow = CollectionReport['months'][number]
const COLLECTION_COLUMNS = defineColumns<MonthRow>([
  { id: 'month', header: 'Month', kind: 'text', value: (r) => r.month, width: 120, hideable: false, text: (r) => toMonthLabel(r.month, 'long') },
  { id: 'opening', header: 'Opening', kind: 'money', value: (r) => r.opening, width: 120, defaultHidden: true },
  { id: 'sales', header: 'Credit sales', kind: 'money', value: (r) => r.sales, aggregate: 'sum', width: 124 },
  { id: 'collected', header: 'Collected', kind: 'money', value: (r) => r.collected, aggregate: 'sum', width: 124 },
  { id: 'due', header: 'Was due', kind: 'money', value: (r) => r.due, width: 124, defaultHidden: true },
  {
    id: 'efficiency', header: 'Efficiency', kind: 'number', value: (r) => (r.efficiency == null ? null : Math.round(r.efficiency * 1000) / 10), width: 104,
    text: (r) => pct(r.efficiency),
    cell: (r) => <span className={`num ${r.efficiency != null && r.efficiency < 0.5 ? 'text-cr' : ''}`}>{pct(r.efficiency)}</span>
  },
  { id: 'dso', header: 'DSO', kind: 'number', value: (r) => r.dso, width: 80, text: (r) => (r.dso == null ? '—' : `${r.dso} d`) },
  { id: 'closing', header: 'Closing', kind: 'money', value: (r) => r.closing, width: 124 },
  { id: 'b0', header: '0–30 d', kind: 'money', value: (r) => r.buckets[0], width: 100, group: 'Ageing at month end' },
  { id: 'b1', header: '31–60 d', kind: 'money', value: (r) => r.buckets[1], width: 100, group: 'Ageing at month end' },
  { id: 'b2', header: '61–90 d', kind: 'money', value: (r) => r.buckets[2], width: 100, group: 'Ageing at month end' },
  { id: 'b3', header: '90+ d', kind: 'money', value: (r) => r.buckets[3], width: 100, group: 'Ageing at month end' }
])

const TOP_COLUMNS = defineColumns<TopOverdueRow>([
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.name, minWidth: 160, hideable: false, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.name} /> },
  { id: 'overdue', header: 'Overdue', kind: 'money', value: (r) => r.overdue, aggregate: 'sum', width: 130, className: 'font-medium' },
  { id: 'total', header: 'Total due', kind: 'money', value: (r) => r.total, aggregate: 'sum', width: 130 },
  { id: 'days', header: 'Oldest', kind: 'number', value: (r) => r.maxOverdueDays, width: 90, text: (r) => `${r.maxOverdueDays} d` },
  { id: 'bill', header: 'Oldest bill', kind: 'text', value: (r) => r.oldestBill, width: 120 },
  { id: 'bills', header: 'Bills', kind: 'number', value: (r) => r.billCount, width: 70 },
  { id: 'lastReceipt', header: 'Last receipt', kind: 'date', value: (r) => r.lastReceiptDate ?? '', width: 110 },
  { id: 'promised', header: 'Promised', kind: 'date', value: (r) => r.promisedDate ?? '', width: 110 },
  { id: 'hold', header: 'Hold', kind: 'text', value: (r) => (r.hold ? 'On hold' : ''), width: 90, cell: (r) => (r.hold ? <Badge tone="danger">On hold</Badge> : null) }
])

// ---------------------------------------------------------------- tabs

function ControlTab(): React.JSX.Element {
  const to = useAsOn()
  const toast = useToasts()
  const qc = useQueryClient()
  const features = useFeatures()
  const { data, isLoading } = useQuery({ queryKey: ['creditControl', to], queryFn: () => receivablesApi.creditControl(to) })
  const { data: promised } = useQuery({ queryKey: ['promisedWeek', to], queryFn: () => receivablesApi.promisedThisWeek(to) })
  const rows = data ?? []
  const toggleHold = async (r: CreditControlRow): Promise<void> => {
    try {
      if (r.hold) {
        if (!(await confirmDialog({ title: 'Release credit hold', message: `Release ${r.name} from credit hold? New invoices will save again.`, confirmLabel: 'Release' }))) return
        await receivablesApi.setHold(r.ledgerId, false, '')
        toast.push('success', `${r.name} released from credit hold`)
      } else {
        const reason = await promptDialog({ title: `Put ${r.name} on credit hold`, message: 'New sales invoices to this party will be blocked until released (an owner can override one with a reason).', placeholder: 'Reason, e.g. 90+ days overdue', confirmLabel: 'Hold' })
        if (reason == null) return
        if (!reason.trim()) return void toast.push('error', 'Give a reason for the hold')
        await receivablesApi.setHold(r.ledgerId, true, reason)
        toast.push('success', `${r.name} is on credit hold`)
      }
      await qc.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const sum = (f: (r: CreditControlRow) => number): number => rows.reduce((s, r) => s + f(r), 0)
  return (
    <>
      <StatGrid className="mb-section">
        <StatTile label="Exposure" value={rupees(sum((r) => r.exposure))} hint={features.orders ? 'outstanding + open orders' : 'outstanding'} testId="cc-exposure" />
        <StatTile label="Overdue" value={rupees(sum((r) => r.overdue))} hint={`${rows.filter((r) => r.overdue > 0).length} parties`} />
        <StatTile label="On credit hold" value={String(rows.filter((r) => r.hold).length)} hint="new invoices blocked" testId="cc-holds" />
        <StatTile label="Promised this week" value={rupees(promised?.amount ?? 0)} hint={`${promised?.count ?? 0} bills${promised?.overdueCount ? ` · ${promised.overdueCount} broken` : ''}`} testId="cc-promised" />
      </StatGrid>
      <Panel>
        <DataTable
          viewId={`receivables-control-${features.orders ? 'orders' : 'plain'}`}
          testId="credit-control"
          ariaLabel="Credit control"
          columns={features.orders ? CONTROL_COLUMNS.on : CONTROL_COLUMNS.off}
          rows={rows}
          rowKey={(r) => r.ledgerId}
          rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
          loading={isLoading}
          empty={{ title: 'No customers with a balance, a limit or a hold' }}
          trailing={(r) => (
            <button type="button" data-testid="btn-credit-hold" className="text-hint text-blue hover:underline" onClick={() => void toggleHold(r)}>
              {r.hold ? 'Release' : 'Hold'}
            </button>
          )}
          trailingWidth={80}
          maxHeight="50vh"
          exportOptions={{ title: 'Credit control', periodLabel: `as on ${toDisplayDate(to)}`, filename: 'credit-control' }}
        />
      </Panel>
      <h2 className="mb-2 mt-section text-title font-semibold" id="promised-week">
        Promised this week {promised && <span className="text-detail font-normal text-muted">{toDisplayDate(promised.weekFrom)} – {toDisplayDate(promised.weekTo)}</span>}
      </h2>
      <Panel>
        <DataTable
          viewId="receivables-promised"
          testId="promised-week"
          ariaLabel="Promised this week"
          columns={PROMISE_COLUMNS}
          rows={promised?.rows ?? []}
          rowKey={(r) => r.id}
          empty={{ title: 'No payments promised this week', hint: 'Add a promised date on a bill in Outstandings (expand a party).' }}
          maxHeight="40vh"
          exportOptions={{ title: 'Promised this week', periodLabel: promised ? `${toDisplayDate(promised.weekFrom)} to ${toDisplayDate(promised.weekTo)}` : '', filename: 'promised-this-week' }}
        />
      </Panel>
    </>
  )
}

function RemindersTab(): React.JSX.Element {
  const { from } = useSession()
  const to = useAsOn()
  const toast = useToasts()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['reminderCandidates', to], queryFn: () => receivablesApi.reminderCandidates(to) })
  const { data: log, isLoading: logLoading } = useQuery({ queryKey: ['reminderLog', from, to], queryFn: () => receivablesApi.reminderLog(from, to) })
  const rows = data ?? []
  const send = async (r: ReminderCandidate, email: boolean): Promise<void> => {
    try {
      let force = false
      if (!r.allowed) {
        force = await confirmDialog({
          title: 'Reminded recently',
          message: `${r.name} was reminded on ${toDisplayDate(r.lastSent!)}. Send another now anyway?`,
          confirmLabel: 'Send anyway'
        })
        if (!force) return
      }
      const res = await receivablesApi.remind(r.ledgerId, to, email ? 'email' : 'pdf', force)
      if (email) window.open(res.mailto)
      toast.push('success', `${REMINDER_BUCKET_LABELS[res.bucket]} reminder for ${res.name} saved${email ? ' — email draft opened' : ''}`)
      await qc.invalidateQueries({ queryKey: ['reminderCandidates'] })
      await qc.invalidateQueries({ queryKey: ['reminderLog'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const bulk = async (): Promise<void> => {
    if (busy) return
    const due = rows.filter((r) => r.allowed).length
    if (!(await confirmDialog({ title: 'Generate reminders', message: `Generate ${due} reminder letter${due === 1 ? '' : 's'} as PDFs (parties reminded within the cadence window are skipped)?`, confirmLabel: 'Generate' }))) return
    setBusy(true)
    try {
      const res = await receivablesApi.remindBulk(to, 'pdf')
      toast.push('success', `${res.sent.length} reminder${res.sent.length === 1 ? '' : 's'} generated${res.skipped.length ? `, ${res.skipped.length} skipped (reminded recently)` : ''}`)
      await qc.invalidateQueries({ queryKey: ['reminderCandidates'] })
      await qc.invalidateQueries({ queryKey: ['reminderLog'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const count = (b: ReminderBucket): number => rows.filter((r) => r.bucket === b).length
  return (
    <>
      <StatGrid className="mb-section">
        <StatTile label="Gentle" value={String(count('gentle'))} hint="first overdue days" />
        <StatTile label="Firm" value={String(count('firm'))} hint="second reminder" />
        <StatTile label="Final" value={String(count('final'))} hint="final notice" />
        <StatTile label="Overdue" value={rupees(rows.reduce((s, r) => s + r.overdue, 0))} hint={`as on ${toDisplayDate(to)}`} />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="receivables-reminders"
          testId="reminder-candidates"
          ariaLabel="Reminder letters"
          columns={CANDIDATE_COLUMNS}
          rows={rows}
          rowKey={(r) => r.ledgerId}
          rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
          loading={isLoading}
          empty={{ title: `Nothing overdue as on ${toDisplayDate(to)}` }}
          toolbarEnd={
            <Button size="sm" variant="primary" data-testid="btn-reminders-bulk" disabled={busy || rows.every((r) => !r.allowed)} onClick={() => void bulk()}>
              Generate all due
            </Button>
          }
          trailing={(r) => (
            <span className="flex justify-end gap-3">
              <button type="button" data-testid="btn-reminder-pdf" className="text-hint text-blue hover:underline" onClick={() => void send(r, false)}>PDF</button>
              <button type="button" data-testid="btn-reminder-email" className="text-hint text-blue hover:underline" onClick={() => void send(r, true)}>Email</button>
            </span>
          )}
          trailingWidth={100}
          maxHeight="45vh"
          exportOptions={{ title: 'Reminder letters due', periodLabel: `as on ${toDisplayDate(to)}`, filename: 'reminders-due' }}
        />
      </Panel>
      <h2 className="mb-2 mt-section text-title font-semibold">Reminder log <span className="text-detail font-normal text-muted">{toDisplayDate(from)} – {toDisplayDate(to)}</span></h2>
      <Panel>
        <DataTable
          viewId="receivables-reminder-log"
          testId="reminder-log"
          ariaLabel="Reminder log"
          columns={LOG_COLUMNS}
          rows={log ?? []}
          rowKey={(r) => r.id}
          loading={logLoading}
          empty={{ title: 'No reminders sent in this period' }}
          trailing={(r) =>
            r.documentPath ? (
              <button type="button" className="text-hint text-blue hover:underline" onClick={() => void receivablesApi.reveal(r.documentPath!).catch((e: Error) => toast.push('error', e.message))}>
                Show
              </button>
            ) : null
          }
          trailingWidth={60}
          maxHeight="40vh"
          exportOptions={{ title: 'Reminder log', periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`, filename: 'reminder-log' }}
        />
      </Panel>
    </>
  )
}

function InterestTab({ gst }: { gst: boolean }): React.JSX.Element {
  const to = useAsOn()
  const toast = useToasts()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['interestPreview', to, gst], queryFn: () => receivablesApi.interestPreview(to, gst) })
  const { data: charges } = useQuery({ queryKey: ['interestCharges'], queryFn: () => receivablesApi.interestCharges() })
  const rows = data ?? []
  const parties = useMemo(() => [...new Set(rows.map((r) => r.ledgerId))], [rows])
  const post = async (ledgerIds: number[]): Promise<void> => {
    if (busy || !ledgerIds.length) return
    const sel = rows.filter((r) => ledgerIds.includes(r.ledgerId))
    const total = sel.reduce((s, r) => s + r.totalPaise, 0)
    const ok = await confirmDialog({
      title: 'Post interest',
      message: `Post ${ledgerIds.length} debit note${ledgerIds.length === 1 ? '' : 's'} for ${rupees(total)} (${sel.length} bill${sel.length === 1 ? '' : 's'}${gst ? ', GST included' : ', no GST'}) dated ${toDisplayDate(to)}?`,
      confirmLabel: 'Post'
    })
    if (!ok) return
    setBusy(true)
    try {
      const numbers: string[] = []
      for (const id of ledgerIds) {
        const res = await receivablesApi.postInterest({ asOn: to, ledgerId: id, keys: sel.filter((r) => r.ledgerId === id).map((r) => r.key), gstOnInterest: gst })
        numbers.push(res.number)
      }
      toast.push('success', `Debit note${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')} posted`)
      await qc.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <StatGrid className="mb-section">
        <StatTile label="Interest" value={rupees(rows.reduce((s, r) => s + r.interestPaise, 0))} hint={`${rows.length} bills · ${parties.length} parties`} testId="interest-total" />
        <StatTile label="GST on interest" value={rupees(rows.reduce((s, r) => s + r.gstPaise, 0))} hint={gst ? 'at the supply’s rate (s.15(2)(d))' : 'off — Options'} />
        <StatTile label="Debit notes" value={rupees(rows.reduce((s, r) => s + r.totalPaise, 0))} hint={`as on ${toDisplayDate(to)}`} />
        <StatTile label="Charged so far" value={rupees((charges ?? []).filter((c) => !c.binned).reduce((s, c) => s + c.interestPaise, 0))} hint={`${(charges ?? []).filter((c) => !c.binned).length} bill-periods`} />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="receivables-interest"
          testId="interest-preview"
          ariaLabel="Interest on overdue bills"
          columns={INTEREST_COLUMNS}
          rows={rows}
          rowKey={(r) => r.key}
          rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
          loading={isLoading}
          empty={{ title: 'No interest due', hint: 'Set an interest rate (and grace days) on a customer ledger; bills past due + grace accrue simple interest.' }}
          toolbarEnd={
            <Button size="sm" variant="primary" data-testid="btn-interest-post-all" disabled={busy || !rows.length} onClick={() => void post(parties)}>
              Post all
            </Button>
          }
          trailing={(r) => (
            <button type="button" data-testid="btn-interest-post" className="text-hint text-blue hover:underline" disabled={busy} onClick={() => void post([r.ledgerId])}>
              Post party
            </button>
          )}
          trailingWidth={90}
          maxHeight="45vh"
          exportOptions={{ title: 'Interest on overdue bills', periodLabel: `as on ${toDisplayDate(to)}`, filename: 'interest-preview' }}
        />
      </Panel>
      <h2 className="mb-2 mt-section text-title font-semibold">Charged</h2>
      <Panel>
        <DataTable
          viewId="receivables-interest-charged"
          testId="interest-charges"
          ariaLabel="Interest charged"
          columns={CHARGE_COLUMNS}
          rows={charges ?? []}
          rowKey={(r) => r.id}
          empty={{ title: 'No interest charged yet' }}
          maxHeight="35vh"
          exportOptions={{ title: 'Interest charged', periodLabel: '', filename: 'interest-charged' }}
        />
      </Panel>
    </>
  )
}

function CollectionsTab(): React.JSX.Element {
  const { from } = useSession()
  // Months after today have nothing to measure yet — the report runs to today at the latest.
  const asOn = useAsOn()
  const to = asOn
  const { data, isLoading } = useQuery({ queryKey: ['collections', from, to], queryFn: () => receivablesApi.collections(from, to) })
  const { data: top, isLoading: topLoading } = useQuery({ queryKey: ['topOverdue', asOn], queryFn: () => receivablesApi.topOverdue(asOn, 25) })
  const months = data?.months ?? []
  const last = months[months.length - 1]
  const withDso = months.filter((m) => m.dso != null)
  const withEff = months.filter((m) => m.efficiency != null)
  return (
    <>
      <StatGrid className="mb-section">
        <StatTile label="DSO (latest month)" value={last?.dso == null ? '—' : `${last.dso} d`} hint={withDso.length ? `average ${Math.round((withDso.reduce((s, m) => s + m.dso!, 0) / withDso.length) * 10) / 10} d` : 'no sales'} testId="collections-dso" />
        <StatTile label="Collection efficiency" value={pct(last?.efficiency ?? null)} hint={withEff.length ? `average ${pct(withEff.reduce((s, m) => s + m.efficiency!, 0) / withEff.length)}` : 'nothing due'} />
        <StatTile label="Collected" value={rupees(months.reduce((s, m) => s + m.collected, 0))} hint="in the period" />
        <StatTile label="90+ days" value={rupees(last?.buckets[3] ?? 0)} hint="at the period end" />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="receivables-collections"
          testId="collections"
          ariaLabel="Collections by month"
          columns={COLLECTION_COLUMNS}
          rows={months}
          rowKey={(r) => r.month}
          loading={isLoading}
          empty={{ title: 'No months in the period' }}
          maxHeight="45vh"
          exportOptions={{ title: 'Collections by month', periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`, filename: 'collections' }}
        />
      </Panel>
      <h2 className="mb-2 mt-section text-title font-semibold">Top overdue parties <span className="text-detail font-normal text-muted">as on {toDisplayDate(asOn)}</span></h2>
      <Panel>
        <DataTable
          viewId="receivables-top-overdue"
          testId="top-overdue"
          ariaLabel="Top overdue parties"
          columns={TOP_COLUMNS}
          rows={top ?? []}
          rowKey={(r) => r.ledgerId}
          loading={topLoading}
          empty={{ title: 'Nothing overdue' }}
          maxHeight="40vh"
          exportOptions={{ title: 'Top overdue parties', periodLabel: `as on ${toDisplayDate(asOn)}`, filename: 'top-overdue' }}
        />
      </Panel>
    </>
  )
}

// ---------------------------------------------------------------- screen

const TABS: { id: ReceivablesTab; label: string }[] = [
  { id: 'control', label: 'Credit control' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'interest', label: 'Interest' },
  { id: 'collections', label: 'Collections' }
]

const AREA: Record<ReceivablesTab, string> = { control: 'credit-control', reminders: 'reminder-candidates', interest: 'interest-preview', collections: 'collections' }

export function ReceivablesScreen({ tab: initialTab = 'control' }: { tab?: ReceivablesTab }): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const qc = useQueryClient()
  const [tab, setTab] = useState<ReceivablesTab>(initialTab)
  const opts = useScreenOptions('receivables', {})
  const { data: cfg } = useQuery({ queryKey: ['receivablesConfig'], queryFn: receivablesApi.config })
  const config = cfg?.config
  const [gapText, setGapText] = useState<string | null>(null)
  const saveConfig = async (patch: (c: NonNullable<typeof config>) => NonNullable<typeof config>): Promise<void> => {
    if (!config) return
    try {
      await receivablesApi.setConfig(patch(config))
      await qc.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const asOnDate = useAsOn()
  const asOn = tab === 'collections' ? `${toDisplayDate(from)} to ${toDisplayDate(asOnDate)}` : `as on ${toDisplayDate(asOnDate)}`
  return (
    <Page width="wide">
      <PageHeader
        title="Credit control"
        period={asOn}
        tabs={<TabBar screen="receivables" tabs={TABS} active={tab} onSelect={setTab} />}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod asOn={tab === 'control' || tab === 'interest'} />
              <OptionsTable area={AREA[tab]} />
              {tab === 'reminders' && config && (
                <DrawerSection title="Cadence" testId="options-reminder-cadence">
                  <label className="flex items-center gap-2 text-detail text-ink">
                    Don&apos;t remind a party again within
                    <TextInput
                      className="num w-16 text-right"
                      data-testid="input-reminder-gap"
                      value={gapText ?? String(config.minDaysBetweenReminders)}
                      onChange={(e) => setGapText(e.target.value)}
                      onBlur={() => {
                        const n = Number(gapText)
                        if (gapText != null && Number.isInteger(n) && n >= 0 && n <= 90) void saveConfig((c) => ({ ...c, minDaysBetweenReminders: n }))
                        setGapText(null)
                      }}
                    />
                    days
                  </label>
                  <p className="text-hint text-muted">
                    Letters by the oldest overdue bill: gentle, firm from {config.firmFromDays} days, final from {config.finalFromDays} days. Templates and thresholds: Settings → Receivables.
                  </p>
                </DrawerSection>
              )}
              {tab === 'interest' && config && (
                <DrawerSection title="GST on interest" testId="options-interest-gst">
                  <Checkbox
                    label="Charge GST on the interest (at the original supply’s rate)"
                    checked={config.interest.gstOnInterest}
                    onChange={(v) => void saveConfig((c) => ({ ...c, interest: { ...c.interest, gstOnInterest: v } }))}
                    testId="input-interest-gst"
                  />
                  <ul className="flex flex-col gap-1.5 text-hint text-muted" data-testid="interest-sources">
                    {(cfg?.sources ?? []).map((s) => (
                      <li key={s.id}>
                        {!s.verified && <Badge tone="warning">Unverified</Badge>} {s.rule}
                        <span className="block italic">{s.citation}</span>
                      </li>
                    ))}
                  </ul>
                </DrawerSection>
              )}
              {tab === 'collections' && (
                <DrawerSection title="How these are measured">
                  <p className="text-hint text-muted">
                    DSO = receivables at month end ÷ the month&apos;s credit sales (with tax, net of credit notes) × days in the month.
                    Collection efficiency = (opening + sales − closing) ÷ (opening + sales − closing not yet due): of what was due, how much came in.
                    Receivables are the open bills of the Outstandings allocation.
                  </p>
                </DrawerSection>
              )}
              {tab === 'control' && (
                <DrawerSection title="About exposure">
                  <p className="text-hint text-muted">
                    Exposure is the ledger balance plus the open sales-order value (Orders &amp; challans on). Limit used = exposure ÷ credit limit.
                    DSO here is the balance ÷ the last 90 days&apos; sales × 90. A party on hold can&apos;t be invoiced until released; an owner can
                    override one invoice with a reason (audited).
                  </p>
                </DrawerSection>
              )}
            </>
          )
        }}
      />
      {tab === 'control' && <ControlTab />}
      {tab === 'reminders' && <RemindersTab />}
      {tab === 'interest' && <InterestTab gst={config?.interest.gstOnInterest ?? true} />}
      {tab === 'collections' && <CollectionsTab />}
    </Page>
  )
}
