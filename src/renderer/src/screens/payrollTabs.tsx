import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AttendanceRow, type LoanRow, type Settlement } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import {
  AmountInput,
  Button,
  EmptyState,
  Field,
  inputCls,
  Modal,
  Money,
  Panel,
  RowAction,
  SectionTitle,
  Select,
  SkeletonRows,
  TextInput
} from '../components/ui'
import { todayISO, toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { daysInMonth } from '@shared/payroll'

/**
 * The three things a pay run needs that used to live in somebody's head: who was actually here,
 * what they still owe the company, and what it costs when they leave.
 */

// ---------- attendance (#168) ----------

/**
 * The month's register.
 *
 * Everyone appears whether or not a row was ever entered, defaulting to a full month — most
 * months, for most people, nothing happened, and showing them as absent would turn a blank
 * register into a month of unpaid staff.
 */
export function AttendanceTab({ month, onMonth }: { month: string; onMonth: (m: string) => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const { data, isLoading } = useQuery({
    queryKey: ['attendance', month],
    queryFn: () => api.payroll.attendance(month)
  })
  const rows = data ?? []
  const monthDays = daysInMonth(month)

  const save = useMutation({
    mutationFn: api.payroll.saveAttendance,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attendance', month] })
      void queryClient.invalidateQueries({ queryKey: ['payrollPreview'] })
    },
    onError: (err: Error) => toast.push('error', err.message)
  })

  const totalPayable = rows.reduce((s, r) => s + r.payableDays, 0)
  const totalLop = rows.reduce((s, r) => s + r.lopDays, 0)

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-small text-muted">
        <span>Month</span>
        <TextInput
          type="month"
          data-testid="input-attendance-month"
          className="w-40"
          value={month}
          onChange={(e) => e.target.value && onMonth(e.target.value)}
        />
        <span>
          · {monthDays} calendar days · {totalLop > 0 ? `${totalLop} days lost to LOP` : 'no loss of pay'}
        </span>
      </div>

      <Panel scroll={{ maxH: '62vh' }} data-testid="panel-attendance">
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState title="No active employees" hint="Add someone on the Employees tab first." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col" className="r w-28">Present</th>
                <th scope="col" className="r w-28">Paid leave</th>
                <th scope="col" className="r w-28">Loss of pay</th>
                <th scope="col" className="r w-28">Payable</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody data-testid="rows-attendance">
              {rows.map((r) => (
                <AttendanceRowEditor
                  key={r.employeeId}
                  row={r}
                  busy={save.isPending}
                  onSave={(next) => save.mutate(next)}
                />
              ))}
              <tr className="total-row">
                <td>Total · {rows.length} people</td>
                <td colSpan={3} />
                <td className="r num">{totalPayable}</td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Payable days are present plus paid leave. Somebody with no row entered is a full month —
        the register records exceptions, not attendance. The pay run reads this unless a preview
        overrides it by hand.
      </p>
    </>
  )
}

function AttendanceRowEditor({
  row,
  busy,
  onSave
}: {
  row: AttendanceRow
  busy: boolean
  onSave: (input: {
    employeeId: number
    month: string
    presentDays: number
    paidLeaveDays: number
    lopDays: number
    note: string | null
  }) => void
}): React.JSX.Element {
  const [present, setPresent] = useState(String(row.presentDays))
  const [leave, setLeave] = useState(String(row.paidLeaveDays))
  const [lop, setLop] = useState(String(row.lopDays))
  const [note, setNote] = useState(row.note ?? '')

  // The saved row is the authority: after a save (or a month change) the fields follow it rather
  // than keeping whatever was typed, so a rejected edit cannot linger looking accepted.
  useEffect(() => {
    setPresent(String(row.presentDays))
    setLeave(String(row.paidLeaveDays))
    setLop(String(row.lopDays))
    setNote(row.note ?? '')
  }, [row.presentDays, row.paidLeaveDays, row.lopDays, row.note, row.month])

  const commit = (): void => {
    const p = Number(present) || 0
    const l = Number(leave) || 0
    const o = Number(lop) || 0
    if (p === row.presentDays && l === row.paidLeaveDays && o === row.lopDays && (note || null) === row.note) return
    onSave({ employeeId: row.employeeId, month: row.month, presentDays: p, paidLeaveDays: l, lopDays: o, note: note.trim() || null })
  }

  const payable = (Number(present) || 0) + (Number(leave) || 0)
  const over = payable + (Number(lop) || 0) > row.monthDays

  const cell = (value: string, set: (v: string) => void, testId: string): React.JSX.Element => (
    <td className="r">
      <input
        className={`${inputCls} w-20 text-right num`}
        data-testid={`${testId}-${row.employeeId}`}
        inputMode="decimal"
        value={value}
        disabled={busy}
        onChange={(e) => set(e.target.value.replace(/[^\d.]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </td>
  )

  return (
    <tr className={over ? 'bg-cr/5' : undefined}>
      <td>{row.employeeName}</td>
      {cell(present, setPresent, 'input-present')}
      {cell(leave, setLeave, 'input-leave')}
      {cell(lop, setLop, 'input-lop')}
      <td className={`r num ${over ? 'text-cr font-semibold' : ''}`}>{payable}</td>
      <td>
        <input
          className={`${inputCls} w-full`}
          value={note}
          disabled={busy}
          placeholder="—"
          onChange={(e) => setNote(e.target.value)}
          onBlur={commit}
        />
      </td>
    </tr>
  )
}

// ---------- salary advances (#169) ----------

export function AdvancesTab({ month }: { month: string }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const [adding, setAdding] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['payrollLoans'], queryFn: () => api.payroll.loans() })
  const { data: due } = useQuery({ queryKey: ['dueRecoveries', month], queryFn: () => api.payroll.dueRecoveries(month) })
  const rows = data ?? []
  const dueTotal = (due ?? []).reduce((s, r) => s + r.amount, 0)

  const close = async (loan: LoanRow): Promise<void> => {
    try {
      await api.payroll.closeLoan(loan.id)
      await queryClient.invalidateQueries({ queryKey: ['payrollLoans'] })
      await queryClient.invalidateQueries({ queryKey: ['dueRecoveries'] })
      toast.push('success', `${loan.employeeName}'s advance closed`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <SectionTitle
        right={
          <Button variant="primary" data-testid="btn-advance-add" onClick={() => setAdding(true)}>
            Give an advance
          </Button>
        }
      >
        Salary advances
      </SectionTitle>

      {dueTotal > 0 && (
        <div
          className="mb-3 rounded-md border border-accentbar/50 bg-accentbar/10 px-3.5 py-2.5 text-body-sm"
          data-testid="advances-due"
        >
          The next pay run will recover <b><Money paise={dueTotal} /></b> across {due?.length} advance
          {due?.length === 1 ? '' : 's'}.
        </div>
      )}

      <Panel scroll={{ maxH: '58vh' }} data-testid="panel-advances-payroll">
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : rows.length === 0 ? (
          <EmptyState title="No advances" hint="An advance is recovered from pay in instalments until it clears itself." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col" className="w-28">Given</th>
                <th scope="col" className="r w-32">Advance</th>
                <th scope="col" className="r w-32">Instalment</th>
                <th scope="col" className="r w-32">Recovered</th>
                <th scope="col" className="r w-32">Outstanding</th>
                <th scope="col" className="r w-20">Left</th>
                <th scope="col" className="w-24" />
              </tr>
            </thead>
            <tbody data-testid="rows-advances-payroll">
              {rows.map((l) => (
                <tr key={l.id} className={l.closedAt ? 'text-muted' : undefined}>
                  <td>{l.employeeName}</td>
                  <td className="num text-muted">{toDisplayDate(l.grantedOn)}</td>
                  <td className="r"><Money paise={l.principal} /></td>
                  <td className="r"><Money paise={l.instalment} /></td>
                  <td className="r"><Money paise={l.recovered} /></td>
                  <td className="r">
                    {l.outstanding === 0 ? <span className="text-muted">cleared</span> : <Money paise={l.outstanding} />}
                  </td>
                  <td className="r num text-muted">{l.closedAt ? '–' : l.instalmentsLeft || '–'}</td>
                  <td className="r">
                    {!l.closedAt && l.outstanding > 0 && (
                      <RowAction onClick={() => void close(l)} title="Stop recovering, keeping what was already taken">
                        Write off
                      </RowAction>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        The instalment is never prorated for a part month and never overshoots the balance — the
        last one is whatever is left. Recovering an advance credits Salary Advances rather than
        paying anybody, so the asset runs down as the payslips take it.
      </p>

      {adding && <AdvanceModal onClose={() => setAdding(false)} />}
    </>
  )
}

function AdvanceModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToasts()
  const { data: employees } = useQuery({ queryKey: ['employees'], queryFn: api.payroll.employees })
  const active = (employees ?? []).filter((e) => e.active)
  const [employeeId, setEmployeeId] = useState<number | ''>(active[0]?.id ?? '')
  const [grantedOn, setGrantedOn] = useState(todayISO())
  const [principal, setPrincipal] = useState<number | null>(null)
  const [instalment, setInstalment] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const months = principal && instalment ? Math.ceil(principal / instalment) : 0

  const submit = async (): Promise<void> => {
    if (employeeId === '') return void toast.push('error', 'Pick an employee')
    if (!principal) return void toast.push('error', 'How much is the advance?')
    if (!instalment) return void toast.push('error', 'How much comes back each month?')
    setBusy(true)
    try {
      await api.payroll.createLoan({ employeeId, grantedOn, principal, instalment, note: note.trim() || null })
      await queryClient.invalidateQueries({ queryKey: ['payrollLoans'] })
      await queryClient.invalidateQueries({ queryKey: ['dueRecoveries'] })
      toast.push('success', 'Advance recorded')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Give an advance" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Employee">
          <Select
            data-testid="select-advance-employee"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value ? Number(e.target.value) : '')}
          >
            {active.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Given on">
          <TextInput type="date" value={grantedOn} onChange={(e) => setGrantedOn(e.target.value)} />
        </Field>
        <Field label="Amount">
          <AmountInput testId="input-advance-principal" paise={principal} onPaise={setPrincipal} autoFocus />
        </Field>
        <Field
          label="Recovered each month"
          hint={months > 0 ? `${months} pay run${months === 1 ? '' : 's'} to clear it` : undefined}
        >
          <AmountInput testId="input-advance-instalment" paise={instalment} onPaise={setInstalment} />
        </Field>
        <Field label="Note">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Medical, festival, …" />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-advance-save" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Record advance'}
        </Button>
      </div>
      <p className="mt-3 text-hint text-muted">
        This records the advance for recovery. Paying the money out is a separate payment voucher —
        Total does not move money on its own.
      </p>
    </Modal>
  )
}

// ---------- full and final settlement (#178) ----------

export function SettlementModal({
  employeeId,
  employeeName,
  onClose
}: {
  employeeId: number
  employeeName: string
  onClose: () => void
}): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const [lastDay, setLastDay] = useState(todayISO())
  const [leaveDays, setLeaveDays] = useState('0')
  const [noticeDays, setNoticeDays] = useState('0')
  const [payBonus, setPayBonus] = useState(false)
  const [waive, setWaive] = useState(false)

  const input = useMemo(
    () => ({
      employeeId,
      lastDay,
      leaveBalanceDays: Number(leaveDays) || 0,
      noticeShortfallDays: Number(noticeDays) || 0,
      payBonus,
      waiveGratuityMinimum: waive
    }),
    [employeeId, lastDay, leaveDays, noticeDays, payBonus, waive]
  )

  const { data, isLoading, error } = useQuery({
    queryKey: ['settlement', input],
    queryFn: () => api.payroll.settlement(input),
    retry: false
  })

  const draftIt = (): void => {
    if (!data?.draft) return
    nav.go({
      name: 'voucher-entry',
      kindHint: 'journal',
      draft: {
        date: data.draft.date,
        narration: data.draft.narration,
        lines: data.draft.lines.map((l) => ({ ledgerName: l.ledgerName, drCr: l.drCr, amount: l.amount }))
      },
      draftId: Date.now()
    } as never)
    onClose()
  }

  return (
    <Modal title={`Full and final — ${employeeName}`} onClose={onClose} wide>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Last working day">
          <TextInput type="date" data-testid="input-fnf-lastday" value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
        </Field>
        <Field label="Leave to encash" hint="days">
          <TextInput
            data-testid="input-fnf-leave"
            className="num text-right"
            inputMode="numeric"
            value={leaveDays}
            onChange={(e) => setLeaveDays(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <Field label="Notice not served" hint="days">
          <TextInput
            className="num text-right"
            inputMode="numeric"
            value={noticeDays}
            onChange={(e) => setNoticeDays(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <div className="flex flex-col justify-end gap-1.5 pb-1 text-small">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={payBonus} onChange={(e) => setPayBonus(e.target.checked)} />
            Pay statutory bonus
          </label>
          <label className="flex items-center gap-1.5" title="Death or permanent disablement waives the five-year rule">
            <input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} />
            Waive 5-year gratuity rule
          </label>
        </div>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : error ? (
          <div className="rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr">
            {(error as Error).message}
          </div>
        ) : data ? (
          <SettlementBody settlement={data} />
        ) : null}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" data-testid="btn-fnf-draft" disabled={!data?.draft} onClick={draftIt}>
          Draft the journal
        </Button>
      </div>
    </Modal>
  )
}

function SettlementBody({ settlement }: { settlement: Settlement }): React.JSX.Element {
  const r = settlement.result
  return (
    <div data-testid="settlement-body">
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Working</th>
            <th scope="col" className="r w-36">Amount</th>
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.label} className={l.kind === 'recovery' ? 'text-cr' : undefined}>
              <td>{l.label}</td>
              <td className="text-small text-muted">{l.working}</td>
              <td className="r">
                {l.kind === 'recovery' ? '(' : ''}
                <Money paise={l.amount} />
                {l.kind === 'recovery' ? ')' : ''}
              </td>
            </tr>
          ))}
          <tr className="total-row">
            <td colSpan={2}>{r.net >= 0 ? 'Payable to employee' : 'Recoverable from employee'}</td>
            <td className="r"><Money paise={Math.abs(r.net)} /></td>
          </tr>
        </tbody>
      </table>

      <div className="mt-3 flex gap-6 text-small text-muted">
        <span>
          Service: {r.gratuity.serviceYears}y {r.gratuity.serviceMonths}m {r.gratuity.serviceDays}d
          {r.gratuity.eligible ? ` · counted as ${r.gratuity.countedYears} years` : ''}
        </span>
        <span>
          Payable {formatPaise(r.totalPayable, { symbol: true })} · recovered{' '}
          {formatPaise(r.totalRecovery, { symbol: true })}
        </span>
      </div>

      {r.notes.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-small text-muted" data-testid="settlement-notes">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------- Form 16 (#171) ----------

/**
 * Part B of Form 16, on screen before it is printed.
 *
 * Part A carries the TAN and the challan details and comes from TRACES — no employer's books can
 * produce it, and the certificate says so rather than looking complete and not being.
 */
export function Form16Modal({
  employeeId,
  employeeName,
  onClose
}: {
  employeeId: number
  employeeName: string
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const [fy, setFy] = useState(() => {
    const now = todayISO()
    const [y, m] = now.split('-').map(Number)
    return (m as number) >= 4 ? (y as number) : (y as number) - 1
  })
  const [busy, setBusy] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ['form16', employeeId, fy],
    queryFn: () => api.payroll.form16(employeeId, fy),
    retry: false
  })

  const print = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.payroll.form16Pdf(employeeId, fy)
      toast.push('success', `Saved to exports — ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Form 16 Part B — ${employeeName}`} onClose={onClose} wide>
      <div className="mb-3 flex items-center gap-2 text-small text-muted">
        <span>Financial year</span>
        <Select className="w-40" data-testid="select-form16-fy" value={fy} onChange={(e) => setFy(Number(e.target.value))}>
          {[0, 1, 2, 3].map((back) => {
            const year = fy + 1 - back - 1
            return (
              <option key={year} value={year}>
                {year}-{String(year + 1).slice(2)}
              </option>
            )
          })}
        </Select>
        {data && <span>· {data.monthsPaid} months paid · {data.regime === 'new' ? 'new regime' : 'old regime'}</span>}
      </div>

      {isLoading ? (
        <SkeletonRows rows={8} />
      ) : error ? (
        <div className="rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr">
          {(error as Error).message}
        </div>
      ) : data ? (
        <div data-testid="form16-body">
          <table className="ledger-table">
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.label} className={r.indent ? 'text-muted text-small' : undefined}>
                  <td className={r.indent ? 'pl-8' : 'font-medium'}>{r.label}</td>
                  <td className="r"><Money paise={r.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.computation.rates.assumedFromEarlierYear && (
            <div className="mt-3 rounded-md border border-accentbar/50 bg-accentbar/10 px-3.5 py-2.5 text-small">
              No slab table is on file for {data.fyLabel} — this uses FY{' '}
              {data.computation.rates.fyStartYear}-{String(data.computation.rates.fyStartYear + 1).slice(2)}.
              Check it against the Finance Act before issuing the certificate.
            </div>
          )}

          <p className="mt-3 text-hint text-muted">
            {data.computation.rates.note} Part A — TAN, challans and the TRACES verification — is
            downloaded from the portal and cannot be produced from the books.
          </p>
        </div>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" data-testid="btn-form16-pdf" disabled={busy || !data} onClick={() => void print()}>
          {busy ? 'Printing…' : 'PDF'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- payslip delivery and bulk export (#174, #176) ----------

/**
 * Every payslip for a run, written out and ready to go.
 *
 * The PDF cannot ride inside a wa.me link, so the message carries the net figure and the person
 * attaches the file. That is honest about what an offline app can do, and still turns an
 * afternoon of printing and handing out into one click and a row of sends.
 */
export function PayslipsModal({
  runId,
  monthLabel,
  count,
  onClose
}: {
  runId: number
  monthLabel: string
  /** How many payslips are coming, so the wait can be described rather than merely endured. */
  count: number
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const { data, isLoading, error } = useQuery({
    queryKey: ['payslips', runId],
    queryFn: () => api.payroll.payslips(runId),
    retry: false
  })
  const rows = data ?? []

  return (
    <Modal title={`Payslips — ${monthLabel}`} onClose={onClose} wide>
      {isLoading ? (
        <>
          <SkeletonRows rows={Math.min(8, Math.max(3, count))} />
          {/* Roughly a second per payslip, measured. Saying so beats a spinner that looks stuck:
              forty people is most of a minute, and a user who was not told assumes a hang. */}
          <p className="mt-2 text-hint text-muted">
            Writing {count} payslip{count === 1 ? '' : 's'}, one PDF each — about{' '}
            {count < 5 ? 'a few seconds' : `${count} seconds`}.
          </p>
        </>
      ) : error ? (
        <div className="rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm text-cr">
          {(error as Error).message}
        </div>
      ) : (
        <table className="ledger-table" data-testid="payslips-body">
          <thead>
            <tr>
              <th scope="col">Employee</th>
              <th scope="col" className="r w-36">Net pay</th>
              <th scope="col" className="w-48" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.employeeId}>
                <td>{r.employeeName}</td>
                <td className="r"><Money paise={r.net} /></td>
                <td className="r whitespace-nowrap">
                  {r.whatsapp ? (
                    <RowAction onClick={() => window.open(r.whatsapp as string, '_blank')}>
                      WhatsApp
                    </RowAction>
                  ) : null}
                  {r.mailto ? (
                    <RowAction onClick={() => window.open(r.mailto as string, '_blank')}>
                      Email
                    </RowAction>
                  ) : null}
                  {!r.whatsapp && !r.mailto && (
                    <span className="text-hint text-muted">no phone or email on record</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="primary"
          disabled={rows.length === 0}
          onClick={() => {
            void navigator.clipboard.writeText(rows.map((r) => r.path).join('\n'))
            toast.push('success', `${rows.length} payslip paths copied`)
          }}
        >
          Copy the file paths
        </Button>
      </div>
      <p className="mt-3 text-hint text-muted">
        Every payslip is already written to the company&rsquo;s exports folder. The message carries
        the net figure; attach the PDF before sending — Total never sends anything itself.
      </p>
    </Modal>
  )
}
