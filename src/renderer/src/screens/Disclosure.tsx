import { Fragment, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Lut } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  Button,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  SectionTitle,
  SkeletonRows,
  TextInput
} from '../components/ui'
import { confirmDialog } from '../lib/dialogs'
import { useStickyTab } from '../lib/useStickyTab'
import { toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { csvReport, printReport } from '../lib/reportExport'

/**
 * The things an auditor asks for that the books could not previously say about themselves.
 *
 * Each of these is read-only and none of them posts. They exist because the answer was always in
 * the data and always had to be assembled by a person the week before a filing.
 */
type Tab = 'related' | 'audit' | 'lut' | 'einvoice'

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'related', label: 'Related parties', hint: 'Every transaction with a director, a relative, or a company under common control' },
  { id: 'audit', label: 'Audit trail', hint: 'What the log covers, measured from the log rather than claimed about it' },
  { id: 'lut', label: 'LUT', hint: 'The undertaking an exporter supplies zero-rated under' },
  { id: 'einvoice', label: 'IRP window', hint: 'Invoices running out of time to reach the portal' }
]

export function DisclosureScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab<Tab>('disclosure-tab', TABS.map((t) => t.id), 'related')
  const active = TABS.find((t) => t.id === tab) ?? TABS[0]!

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <div className="flex flex-wrap gap-1" role="group" aria-label="Disclosure view">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`tab-disclosure-${t.id}`}
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
        Disclosure
      </SectionTitle>
      <p className="mb-3 text-hint text-muted">{active.hint}</p>

      {tab === 'related' && <RelatedPartiesTab />}
      {tab === 'audit' && <AuditStatementTab />}
      {tab === 'lut' && <LutTab />}
      {tab === 'einvoice' && <EInvoiceWindowTab />}
    </div>
  )
}

// ---------- related parties (#364) ----------

function RelatedPartiesTab(): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const [expanded, setExpanded] = useState<number | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['relatedParties', from, to],
    queryFn: () => api.disclosure.relatedParties(from, to)
  })

  const rows = data?.rows ?? []

  return (
    <>
      <div className="mb-3 flex justify-end gap-2">
        <Button
          variant="ghost"
          disabled={!rows.length}
          onClick={() =>
            void csvReport(
              ['Party', 'Relationship', 'Debits', 'Credits', 'Closing balance'],
              rows.map((r) => [
                r.name,
                r.relationship ?? '',
                formatPaise(r.debits),
                formatPaise(r.credits),
                formatPaise(r.closingBalance)
              ]),
              'related-parties',
              toast
            )
          }
        >
          CSV
        </Button>
        <Button
          variant="ghost"
          disabled={!rows.length}
          onClick={() =>
            void printReport(
              {
                title: 'Related-party transactions',
                periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`,
                columns: [
                  { label: 'Party', align: 'l' },
                  { label: 'Relationship', align: 'l' },
                  { label: 'Debits', align: 'r' },
                  { label: 'Credits', align: 'r' },
                  { label: 'Closing', align: 'r' }
                ],
                rows: rows.map((r) => ({
                  cells: [
                    r.name,
                    r.relationship ?? '—',
                    formatPaise(r.debits),
                    formatPaise(r.credits),
                    formatPaise(r.closingBalance)
                  ]
                })),
                footNote: 'Parties flagged as related in Masters. A party with no transactions is disclosed as nil.',
                filename: 'related-parties'
              },
              toast
            )
          }
        >
          PDF
        </Button>
      </div>

      <Panel scroll={{ maxH: '62vh' }} data-testid="panel-related-parties">
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nobody flagged as related"
            hint="Mark a director, a relative or a company under common control on the party in Masters, and the schedule builds itself."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Party</th>
                <th scope="col" className="w-56">Relationship</th>
                <th scope="col" className="r w-32">Debits</th>
                <th scope="col" className="r w-32">Credits</th>
                <th scope="col" className="r w-36">Closing</th>
              </tr>
            </thead>
            <tbody data-testid="rows-related-parties">
              {rows.map((r) => (
                <Fragment key={r.ledgerId}>
                  <tr className="cursor-pointer" onClick={() => setExpanded(expanded === r.ledgerId ? null : r.ledgerId)}>
                    <td>
                      <span className="mr-1.5 inline-block w-3 text-muted">
                        {r.transactions.length === 0 ? '' : expanded === r.ledgerId ? '−' : '+'}
                      </span>
                      {r.name}
                    </td>
                    <td className="text-muted">{r.relationship ?? '—'}</td>
                    <td className="r">{r.debits > 0 ? <Money paise={r.debits} /> : <span className="text-muted">–</span>}</td>
                    <td className="r">{r.credits > 0 ? <Money paise={r.credits} /> : <span className="text-muted">–</span>}</td>
                    <td className="r"><Money paise={r.closingBalance} signed /></td>
                  </tr>
                  {expanded === r.ledgerId &&
                    r.transactions.map((t) => (
                      <tr
                        key={t.voucherId}
                        className="cursor-pointer text-small text-muted"
                        onClick={() => nav.go({ name: 'voucher-entry', voucherId: t.voucherId })}
                      >
                        <td className="pl-8">
                          {t.number} · {toDisplayDate(t.date)}
                        </td>
                        <td className="capitalize">{t.kind.replace('_', ' ')}</td>
                        <td className="r">{t.amount > 0 ? <Money paise={t.amount} /> : ''}</td>
                        <td className="r">{t.amount < 0 ? <Money paise={-t.amount} /> : ''}</td>
                        <td />
                      </tr>
                    ))}
                </Fragment>
              ))}
              <tr className="total-row">
                <td colSpan={2}>Total · {rows.length} parties</td>
                <td className="r"><Money paise={data!.totalDebits} /></td>
                <td className="r"><Money paise={data!.totalCredits} /></td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </Panel>

      {data && data.dormant > 0 && (
        <p className="mt-2 text-hint text-muted">
          {data.dormant} flagged part{data.dormant === 1 ? 'y' : 'ies'} transacted nothing this
          period. They are listed anyway — a nil disclosure is still a disclosure.
        </p>
      )}
    </>
  )
}

// ---------- the audit trail, about itself (#365) ----------

function AuditStatementTab(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const { data, isLoading } = useQuery({
    queryKey: ['auditStatement', from, to],
    queryFn: () => api.disclosure.auditStatement(from, to)
  })

  if (isLoading || !data) return <SkeletonRows rows={6} />

  return (
    <>
      <Panel className="p-4" data-testid="panel-audit-statement">
        <p className="text-body">
          For the period <b>{toDisplayDate(data.from)}</b> to <b>{toDisplayDate(data.to)}</b>, this
          software recorded <b className="num">{data.entries.toLocaleString('en-IN')}</b> audit
          entries across <b>{data.entities.length}</b> kinds of record, made by{' '}
          <b>{data.users.length}</b> {data.users.length === 1 ? 'user' : 'users'}.
        </p>
        <p className="mt-2 text-body">
          The audit trail cannot be switched off. There is no setting for it and no code path that
          skips it; every write goes through the same function.
        </p>
        {data.firstEntry && (
          <p className="mt-2 text-body-sm text-muted">
            The log holds entries from {toDisplayDate(data.firstEntry.slice(0, 10))} to{' '}
            {toDisplayDate(data.lastEntry!.slice(0, 10))}.
          </p>
        )}
        {data.retentionDays !== null && (
          <p
            className={`mt-2 rounded-md px-3 py-2 text-body-sm ${
              data.retentionAffectsPeriod ? 'border border-cr/40 bg-cr/5 text-cr' : 'text-muted'
            }`}
            data-testid="audit-retention"
          >
            Entries older than {data.retentionDays} days are pruned.
            {data.retentionAffectsPeriod
              ? ' That reaches into the period above, so this statement does not cover all of it.'
              : ' The period above is inside that window.'}
          </p>
        )}
      </Panel>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Panel className="p-4">
          <div className="text-caption uppercase tracking-wide text-muted">What was changed</div>
          <table className="ledger-table mt-2">
            <tbody>
              {data.entities.length === 0 ? (
                <tr><td className="text-muted">Nothing in this period</td></tr>
              ) : (
                data.entities.map((e) => (
                  <tr key={e.entity}>
                    <td className="capitalize">{e.entity.replace('_', ' ')}</td>
                    <td className="r num">{e.entries.toLocaleString('en-IN')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
        <Panel className="p-4">
          <div className="text-caption uppercase tracking-wide text-muted">Who changed it</div>
          <table className="ledger-table mt-2">
            <tbody>
              {data.users.length === 0 ? (
                <tr><td className="text-muted">Nobody in this period</td></tr>
              ) : (
                data.users.map((u) => (
                  <tr key={u.userName}>
                    <td>{u.userName}</td>
                    <td className="r num">{u.entries.toLocaleString('en-IN')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
      </div>

      <div className="mt-3 flex justify-end">
        <Button
          variant="ghost"
          onClick={() =>
            void printReport(
              {
                title: 'Audit trail statement',
                periodLabel: `${toDisplayDate(data.from)} to ${toDisplayDate(data.to)}`,
                columns: [
                  { label: 'Item', align: 'l' },
                  { label: 'Entries', align: 'r' }
                ],
                rows: [
                  { cells: ['Total audit entries in the period', String(data.entries)], bold: true },
                  ...data.entities.map((e) => ({ cells: [`  ${e.entity}`, String(e.entries)] })),
                  { cells: ['Users who made changes', String(data.users.length)], bold: true },
                  ...data.users.map((u) => ({ cells: [`  ${u.userName}`, String(u.entries)] }))
                ],
                footNote:
                  'The audit trail cannot be disabled: there is no setting for it and no write path that skips it. Figures are measured from the log.',
                filename: 'audit-trail-statement'
              },
              toast
            )
          }
        >
          PDF for the auditor
        </Button>
      </div>
    </>
  )
}

// ---------- LUT (#357) ----------

function LutTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const { data: status } = useQuery({ queryKey: ['lutStatus'], queryFn: api.disclosure.lutStatus })
  const { data: luts } = useQuery({ queryKey: ['luts'], queryFn: api.disclosure.luts })

  const tone =
    status?.state === 'valid'
      ? 'border-dr/40 bg-dr/5 text-dr'
      : status?.state === 'expiring'
        ? 'border-amberbar/60 bg-amberbar/10 text-ink'
        : 'border-cr/40 bg-cr/5 text-cr'

  const remove = async (l: Lut): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Remove LUT',
      message: `Remove the LUT for FY ${l.fyStartYear}-${String(l.fyStartYear + 1).slice(2)}?`,
      confirmLabel: 'Remove',
      danger: true
    })
    if (!proceed) return
    await api.disclosure.deleteLut(l.fyStartYear)
    await queryClient.invalidateQueries({ queryKey: ['luts'] })
    await queryClient.invalidateQueries({ queryKey: ['lutStatus'] })
  }

  return (
    <>
      {status && (
        <div className={`mb-3 rounded-md border px-3.5 py-2.5 text-body-sm ${tone}`} data-testid="lut-status">
          {status.message}
        </div>
      )}

      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid="btn-lut-add" onClick={() => setAdding(true)}>
          Record a LUT
        </Button>
      </div>

      <Panel data-testid="panel-luts">
        {!luts?.length ? (
          <EmptyState
            title="No LUT recorded"
            hint="An exporter supplies without paying IGST only while a valid undertaking is on file."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-40">Financial year</th>
                <th scope="col">ARN</th>
                <th scope="col" className="w-32">Filed on</th>
                <th scope="col" className="w-32">Valid to</th>
                <th scope="col" className="w-24" />
              </tr>
            </thead>
            <tbody data-testid="rows-luts">
              {luts.map((l) => (
                <tr key={l.fyStartYear}>
                  <td className="num">
                    {l.fyStartYear}-{String(l.fyStartYear + 1).slice(2)}
                  </td>
                  <td className="num">{l.arn}</td>
                  <td className="num text-muted">{toDisplayDate(l.filedOn)}</td>
                  <td className="num text-muted">{toDisplayDate(`${l.fyStartYear + 1}-03-31`)}</td>
                  <td className="r">
                    <button className="text-small text-cr hover:underline" onClick={() => void remove(l)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <p className="mt-2 text-hint text-muted">
        A LUT covers one financial year and expires on 31 March whenever in that year it was filed.
        File the next one before 1 April: exports raised after it lapses are taxable, whatever the
        invoice says.
      </p>

      {adding && <LutModal onClose={() => setAdding(false)} />}
    </>
  )
}

function LutModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const today = todayISO()
  const [arn, setArn] = useState('')
  const [fy, setFy] = useState(() => {
    const [y, m] = today.split('-').map(Number)
    return (m as number) >= 4 ? (y as number) : (y as number) - 1
  })
  const [filedOn, setFiledOn] = useState(today)

  const submit = async (): Promise<void> => {
    if (!arn.trim()) return void toast.push('error', 'The ARN is on the acknowledgement from the portal')
    try {
      await api.disclosure.saveLut({ arn: arn.trim().toUpperCase(), fyStartYear: fy, filedOn })
      await queryClient.invalidateQueries({ queryKey: ['luts'] })
      await queryClient.invalidateQueries({ queryKey: ['lutStatus'] })
      toast.push('success', 'LUT recorded')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Record a LUT" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Financial year" hint="The year the undertaking covers">
          <TextInput
            data-testid="input-lut-fy"
            className="num text-right"
            inputMode="numeric"
            value={fy}
            onChange={(e) => setFy(Number(e.target.value.replace(/\D/g, '')) || fy)}
          />
        </Field>
        <Field label="ARN" hint="From the acknowledgement the portal gave you">
          <TextInput
            data-testid="input-lut-arn"
            className="num"
            value={arn}
            onChange={(e) => setArn(e.target.value.toUpperCase())}
            autoFocus
          />
        </Field>
        <Field label="Filed on">
          <TextInput type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-lut-save" onClick={() => void submit()}>
          Record
        </Button>
      </div>
    </Modal>
  )
}

// ---------- the IRP reporting window (#354) ----------

const URGENCY_CLASS: Record<string, string> = {
  expired: 'text-cr font-semibold',
  critical: 'text-cr',
  due: 'text-ink',
  fine: 'text-muted',
  reported: 'text-muted'
}

function EInvoiceWindowTab(): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const { data, isLoading } = useQuery({
    queryKey: ['eInvoiceWindow', from, to],
    queryFn: () => api.disclosure.eInvoiceWindow(from, to)
  })

  return (
    <>
      {data && !data.applies && (
        <div className="mb-3 rounded-md border border-line bg-panel2 px-3.5 py-2.5 text-body-sm text-muted">
          The 30-day reporting window applies above ₹10 crore of aggregate turnover. This company
          has not declared a band that reaches it, so nothing here is mandatory — it is shown so
          you can see what crossing the threshold would mean.
        </div>
      )}

      {data && data.expired > 0 && (
        <div className="mb-3 rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr" data-testid="irp-expired">
          <b>{data.expired}</b> invoice{data.expired === 1 ? '' : 's'} worth{' '}
          <Money paise={data.expiredValue} /> can no longer be reported at all. The portal refuses
          an IRN after 30 days, so those are not valid tax invoices for the buyer&rsquo;s credit.
        </div>
      )}

      <Panel scroll={{ maxH: '62vh' }} data-testid="panel-irp-window">
        {isLoading || !data ? (
          <SkeletonRows rows={5} />
        ) : data.rows.length === 0 ? (
          <EmptyState title="Everything reported" hint="No sales document is waiting on an IRN." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Date</th>
                <th scope="col" className="w-32">Number</th>
                <th scope="col">Party</th>
                <th scope="col" className="r w-36">Value</th>
                <th scope="col" className="w-28">Deadline</th>
                <th scope="col" className="r w-40">Time left</th>
              </tr>
            </thead>
            <tbody data-testid="rows-irp-window">
              {data.rows.map((r) => (
                <tr
                  key={r.voucherId}
                  className="cursor-pointer"
                  onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
                >
                  <td className="num text-muted">{toDisplayDate(r.date)}</td>
                  <td className="num">{r.number}</td>
                  <td>{r.party}</td>
                  <td className="r"><Money paise={r.value} /></td>
                  <td className="num text-muted">{toDisplayDate(r.deadline)}</td>
                  <td className={`r ${URGENCY_CLASS[r.urgency]}`}>{r.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <p className="mt-2 text-hint text-muted">
        A countdown rather than a report: by the time a missed window shows up in a monthly review
        it is already too late. There is no late fee and no appeal — the portal simply refuses the
        invoice.
      </p>
    </>
  )
}
