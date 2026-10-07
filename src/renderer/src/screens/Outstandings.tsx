import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts, type ToastState } from '../state/stores'
import { useFeatures } from '../lib/useFeatures'
import { Button, DrawerSection, Money, Page, PageHeader, Panel } from '../components/ui'
import { OptionToggle, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { TabBar } from '../components/TabBar'
import { DataTable, defineColumns, type RowKey } from '../components/table'
import { toDisplayDate } from '@shared/dates'
import { buildReminder } from '@shared/outstanding'
import type { OutstandingBill, OutstandingParty } from '@shared/reports'
import { LedgerLink, VoucherLink } from '../components/links'
import { openLedgerStatement } from '../lib/drill'

const bucket = (i: 0 | 1 | 2 | 3) => (p: OutstandingParty) => p.buckets[i]

export const OUTSTANDING_COLUMNS = defineColumns<OutstandingParty>([
  {
    id: 'party',
    header: 'Party',
    kind: 'text',
    value: (p) => p.name,
    hideable: false,
    groupable: false,
    minWidth: 170, // 170 + 4 × 130 + 150 + chevron + 150 actions = the 1022px panel at 1440 wide
    // The row expands its bills; the party NAME opens the ledger's edit window.
    cell: (p) => <LedgerLink ledgerId={p.ledgerId} name={p.name} />
  },
  { id: 'bills', header: 'Bills', kind: 'number', value: (p) => p.bills.length, aggregate: 'sum', width: 80, defaultHidden: true },
  { id: 'b0', header: '0–30 d', kind: 'money', value: bucket(0), aggregate: 'sum', width: 130 },
  { id: 'b1', header: '31–60 d', kind: 'money', value: bucket(1), aggregate: 'sum', width: 130 },
  { id: 'b2', header: '61–90 d', kind: 'money', value: bucket(2), aggregate: 'sum', width: 130 },
  {
    id: 'b3',
    header: '90+ d',
    kind: 'money',
    value: bucket(3),
    aggregate: 'sum',
    width: 130,
    cell: (p) => (
      <span className={p.buckets[3] > 0 ? 'text-cr' : ''}>
        <Money paise={p.buckets[3]} />
      </span>
    )
  },
  { id: 'pending', header: 'Pending', kind: 'money', value: (p) => p.pending, aggregate: 'sum', width: 150, className: 'font-medium' }
])

async function remind(companyName: string, partyName: string, bills: OutstandingBill[], toast: ToastState): Promise<void> {
  const reminder = buildReminder({ name: companyName }, { name: partyName, email: null }, bills)
  let copied = true
  try {
    await navigator.clipboard.writeText(reminder.body)
  } catch {
    // Clipboard access can fail in some sandboxes — the mailto still opens with the body.
    copied = false
  }
  window.open(reminder.mailto)
  if (copied) toast.push('success', 'Reminder copied — email draft opened')
  else toast.push('warning', "Couldn't copy to the clipboard — the email draft still has the full text")
}

/** A party's open bills, shown in its expanded detail row. */
function BillsDetail({ party }: { party: OutstandingParty }): React.JSX.Element {
  return (
    <table className="ledger-table" data-testid={`outstandings-bills-${party.ledgerId}`}>
      <thead>
        <tr>
          <th scope="col">Bill</th>
          <th scope="col" className="w-32">Bill date</th>
          <th scope="col" className="r w-24">Age</th>
          <th scope="col" className="w-48">Due date</th>
          <th scope="col" className="r w-36">Bill amount</th>
          <th scope="col" className="r w-36">Pending</th>
        </tr>
      </thead>
      <tbody>
        {party.bills.map((b, i) => (
          <tr key={i} className={b.overdueDays > 0 ? 'text-cr' : ''}>
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
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function OutstandingsScreen(): React.JSX.Element {
  const { to, info } = useSession()
  const toast = useToasts()
  const [side, setSide] = useState<'receivable' | 'payable'>('receivable')
  const features = useFeatures()
  const nav = useNav()
  const [expanded, setExpanded] = useState<Set<RowKey>>(() => new Set())
  const { data, isLoading } = useQuery({
    queryKey: ['outstandings', side, to],
    queryFn: () => api.analysis.outstandings(side, to)
  })
  const opts = useScreenOptions('outstandings', { overdueOnly: false })
  // "Over 30 days only": parties with something in the 31–60, 61–90 or 90+ buckets.
  const parties = (data ?? []).filter((p) => !opts.options.overdueOnly || p.buckets[1] + p.buckets[2] + p.buckets[3] > 0)
  const periodLabel = `as on ${toDisplayDate(to)}`
  const title = side === 'receivable' ? 'Receivables' : 'Payables'

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
                  settle the oldest bills first. Click a party row to see its open bills, its name to edit the ledger, or
                  Statement for its ledger statement; click a bill number to open the voucher.
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
                title={`Open ${p.name} statement`}
                onClick={() => openLedgerStatement(p.ledgerId)}
              >
                Statement
              </button>
              <button
                type="button"
                data-testid="btn-outstandings-remind"
                className="text-hint text-blue hover:underline"
                onClick={() => void remind(info?.name ?? '', p.name, p.bills, toast)}
              >
                Remind
              </button>
            </span>
          )}
          trailingWidth={150}
          maxHeight="70vh"
          exportOptions={{ title: `${title} · ageing`, periodLabel, filename: `outstandings-${side}` }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Buckets are days overdue past each bill&apos;s due date. Click a party to see its open bills · F12 for options.</p>
    </Page>
  )
}
