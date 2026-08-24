import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  AmountInput,
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  SectionTitle,
  Select,
  SkeletonRows,
  TextInput,
  useTableNav
} from '../components/ui'
import { fyFromStartYear, fyOf, toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { periodBounds, periodLabel, type Period } from '@shared/period'
import type { FilingRow } from '@shared/gst/filings'
import { lateCharge } from '@shared/gst/lateFee'
import { csvReport, printReport } from '../lib/reportExport'
import { useStickyTab } from '../lib/useStickyTab'
import { TabBar } from '../components/TabBar'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'

/**
 * The filing register.
 *
 * The app knew every due date and had nowhere to record that a return was actually filed, so
 * "did we file August?" was a question you answered by logging into the portal. This is the year
 * laid out one row per obligation, with the ARN against each and — for anything overdue — what it
 * costs to file today, because a deadline without a rupee figure attached is abstract.
 */
const STATUS_LABEL: Record<FilingRow['status'], string> = {
  filed: 'Filed',
  due: 'Due',
  overdue: 'Overdue',
  upcoming: 'Not yet'
}

const STATUS_CLASS: Record<FilingRow['status'], string> = {
  filed: 'text-dr',
  due: 'text-amber',
  overdue: 'text-cr font-semibold',
  upcoming: 'text-muted'
}

const COLUMNS: PdfColumn[] = [
  { label: 'Form', align: 'l' },
  { label: 'Period', align: 'l' },
  { label: 'Due', align: 'l' },
  { label: 'Status', align: 'l' },
  { label: 'Filed on', align: 'l' },
  { label: 'ARN', align: 'l' },
  { label: 'Tax paid', align: 'r' },
  { label: 'Late fee', align: 'r' },
  { label: 'Interest', align: 'r' }
]

function periodKindOf(key: string): Period {
  const marker = key.slice(5)
  if (marker === 'FY') return 'year'
  if (marker.startsWith('Q')) return 'quarter'
  if (marker.startsWith('H')) return 'half'
  return 'month'
}

const shortPeriod = (key: string): string => periodLabel(key, periodKindOf(key))

export function FilingsScreen(): React.JSX.Element {
  const { info, from, setPeriod } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [fyStartYear, setFyStartYear] = useState(fyOf(from).startYear)
  const [editing, setEditing] = useState<FilingRow | null>(null)
  const [tab, setTab] = useStickyTab<'register' | 'annual'>('filings', ['register', 'annual'], 'register')
  const [nilling, setNilling] = useState<FilingRow | null>(null)

  const registered = info?.gstRegistrationType !== 'unregistered'

  const { data: rows, isLoading } = useQuery({
    queryKey: ['filings', fyStartYear],
    queryFn: () => api.filings.register(fyStartYear),
    enabled: registered
  })

  const table = useTableNav(rows ?? [], {
    rowId: (r) => `${r.form}/${r.period}`,
    onEnter: (r) => setEditing(r)
  })

  const outstanding = useMemo(
    () => (rows ?? []).filter((r) => r.status === 'overdue' || r.status === 'due'),
    [rows]
  )
  const exposure = outstanding.reduce((sum, r) => sum + r.charge.totalPaise, 0)

  const years = useMemo(() => {
    const first = info?.booksFrom ?? fyStartYear
    const last = fyOf(todayISO()).startYear
    const out: number[] = []
    for (let y = Math.min(first, fyStartYear); y <= Math.max(last, fyStartYear); y++) out.push(y)
    return out
  }, [info?.booksFrom, fyStartYear])

  const csvRows = (rows ?? []).map((r) => [
    r.form,
    shortPeriod(r.period),
    toDisplayDate(r.date),
    STATUS_LABEL[r.status],
    r.record?.filedAt ? toDisplayDate(r.record.filedAt) : '',
    r.record?.arn ?? '',
    formatPaise(r.record?.taxPaid ?? 0),
    formatPaise(r.charge.lateFeePaise),
    formatPaise(r.charge.interestPaise)
  ])

  if (!registered) {
    return (
      <div className="mx-auto max-w-3xl">
        <SectionTitle>Filing register</SectionTitle>
        <Panel className="p-6">
          <EmptyState
            title="This company is not registered under GST"
            hint="An unregistered business files no GST returns. Add a GSTIN in Company details to track filings here."
          />
        </Panel>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <TabBar
              screen="filings"
              tabs={[
                { id: 'register', label: 'Register' },
                { id: 'annual', label: 'GSTR-9 papers' }
              ]}
              active={tab}
              onSelect={setTab}
            />
            <Select
              data-testid="select-filings-year"
              className="w-40"
              value={fyStartYear}
              onChange={(e) => setFyStartYear(Number(e.target.value))}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  FY {fyFromStartYear(y).label}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              disabled={!rows?.length}
              onClick={() =>
                void printReport(
                  {
                    title: `Filing register · FY ${fyFromStartYear(fyStartYear).label}`,
                    periodLabel: `as on ${toDisplayDate(todayISO())}`,
                    columns: COLUMNS,
                    rows: csvRows.map((cells) => ({ cells })),
                    filename: `filings-${fyFromStartYear(fyStartYear).label}`
                  },
                  toast
                )
              }
            >
              PDF
            </Button>
            <Button
              variant="ghost"
              disabled={!rows?.length}
              onClick={() =>
                void csvReport(
                  COLUMNS.map((c) => c.label),
                  csvRows,
                  `filings-${fyFromStartYear(fyStartYear).label}`,
                  toast
                )
              }
            >
              CSV
            </Button>
          </div>
        }
      >
        {tab === 'annual' ? 'GSTR-9 working papers' : 'Filing register'}
      </SectionTitle>

      {tab === 'annual' ? (
        <Gstr9Papers fyStartYear={fyStartYear} />
      ) : (
        <>
      {outstanding.length > 0 && (
        <div
          className="mb-4 flex items-baseline gap-3 rounded-md border border-amber/50 bg-amber/10 px-3.5 py-2.5 text-body-sm"
          data-testid="filings-exposure"
        >
          <span>
            <b>{outstanding.length}</b> return{outstanding.length === 1 ? '' : 's'} outstanding.
          </span>
          {exposure > 0 && (
            <span>
              Filing all of them today would cost <b><Money paise={exposure} /></b> in late fee and interest.
            </span>
          )}
        </div>
      )}

      <Panel>
        {isLoading || !rows ? (
          <SkeletonRows rows={10} />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing to file this year" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Form</th>
                <th scope="col">Period</th>
                <th scope="col" className="w-28">Due</th>
                <th scope="col" className="w-24">Status</th>
                <th scope="col" className="w-28">Filed on</th>
                <th scope="col">ARN</th>
                <th scope="col" className="r w-28">Late fee</th>
                <th scope="col" className="r w-28">Interest</th>
                <th scope="col" className="w-28" />
              </tr>
            </thead>
            <tbody data-testid="rows-filings">
              {rows.map((r, i) => (
                <tr key={`${r.form}/${r.period}`} {...table.rowProps(i, r)}>
                  <td>{r.form}</td>
                  <td>{shortPeriod(r.period)}</td>
                  <td className="num">{toDisplayDate(r.date)}</td>
                  <td className={STATUS_CLASS[r.status]}>
                    {STATUS_LABEL[r.status]}
                    {r.status === 'overdue' && (
                      <span className="ml-1 text-hint font-normal">{r.charge.daysLate}d</span>
                    )}
                  </td>
                  <td className="num">{r.record?.filedAt ? toDisplayDate(r.record.filedAt) : '–'}</td>
                  <td className="num text-hint">{r.record?.arn ?? '–'}</td>
                  <td className="r">
                    <Money paise={r.charge.lateFeePaise} />
                    {r.projected && r.charge.lateFeePaise > 0 && (
                      <span className="ml-1 text-hint text-muted" title="If filed today">
                        est
                      </span>
                    )}
                  </td>
                  <td className="r">
                    <Money paise={r.charge.interestPaise} />
                  </td>
                  <td className="whitespace-nowrap">
                    <Button
                      variant="ghost"
                      className="whitespace-nowrap"
                      data-testid={`btn-filing-edit-${r.form}-${r.period}`}
                      onClick={() => setEditing(r)}
                    >
                      {r.record?.filedAt ? 'Edit' : 'Mark filed'}
                    </Button>
                    {/* A period with nothing in it still owes a return -- a nil return is a
                        return -- so offer it directly rather than walking a filer through a form
                        whose every field is zero. */}
                    {!r.record?.filedAt && !r.hasEntries && r.status !== 'upcoming' && (
                      <Button
                        variant="ghost"
                        className="whitespace-nowrap"
                        data-testid={`btn-filing-nil-${r.form}-${r.period}`}
                        title="No entries in this period — file it nil"
                        onClick={() => setNilling(r)}
                      >
                        Nil
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <p className="mt-3 text-hint text-muted">
        Late fee and interest are estimates computed from the dates. The portal is authoritative
        and applies caps and waivers this cannot know about.
      </p>
        </>
      )}

      {nilling && (
        <NilFilingModal
          row={nilling}
          onClose={() => setNilling(null)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['filings'] })
            setNilling(null)
          }}
        />
      )}

      {editing && (
        <FilingModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['filings'] })
            setEditing(null)
          }}
          onOpenPeriod={(period) => {
            // The GSTR-1 screen reads the session period, so set it and go — the filing row and
            // the return it belongs to then agree about which dates are in scope.
            const { from: f, to } = periodBounds(period, periodKindOf(period))
            setPeriod(f, to)
            nav.go({ name: 'gstr1' })
          }}
        />
      )}
    </div>
  )
}

/**
 * Record a filing.
 *
 * Late fee and interest are shown live as the filed date changes, because that number is the
 * reason anyone opens this dialog: it is the difference between filing today and next week.
 */
function FilingModal({
  row,
  onClose,
  onSaved,
  onOpenPeriod
}: {
  row: FilingRow
  onClose: () => void
  onSaved: () => void
  onOpenPeriod: (period: string) => void
}): React.JSX.Element {
  const toast = useToasts()
  const [filedAt, setFiledAt] = useState(row.record?.filedAt ?? todayISO())
  const [arn, setArn] = useState(row.record?.arn ?? '')
  const [taxPaid, setTaxPaid] = useState<number | null>(row.record?.taxPaid ?? 0)
  const [notes, setNotes] = useState(row.record?.notes ?? '')
  const [touchedTax, setTouchedTax] = useState(false)

  // What the books say is payable, fetched for this one row: the register would otherwise run
  // twelve return builds to draw a table nobody has drilled into yet.
  const { data: liability } = useQuery({
    queryKey: ['filingLiability', row.form, row.period],
    queryFn: () => api.filings.liability(row.form, row.period)
  })

  // Prefill from the books once, and only into an untouched field on an unrecorded filing --
  // never over a figure the filer typed, and never over what was actually paid.
  useEffect(() => {
    if (touchedTax || row.record?.filedAt || liability?.taxPayable == null) return
    setTaxPaid(liability.taxPayable)
  }, [liability, touchedTax, row.record?.filedAt])

  const save = useMutation({
    mutationFn: (input: Parameters<typeof api.filings.record>[0]) => api.filings.record(input),
    onSuccess: () => {
      toast.push('success', `${row.form} ${shortPeriod(row.period)} recorded`)
      onSaved()
    },
    onError: (err: Error) => toast.push('error', err.message)
  })

  const dirty =
    filedAt !== (row.record?.filedAt ?? todayISO()) ||
    arn !== (row.record?.arn ?? '') ||
    (taxPaid ?? 0) !== (row.record?.taxPaid ?? 0) ||
    notes !== (row.record?.notes ?? '')

  const submit = (clear: boolean): void => {
    if (!clear && !arn.trim()) {
      // The ARN is the whole point of the record: without it "filed" is just a checkbox.
      toast.push('error', 'Enter the ARN the portal returned')
      return
    }
    save.mutate({
      form: row.form,
      period: row.period,
      dueDate: row.date,
      filedAt: clear ? null : filedAt,
      arn: clear ? null : arn.trim(),
      taxPaid: clear ? 0 : (taxPaid ?? 0),
      notes: notes.trim() || null
    })
  }

  return (
    <Modal title={`${row.form} — ${shortPeriod(row.period)}`} onClose={onClose} dirty={dirty}>
      <div className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between text-body-sm">
          <span className="text-muted">Due {toDisplayDate(row.date)}</span>
          <button
            className="text-small text-blue hover:underline"
            data-testid="btn-filing-open-period"
            onClick={() => onOpenPeriod(row.period)}
          >
            Open GSTR-1 for this period →
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Filed on">
            <DateInput value={filedAt} context={row.date} onChange={setFiledAt} testId="input-filing-date" />
          </Field>
          <Field
            label="Tax paid"
            hint={
              liability?.taxPayable == null
                ? 'Drives the interest, and the nil-return fee rate'
                : `Books say ${formatPaise(liability.taxPayable)} is payable, per ${liability.source}`
            }
          >
            <AmountInput
              paise={taxPaid}
              onPaise={(v) => {
                setTouchedTax(true)
                setTaxPaid(v)
              }}
              testId="input-filing-tax"
            />
          </Field>
        </div>

        <Field label="ARN" hint="The acknowledgement number the portal returns">
          <TextInput
            data-testid="input-filing-arn"
            value={arn}
            onChange={(e) => setArn(e.target.value.toUpperCase())}
            className="num"
            placeholder="AA270526000001X"
          />
        </Field>

        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {liability?.taxPayable != null && (taxPaid ?? 0) !== liability.taxPayable && (
          <div className="rounded-md border border-amber/50 bg-amber/10 px-3.5 py-2.5 text-body-sm" data-testid="filing-liability-gap">
            This differs from the books by <b><Money paise={Math.abs((taxPaid ?? 0) - liability.taxPayable)} /></b>
            {(taxPaid ?? 0) < liability.taxPayable ? ' short' : ' over'}. Worth a look before you
            record it — though a genuine difference (a set-off, a carried-forward credit) is normal.
          </div>
        )}

        <LiveCharge form={row.form} dueDate={row.date} filedAt={filedAt} taxPaid={taxPaid ?? 0} />

        <div className="flex justify-between">
          {row.record?.filedAt ? (
            <Button variant="danger" data-testid="btn-filing-clear" onClick={() => submit(true)}>
              Not filed after all
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-filing-save" onClick={() => submit(false)}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** What this filing date costs, recomputed as the form is edited. */
function LiveCharge({
  form,
  dueDate,
  filedAt,
  taxPaid
}: {
  form: string
  dueDate: string
  filedAt: string
  taxPaid: number
}): React.JSX.Element | null {
  // Pure integer maths in shared — no round trip to main, and the same function the register
  // itself uses, so the dialog can never quote a figure the row disagrees with.
  const data = lateCharge({ form, dueDate, filedDate: filedAt, taxPaise: taxPaid })
  if (data.daysLate === 0) return null
  return (
    <div className="rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm" data-testid="filing-live-charge">
      <b>
        {data.daysLate} day{data.daysLate === 1 ? '' : 's'} late.
      </b>{' '}
      Total <b><Money paise={data.totalPaise} /></b> — late fee <Money paise={data.lateFeePaise} />
      {data.feeCapped && <span className="text-hint text-muted"> (at the cap)</span>}
      {data.interestPaise > 0 ? (
        <>
          {' '}
          plus <Money paise={data.interestPaise} /> interest.
        </>
      ) : (
        // No tax paid, so no interest arises — say so rather than printing a dash beside a label.
        <span className="text-hint text-muted"> · no interest, since no tax was paid late</span>
      )}
    </div>
  )
}

/**
 * File a nil return.
 *
 * The whole form is a single ARN box, because that is genuinely all a nil return needs: no tax,
 * so no interest, and the late fee (if any) follows from the dates. Offered only when the books
 * hold nothing in the period, so it can never quietly record a nil return over real entries.
 */
function NilFilingModal({
  row,
  onClose,
  onSaved
}: {
  row: FilingRow
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const [arn, setArn] = useState('')
  const [filedAt, setFiledAt] = useState(todayISO())

  const save = useMutation({
    mutationFn: (input: Parameters<typeof api.filings.record>[0]) => api.filings.record(input),
    onSuccess: () => {
      toast.push('success', `${row.form} ${shortPeriod(row.period)} filed nil`)
      onSaved()
    },
    onError: (err: Error) => toast.push('error', err.message)
  })

  const charge = lateCharge({ form: row.form, dueDate: row.date, filedDate: filedAt, taxPaise: 0 })

  return (
    <Modal title={`Nil ${row.form} — ${shortPeriod(row.period)}`} onClose={onClose} dirty={arn.length > 0}>
      <div className="flex flex-col gap-4">
        <p className="text-body-sm text-muted">
          No entries in this period, so the return is nil. Nothing is payable, and no interest can
          arise — only the late fee, if it is past due.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Filed on">
            <DateInput value={filedAt} context={row.date} onChange={setFiledAt} testId="input-nil-date" />
          </Field>
          <Field label="ARN">
            <TextInput
              data-testid="input-nil-arn"
              value={arn}
              onChange={(e) => setArn(e.target.value.toUpperCase())}
              className="num"
              placeholder="AA270526000001X"
              autoFocus
            />
          </Field>
        </div>

        {charge.daysLate > 0 && (
          <div className="rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm" data-testid="nil-charge">
            <b>{charge.daysLate} days late.</b> Nil returns carry the lower fee:{' '}
            <b><Money paise={charge.lateFeePaise} /></b>
            {charge.feeCapped && <span className="text-hint text-muted"> (at the cap)</span>}.
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="btn-nil-save"
            disabled={!arn.trim()}
            disabledTitle="Enter the ARN the portal returned"
            onClick={() =>
              save.mutate({
                form: row.form,
                period: row.period,
                dueDate: row.date,
                filedAt,
                arn: arn.trim(),
                taxPaid: 0,
                notes: 'Nil return'
              })
            }
          >
            File nil
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * GSTR-9 working papers.
 *
 * GSTR-9 is not a return you compute so much as one you reconcile: the portal auto-populates it
 * from the GSTR-1s and GSTR-3Bs already filed, and what a business needs before signing is
 * whether the books for the year agree with what was filed, and where they do not.
 *
 * So this is a comparison, not a form. It emits no portal JSON — GSTR-9 has no offline utility
 * worth targeting, and a filled-in annual return generated from books alone would be a confident
 * answer to a question that needs a human.
 */
function Gstr9Papers({ fyStartYear }: { fyStartYear: number }): React.JSX.Element {
  const toast = useToasts()
  const { data, isLoading } = useQuery({
    queryKey: ['gstr9', fyStartYear],
    queryFn: () => api.annual.gstr9(fyStartYear)
  })

  if (isLoading || !data) return <SkeletonRows rows={10} />

  const columns: PdfColumn[] = [
    { label: 'Table', align: 'l' },
    { label: 'Particulars', align: 'l' },
    { label: 'Per books', align: 'r' },
    { label: 'Per returns', align: 'r' },
    { label: 'Difference', align: 'r' }
  ]
  const exportRows: PdfRow[] = data.sections.flatMap((section) => [
    { cells: [section.title, '', '', '', ''], bold: true },
    ...section.lines.map((l) => ({
      cells: [
        l.table,
        l.label,
        formatPaise(l.perBooks),
        l.perReturns == null ? '—' : formatPaise(l.perReturns),
        l.difference == null ? '—' : formatPaise(l.difference)
      ]
    }))
  ])

  return (
    <>
      <div
        className={`mb-3 rounded-md border px-3.5 py-2.5 text-body-sm ${
          data.reconciled ? 'border-dr/40 bg-dr/5 text-dr' : 'border-amber/50 bg-amber/10 text-amber'
        }`}
        data-testid="gstr9-status"
      >
        {data.reconciled ? (
          <>FY {data.financialYear}: the books agree with what was filed, and nothing is outstanding.</>
        ) : data.unfiledMonths.length > 0 ? (
          <>
            {data.unfiledMonths.length} period{data.unfiledMonths.length === 1 ? '' : 's'} with no GSTR-3B
            recorded as filed: {data.unfiledMonths.join(', ')}. Fix that before reconciling anything else.
          </>
        ) : (
          <>The books and the filings differ. The lines below show where.</>
        )}
        <span className="ml-2">
          <Button
            variant="ghost"
            onClick={() =>
              void printReport(
                {
                  title: `GSTR-9 working papers · FY ${data.financialYear}`,
                  periodLabel: 'Books against returns',
                  columns,
                  rows: exportRows,
                  filename: `gstr9-papers-${data.financialYear}`
                },
                toast
              )
            }
          >
            PDF
          </Button>
        </span>
      </div>

      {data.sections.map((section) => (
        <Panel key={section.key} className="mb-3">
          <div className="px-4 py-2.5">
            <p className="text-body font-medium">{section.title}</p>
            <p className="mt-0.5 text-hint text-muted">{section.note}</p>
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-20">Table</th>
                <th scope="col">Particulars</th>
                <th scope="col" className="r w-40">Per books</th>
                <th scope="col" className="r w-40">Per returns</th>
                <th scope="col" className="r w-36">Difference</th>
              </tr>
            </thead>
            <tbody data-testid={`rows-gstr9-${section.key}`}>
              {section.lines.map((l, i) => (
                <tr key={`${l.table}-${i}`}>
                  <td className="num text-muted">{l.table}</td>
                  <td>{l.label}</td>
                  <td className="r"><Money paise={l.perBooks} /></td>
                  <td className="r">
                    {/* A dash, not a zero: "nothing recorded" and "filed nil" are different
                        claims, and the second is far worse to make by accident. */}
                    {l.perReturns == null ? <span className="text-muted">—</span> : <Money paise={l.perReturns} />}
                  </td>
                  <td className="r">
                    {l.difference == null ? (
                      <span className="text-muted">—</span>
                    ) : l.difference === 0 ? (
                      <span className="text-dr">✓</span>
                    ) : (
                      <span className="text-cr font-semibold"><Money paise={l.difference} signed /></span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ))}

      <p className="mt-2 text-hint text-muted">
        Working papers, not a return. Table 8&rsquo;s ITC reconciliation against GSTR-2A/2B and the
        amendment tables need judgement the books cannot supply — the figures here are the ones
        that can be computed, so the portal form is transcribed rather than derived.
      </p>
    </>
  )
}
