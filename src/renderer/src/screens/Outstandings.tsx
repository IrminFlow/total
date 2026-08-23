import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts, type ToastState } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, SkeletonRows, useTableNav } from '../components/ui'
import { TabBar } from '../components/TabBar'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { buildReminder } from '@shared/outstanding'
import type { OutstandingBill } from '@shared/reports'

const EXPORT_COLUMNS: PdfColumn[] = [
  { label: 'Party', align: 'l' },
  { label: '0–30 d', align: 'r' },
  { label: '31–60 d', align: 'r' },
  { label: '61–90 d', align: 'r' },
  { label: '90+ d', align: 'r' },
  { label: 'Pending', align: 'r' }
]

/**
 * Send a payment reminder.
 *
 * WhatsApp when the party has a usable number, email otherwise. That order is not a preference:
 * in this market almost nobody chases a payment by email, and the number is the reason the
 * ledger gained a phone field. The body is identical either way, and is copied to the clipboard
 * so the user can paste it anywhere the two channels do not reach.
 */
async function remind(
  companyName: string,
  party: { name: string; phone: string | null; email: string | null },
  bills: OutstandingBill[],
  toast: ToastState
): Promise<void> {
  const reminder = buildReminder({ name: companyName }, party, bills)
  let copied = true
  try {
    await navigator.clipboard.writeText(reminder.body)
  } catch {
    // Clipboard access can fail in some sandboxes — the draft still carries the full text.
    copied = false
  }

  if (reminder.whatsapp) {
    window.open(reminder.whatsapp)
    toast.push('success', `WhatsApp opened for ${party.name}${copied ? ' — text also copied' : ''}`)
    return
  }

  window.open(reminder.mailto)
  toast.push(
    copied ? 'success' : 'warning',
    party.phone
      ? `${party.name}'s phone number isn't one WhatsApp can use — opened an email draft instead`
      : `No phone number for ${party.name} — opened an email draft. Add one in Masters to send on WhatsApp.`
  )
}

export function OutstandingsScreen(): React.JSX.Element {
  const { to, info } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [side, setSide] = useState<'receivable' | 'payable'>('receivable')
  const [openParty, setOpenParty] = useState<number | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['outstandings', side, to],
    queryFn: () => api.analysis.outstandings(side, to)
  })
  const parties = data ?? []
  // Enter expands the party's bill breakdown, matching the click.
  const table = useTableNav(parties, {
    rowId: (p) => p.ledgerId,
    onEnter: (p) => setOpenParty((cur) => (cur === p.ledgerId ? null : p.ledgerId))
  })
  const total = parties.reduce((s, p) => s + p.pending, 0)
  const bucketTotals = [0, 1, 2, 3].map((i) => parties.reduce((s, p) => s + p.buckets[i as 0 | 1 | 2 | 3], 0))

  const periodLabel = `as on ${toDisplayDate(to)}`
  const exportRows: PdfRow[] = [
    ...parties.map((p) => ({
      cells: [
        p.name,
        formatPaise(p.buckets[0], { zeroDash: true }),
        formatPaise(p.buckets[1], { zeroDash: true }),
        formatPaise(p.buckets[2], { zeroDash: true }),
        formatPaise(p.buckets[3], { zeroDash: true }),
        formatPaise(p.pending, { zeroDash: true })
      ]
    })),
    {
      cells: [
        'Total',
        formatPaise(bucketTotals[0]!, { zeroDash: true }),
        formatPaise(bucketTotals[1]!, { zeroDash: true }),
        formatPaise(bucketTotals[2]!, { zeroDash: true }),
        formatPaise(bucketTotals[3]!, { zeroDash: true }),
        formatPaise(total, { zeroDash: true })
      ],
      bold: true,
      rule: true
    }
  ]

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <TabBar
              screen="outstandings"
              tabs={[
                { id: 'receivable', label: 'Receivables' },
                { id: 'payable', label: 'Payables' }
              ]}
              active={side}
              onSelect={setSide}
            />
            <Button
              variant="ghost"
              onClick={() =>
                void printReport(
                  { title: side === 'receivable' ? 'Receivables · ageing' : 'Payables · ageing', periodLabel, columns: EXPORT_COLUMNS, rows: exportRows },
                  toast
                )
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void csvReport(EXPORT_COLUMNS.map((c) => c.label), exportRows.map((r) => r.cells), `outstandings-${side}`, toast)
              }
            >
              CSV
            </Button>
          </div>
        }
      >
        {side === 'receivable' ? 'Receivables' : 'Payables'} · ageing
      </SectionTitle>
      <Panel scroll={{ maxH: '70vh' }}>
        {isLoading ? (
          <SkeletonRows />
        ) : parties.length === 0 ? (
          <EmptyState title={`Nothing ${side === 'receivable' ? 'to collect' : 'to pay'} as on ${toDisplayDate(to)}`} />
        ) : (
          <div className="overflow-x-auto">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Party</th>
                <th className="w-32">Due date</th>
                <th className="r w-32">0–30 d</th>
                <th className="r w-32">31–60 d</th>
                <th className="r w-32">61–90 d</th>
                <th className="r w-32">90+ d</th>
                <th className="r w-36">Pending</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-outstandings">
              {parties.map((p, i) => (
                <Fragment key={p.ledgerId}>
                  <tr {...table.rowProps(i, p)}>
                    <td>
                      <span className="mr-1.5 inline-block w-3 text-label text-muted">{openParty === p.ledgerId ? '▾' : '▸'}</span>
                      {p.name}
                    </td>
                    <td></td>
                    <td className="r"><Money paise={p.buckets[0]} /></td>
                    <td className="r"><Money paise={p.buckets[1]} /></td>
                    <td className="r"><Money paise={p.buckets[2]} /></td>
                    <td className="r"><span className={p.buckets[3] > 0 ? 'text-cr' : ''}><Money paise={p.buckets[3]} /></span></td>
                    <td className="r font-medium"><Money paise={p.pending} /></td>
                    <td className="r">
                      <button
                        data-testid="btn-outstandings-remind"
                        className="text-hint text-blue hover:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          void remind(
                            info?.name ?? '',
                            { name: p.name, phone: p.phone ?? null, email: p.email ?? null },
                            p.bills,
                            toast
                          )
                        }}
                      >
                        {p.phone ? 'WhatsApp' : 'Remind'}
                      </button>
                    </td>
                  </tr>
                  {openParty === p.ledgerId &&
                    p.bills.map((b, i) => (
                      <tr key={`${p.ledgerId}-${i}`} className={`bg-panel2/50 ${b.overdueDays > 0 ? 'text-cr' : ''}`}>
                        <td className="pl-9 text-muted">
                          <button
                            className="hover:text-blue hover:underline"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (b.voucherId) nav.go({ name: 'voucher-entry', voucherId: b.voucherId })
                            }}
                          >
                            {b.number}
                          </button>
                          <span className="num ml-3 text-hint">{toDisplayDate(b.date)} · {b.ageDays} days</span>
                        </td>
                        <td className="num text-hint">
                          {b.dueDate ? toDisplayDate(b.dueDate) : ''}
                          {b.overdueDays > 0 && <span className="ml-1.5">· {b.overdueDays}d overdue</span>}
                        </td>
                        <td colSpan={4}></td>
                        <td className="r"><Money paise={b.pending} /></td>
                        <td></td>
                      </tr>
                    ))}
                </Fragment>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td></td>
                <td className="r"><Money paise={bucketTotals[0]!} /></td>
                <td className="r"><Money paise={bucketTotals[1]!} /></td>
                <td className="r"><Money paise={bucketTotals[2]!} /></td>
                <td className="r"><Money paise={bucketTotals[3]!} /></td>
                <td className="r"><Money paise={total} /></td>
                <td></td>
              </tr>
            </tbody>
          </table>
          </div>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Ageing buckets count days overdue past each bill&apos;s due date (or the bill date when none is set). Receipts settle
        the oldest bills first. Click a party to see its open bills; click a bill number to open the voucher.
      </p>
    </div>
  )
}
