// Loans and EMIs (WP 4.4): the loan register, each loan's instalment schedule (principal /
// interest split, posted or pending), Post EMI (payment voucher Dr loan / Dr interest / Cr bank),
// prepayments and the year's interest. The schedule maths is src/shared/loanSchedule.ts.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Group, Ledger } from '@shared/domain'
import type { LoanInput, LoanScheduleRow, LoanSummary } from '@shared/cashFinance'
import { parseRateMilli, rateMilliText, type LoanSchedule } from '@shared/loanSchedule'
import { toDisplayDate, todayISO, fyOf } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { api } from '../lib/client'
import { cfApi } from '../lib/cashFinanceClient'
import { useNav, useToasts } from '../state/stores'
import {
  AmountInput, Badge, Banner, Button, DateInput, DrawerSection, EmptyState, Field, Modal, Page, PageHeader, Panel, Select, StatTile, TextInput
} from '../components/ui'
import { OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink, VoucherLink } from '../components/links'
import { LedgerPicker, useGroups } from '../components/pickers'
import { confirmDialog } from '../lib/dialogs'
import { openVoucher } from '../lib/drill'

/** True when `groupId` is (under) one of the named groups. */
export function underGroup(groupId: number, names: readonly string[], groups: Map<number, Group>): boolean {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  let g = groups.get(groupId)
  for (let i = 0; g && i < 50; i++) {
    if (wanted.has(g.name.toLowerCase())) return true
    g = g.parentId != null ? groups.get(g.parentId) : undefined
  }
  return false
}
const CASH_BANK = ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c']
const isLiability = (l: Ledger, groups: Map<number, Group>): boolean => groups.get(l.groupId)?.nature === 'liability' && !underGroup(l.groupId, CASH_BANK, groups)
const isCashBank = (l: Ledger, groups: Map<number, Group>): boolean => underGroup(l.groupId, CASH_BANK, groups)
const isExpense = (l: Ledger, groups: Map<number, Group>): boolean => groups.get(l.groupId)?.nature === 'expense'

const LOAN_COLUMNS = defineColumns<LoanSummary>([
  { id: 'name', header: 'Loan', kind: 'text', value: (l) => l.name, hideable: false, minWidth: 150 },
  { id: 'lender', header: 'Loan ledger', kind: 'text', value: (l) => l.loanLedgerName, width: 160, cell: (l) => <LedgerLink ledgerId={l.loanLedgerId} name={l.loanLedgerName} /> },
  { id: 'principal', header: 'Principal', kind: 'money', value: (l) => l.principal, aggregate: 'sum', width: 124 },
  { id: 'rate', header: 'Rate', kind: 'number', value: (l) => l.annualRateMilli / 1000, text: (l) => `${rateMilliText(l.annualRateMilli)}%${l.method === 'flat' ? ' flat' : ''}`, width: 84 },
  { id: 'tenure', header: 'Tenure', kind: 'number', value: (l) => l.tenureMonths, text: (l) => `${l.tenureMonths} mo`, width: 80 },
  { id: 'emi', header: 'EMI', kind: 'money', value: (l) => l.emi, width: 112 },
  { id: 'outstanding', header: 'Outstanding', kind: 'money', value: (l) => l.outstanding, aggregate: 'sum', width: 124 },
  { id: 'next', header: 'Next due', kind: 'date', value: (l) => l.nextDue?.dueDate ?? null, width: 104, cell: (l) => (l.nextDue ? (
    <span className={l.nextDue.dueDate < todayISO() ? 'text-danger' : ''}>{toDisplayDate(l.nextDue.dueDate)}</span>
  ) : <span className="text-muted">—</span>) },
  { id: 'posted', header: 'Posted', kind: 'number', value: (l) => l.postedCount, text: (l) => `${l.postedCount} / ${l.postedCount + l.pendingCount}`, width: 84 },
  { id: 'interestFy', header: 'Interest this FY', kind: 'money', value: (l) => l.interestThisFy, aggregate: 'sum', width: 128 },
  { id: 'status', header: 'Status', kind: 'enum', value: (l) => (l.status === 'closed' ? 'closed' : l.overdueCount > 0 ? 'overdue' : 'active'), options: [
    { value: 'active', label: 'Active' }, { value: 'overdue', label: 'EMI due' }, { value: 'closed', label: 'Closed' }
  ], width: 92, cell: (l) => l.status === 'closed' ? <Badge tone="neutral">Closed</Badge> : l.overdueCount > 0 ? <Badge tone="amber">{l.overdueCount} due</Badge> : <Badge tone="success">Active</Badge> }
])

const KIND_LABEL: Record<LoanScheduleRow['kind'], string> = { emi: 'EMI', moratorium: 'Moratorium', prepayment: 'Prepayment' }

function scheduleColumns(today: string) {
  return defineColumns<LoanScheduleRow>([
    { id: 'seq', header: '#', kind: 'number', value: (r) => r.seq, width: 52 },
    { id: 'due', header: 'Due', kind: 'date', value: (r) => r.dueDate, width: 104 },
    { id: 'kind', header: 'Kind', kind: 'enum', value: (r) => r.kind, options: (Object.keys(KIND_LABEL) as LoanScheduleRow['kind'][]).map((k) => ({ value: k, label: KIND_LABEL[k] })), width: 104 },
    { id: 'opening', header: 'Opening', kind: 'money', value: (r) => r.opening, width: 124, className: 'text-muted' },
    { id: 'payment', header: 'Instalment', kind: 'money', value: (r) => r.payment, aggregate: 'sum', width: 120 },
    { id: 'interest', header: 'Interest', kind: 'money', value: (r) => r.interest, aggregate: 'sum', width: 112 },
    { id: 'principal', header: 'Principal', kind: 'money', value: (r) => r.principal, aggregate: 'sum', width: 120 },
    { id: 'closing', header: 'Closing', kind: 'money', value: (r) => r.closing, width: 124 },
    {
      id: 'status', header: 'Status', kind: 'enum', value: (r) => (r.posted ? 'posted' : r.dueDate <= today ? 'due' : 'pending'),
      options: [{ value: 'posted', label: 'Posted' }, { value: 'due', label: 'Due' }, { value: 'pending', label: 'Pending' }], width: 120,
      cell: (r) => r.posted ? <VoucherLink voucherId={r.voucherId} label={<Badge tone="success">Posted {r.voucherNumber}</Badge>} /> : r.dueDate <= today ? <Badge tone="amber">Due</Badge> : <span className="text-muted">Pending</span>
    }
  ])
}

export function LoansScreen({ loanId }: { loanId?: number }): React.JSX.Element {
  const { data: loans = [], isLoading } = useQuery({ queryKey: ['loans'], queryFn: cfApi.loans.list })
  const [selected, setSelected] = useState<number | null>(loanId ?? null)
  const [form, setForm] = useState<{ loan: LoanSummary | null } | null>(null)
  useEffect(() => {
    if (selected == null && loans.length > 0) setSelected(loans[0]!.id)
  }, [loans, selected])
  const current = loans.find((l) => l.id === selected) ?? null
  const fy = fyOf(todayISO())
  return (
    <Page width="full">
      <PageHeader
        title="Loans and EMIs"
        period={`FY ${fy.label}`}
        actions={<Button variant="primary" data-testid="btn-loans-new" onClick={() => setForm({ loan: null })}>New loan</Button>}
        options={{
          content: (
            <>
              <OptionsTable area="loans" label="Loans table" />
              <DrawerSection title="How EMIs are worked out">
                <p className="text-hint text-muted">
                  Reducing balance: EMI = P·r·(1+r)ⁿ / ((1+r)ⁿ − 1), r = annual rate ÷ 12. Each month’s interest is the opening balance × r,
                  rounded to the paisa; the rest of the EMI repays principal, and the last instalment clears whatever is left. Enter the
                  bank’s EMI when its figure differs. Flat-rate loans charge interest on the original principal for the whole tenure.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <Panel className="mb-section">
        <DataTable
          viewId="loans"
          testId="loans"
          ariaLabel="Loans"
          columns={LOAN_COLUMNS}
          rows={loans}
          rowKey={(l) => l.id}
          rowAttrs={(l) => ({ 'data-loan-id': l.id, 'aria-selected': l.id === selected ? 'true' : undefined })}
          rowClassName={(l) => (l.id === selected ? 'bg-panel2' : '')}
          loading={isLoading}
          onRowActivate={(l) => setSelected(l.id)}
          maxHeight="40vh"
          empty={{ title: 'No loans yet', hint: 'Add a term loan, vehicle loan or OD with an EMI schedule' }}
          exportOptions={{ title: 'Loans', periodLabel: `as on ${toDisplayDate(todayISO())}`, filename: 'loans' }}
        />
      </Panel>
      {current && <LoanDetailPanel key={current.id} loan={current} onEdit={() => setForm({ loan: current })} onDeleted={() => setSelected(null)} />}
      {form && <LoanFormModal loan={form.loan} onClose={() => setForm(null)} onSaved={(id) => { setSelected(id); setForm(null) }} />}
    </Page>
  )
}

function LoanDetailPanel({ loan, onEdit, onDeleted }: { loan: LoanSummary; onEdit: () => void; onDeleted: () => void }): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const today = todayISO()
  const { data, isLoading } = useQuery({ queryKey: ['loan', loan.id], queryFn: () => cfApi.loans.get(loan.id) })
  const [posting, setPosting] = useState<LoanScheduleRow | null>(null)
  const [prepaying, setPrepaying] = useState(false)
  const columns = useMemo(() => scheduleColumns(today), [today])
  const nextRow = data?.schedule.find((r) => !r.posted) ?? null
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['loans'] })
    await qc.invalidateQueries({ queryKey: ['loan', loan.id] })
    await qc.invalidateQueries({ queryKey: ['forecastBase'] })
    await qc.invalidateQueries({ queryKey: ['dashboard', 'financeReminders'] })
  }
  const mismatch = loan.ledgerBalance !== loan.outstanding
  const remove = async (): Promise<void> => {
    if (!(await confirmDialog({ title: 'Delete loan', message: `Delete “${loan.name}” and its schedule? Posted vouchers are not touched.`, confirmLabel: 'Delete', danger: true }))) return
    try {
      await cfApi.loans.remove(loan.id)
      await refresh()
      onDeleted()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const toggleStatus = async (): Promise<void> => {
    try {
      await cfApi.loans.setStatus(loan.id, loan.status === 'active' ? 'closed' : 'active')
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <section data-testid="loan-detail" aria-label={`Loan ${loan.name}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-subtitle font-medium text-ink">{loan.name}</h2>
        <div className="flex flex-wrap gap-2">
          {nextRow && loan.status === 'active' && (
            <Button size="sm" variant="primary" data-testid="btn-loan-post-next" onClick={() => setPosting(nextRow)}>
              Post {KIND_LABEL[nextRow.kind]} #{nextRow.seq} · {toDisplayDate(nextRow.dueDate)}
            </Button>
          )}
          {loan.method === 'reducing' && loan.status === 'active' && <Button size="sm" data-testid="btn-loan-prepay" onClick={() => setPrepaying(true)}>Prepayment…</Button>}
          <Button size="sm" data-testid="btn-loan-edit" onClick={onEdit}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={() => void toggleStatus()}>{loan.status === 'active' ? 'Mark closed' : 'Reopen'}</Button>
          <Button size="sm" variant="ghost" onClick={() => void remove()}>Delete</Button>
        </div>
      </div>
      <ul className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Loan figures">
        <li><StatTile label="EMI" testId="tile-loan-emi" value={formatPaise(loan.emi, { symbol: true })} footer={`${rateMilliText(loan.annualRateMilli)}% ${loan.method === 'flat' ? 'flat' : 'reducing'} · ${loan.tenureMonths} months`} /></li>
        <li><StatTile label="Outstanding (schedule)" testId="tile-loan-outstanding" value={formatPaise(loan.outstanding, { symbol: true })} footer={`${loan.postedCount} of ${loan.postedCount + loan.pendingCount} posted`} /></li>
        <li><StatTile label="Loan ledger balance" testId="tile-loan-ledger" tone={mismatch ? 'amber' : undefined} value={formatPaise(loan.ledgerBalance, { symbol: true })} footer={mismatch ? 'Differs from the schedule — check the disbursement entry' : 'Agrees with the schedule'} /></li>
        <li><StatTile label="Interest this FY" testId="tile-loan-interest-fy" value={formatPaise(loan.interestThisFy, { symbol: true })} footer="due in the year, posted or not" /></li>
        <li><StatTile label="Total interest" testId="tile-loan-interest-total" value={formatPaise(loan.totalInterest, { symbol: true })} footer={`over ${toDisplayDate(loan.firstDueDate)} → end`} /></li>
      </ul>
      {loan.method === 'flat' && (
        <Banner tone="info" className="mb-3">A flat rate charges interest on the original principal throughout — its effective (reducing) rate is close to double the quoted one.</Banner>
      )}
      <Panel>
        <DataTable
          viewId="loan-schedule"
          testId="loan-schedule"
          ariaLabel={`${loan.name} schedule`}
          columns={columns}
          rows={data?.schedule ?? []}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-seq': r.seq, 'data-posted': r.posted ? 'true' : 'false' })}
          loading={isLoading}
          maxHeight="none"
          isRowActivatable={(r) => r.posted}
          onRowActivate={(r) => r.voucherId != null && openVoucher(r.voucherId)}
          trailingWidth={82}
          trailing={(r) =>
            !r.posted && r.id === nextRow?.id && loan.status === 'active' ? (
              <button type="button" data-testid={`btn-loan-post-${r.seq}`} className="text-small text-blue hover:underline" onClick={() => setPosting(r)}>
                Post…
              </button>
            ) : null
          }
          empty={{ title: 'No schedule' }}
          exportOptions={{ title: `Loan schedule — ${loan.name}`, periodLabel: `${rateMilliText(loan.annualRateMilli)}% · ${loan.tenureMonths} months`, filename: 'loan-schedule' }}
        />
      </Panel>
      {data && data.prepayments.length > 0 && (
        <p className="mt-2 text-hint text-muted" data-testid="loan-prepayments">
          Prepayments: {data.prepayments.map((p) => `${toDisplayDate(p.date)} ${formatPaise(p.amount, { symbol: true })} (${p.effect === 'reduce_emi' ? 'lower EMI' : 'shorter tenure'})`).join(' · ')}
        </p>
      )}
      {posting && <PostEmiModal loan={loan} row={posting} onClose={() => setPosting(null)} onPosted={async () => { setPosting(null); await refresh() }} />}
      {prepaying && <PrepaymentModal loan={loan} onClose={() => setPrepaying(false)} onSaved={async () => { setPrepaying(false); await refresh() }} />}
    </section>
  )
}

function PostEmiModal({ loan, row, onClose, onPosted }: { loan: LoanSummary; row: LoanScheduleRow; onClose: () => void; onPosted: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const groups = useGroups()
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const [date, setDate] = useState(row.dueDate)
  const [bank, setBank] = useState<number | null>(loan.bankLedgerId)
  const capitalised = row.kind === 'moratorium' && row.payment === 0
  const post = async (): Promise<void> => {
    try {
      const r = await cfApi.loans.postEmi({ scheduleId: row.id, date, bankLedgerId: bank ?? undefined })
      toast.push('success', `Posted ${r.voucherNumber ?? ''}`)
      await onPosted()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={`Post ${KIND_LABEL[row.kind]} #${row.seq}`} onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="loan-post-modal">
        <table className="ledger-table">
          <tbody>
            {capitalised ? (
              <>
                <tr><td>Dr {loan.interestLedgerName ?? 'Interest on Loans'}</td><td className="r num">{formatPaise(row.interest)}</td></tr>
                <tr><td>Cr {loan.loanLedgerName}</td><td className="r num">{formatPaise(row.interest)}</td></tr>
              </>
            ) : (
              <>
                {row.principal > 0 && <tr><td>Dr {loan.loanLedgerName} (principal)</td><td className="r num">{formatPaise(row.principal)}</td></tr>}
                {row.interest > 0 && <tr><td>Dr {loan.interestLedgerName ?? 'Interest on Loans'} (interest)</td><td className="r num">{formatPaise(row.interest)}</td></tr>}
                <tr className="total-row"><td>Cr bank</td><td className="r num">{formatPaise(row.payment)}</td></tr>
              </>
            )}
          </tbody>
        </table>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <DateInput value={date} context={row.dueDate} onChange={setDate} testId="input-loan-post-date" />
          </Field>
          {!capitalised && (
            <Field label="Paid from">
              <LedgerPicker value={bank} onPick={setBank} filter={isCashBank} placeholder="Bank" testId="picker-loan-post-bank" />
            </Field>
          )}
        </div>
        <p className="text-hint text-muted">{capitalised ? 'A capitalised moratorium month books its interest as a journal; nothing is paid.' : 'Creates a payment voucher. Moving it to the bin re-opens the instalment.'}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-loan-post-confirm" onClick={() => void post()}>Post</Button>
        </div>
      </div>
    </Modal>
  )
}

function PrepaymentModal({ loan, onClose, onSaved }: { loan: LoanSummary; onClose: () => void; onSaved: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const [date, setDate] = useState(todayISO())
  const [amount, setAmount] = useState<number | null>(null)
  const [effect, setEffect] = useState<'reduce_tenure' | 'reduce_emi'>('reduce_tenure')
  const save = async (): Promise<void> => {
    if (!amount) return toast.push('error', 'Enter the amount prepaid')
    try {
      await cfApi.loans.prepaymentAdd({ loanId: loan.id, date, amount, effect })
      toast.push('success', 'Schedule recalculated')
      await onSaved()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={`Prepayment — ${loan.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date"><DateInput value={date} context={todayISO()} onChange={setDate} testId="input-loan-prepay-date" /></Field>
          <Field label="Amount"><AmountInput paise={amount} onPaise={setAmount} testId="input-loan-prepay-amount" /></Field>
        </div>
        <Field label="Then">
          <Select value={effect} onChange={(e) => setEffect(e.target.value as typeof effect)} data-testid="select-loan-prepay-effect">
            <option value="reduce_tenure">Keep the EMI, finish sooner</option>
            <option value="reduce_emi">Keep the tenure, lower the EMI</option>
          </Select>
        </Field>
        <p className="text-hint text-muted">The prepayment appears in the schedule; post it like an instalment when you pay it.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-loan-prepay-save" onClick={() => void save()}>Recalculate</Button>
        </div>
      </div>
    </Modal>
  )
}

function LoanFormModal({ loan, onClose, onSaved }: { loan: LoanSummary | null; onClose: () => void; onSaved: (id: number) => void }): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const nav = useNav()
  const groups = useGroups()
  const [name, setName] = useState(loan?.name ?? '')
  const [loanLedgerId, setLoanLedger] = useState<number | null>(loan?.loanLedgerId ?? null)
  const [bankLedgerId, setBank] = useState<number | null>(loan?.bankLedgerId ?? null)
  const [interestLedgerId, setInterest] = useState<number | null>(loan?.interestLedgerId ?? null)
  const [principal, setPrincipal] = useState<number | null>(loan?.principal ?? null)
  const [rateText, setRateText] = useState(loan ? rateMilliText(loan.annualRateMilli) : '')
  const [tenure, setTenure] = useState(loan ? String(loan.tenureMonths) : '')
  const [disbursedOn, setDisbursed] = useState(loan?.disbursedOn ?? todayISO())
  const [firstDueDate, setFirstDue] = useState(loan?.firstDueDate ?? '')
  const [method, setMethod] = useState<'reducing' | 'flat'>(loan?.method ?? 'reducing')
  const [moratorium, setMoratorium] = useState(loan ? String(loan.moratoriumMonths) : '0')
  const [moratoriumMode, setMoratoriumMode] = useState<'capitalise' | 'interest_only'>(loan?.moratoriumMode ?? 'capitalise')
  const [emiOverride, setEmiOverride] = useState<number | null>(loan?.emiOverride ?? null)
  const rate = parseRateMilli(rateText)
  const tenureN = Number(tenure)
  const input: LoanInput | null =
    name.trim() && loanLedgerId && principal && rate != null && Number.isInteger(tenureN) && tenureN > 0 && firstDueDate
      ? {
          name: name.trim(), loanLedgerId, bankLedgerId, interestLedgerId, principal, annualRateMilli: rate, tenureMonths: tenureN, disbursedOn,
          firstDueDate, method, moratoriumMonths: Number(moratorium) || 0, moratoriumMode, emiOverride: method === 'flat' ? null : emiOverride
        }
      : null
  const [preview, setPreview] = useState<LoanSchedule | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const sig = JSON.stringify(input)
  useEffect(() => {
    if (!input) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let live = true
    cfApi.loans.preview(input).then(
      (p) => live && (setPreview(p), setPreviewError(null)),
      (e: Error) => live && (setPreview(null), setPreviewError(e.message))
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  const createLoanLedger = async (ledgerName: string): Promise<void> => {
    const g = groups.find((x) => x.name === 'Secured Loans') ?? groups.find((x) => x.name === 'Loans (Liability)')
    if (!g) return
    try {
      const l = await api.ledgers.create({
        name: ledgerName, groupId: g.id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
        tdsSectionId: null, pan: null, creditDays: null, exportType: null
      })
      await qc.invalidateQueries({ queryKey: ['ledgers'] })
      setLoanLedger(l.id)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const save = async (): Promise<void> => {
    if (!input) return toast.push('error', 'Fill in the name, loan ledger, amount, rate, tenure and first EMI date')
    try {
      const d = await cfApi.loans.save(input, loan?.id)
      await qc.invalidateQueries({ queryKey: ['loans'] })
      await qc.invalidateQueries({ queryKey: ['loan', d.loan.id] })
      await qc.invalidateQueries({ queryKey: ['forecastBase'] })
      toast.push('success', loan ? 'Loan updated' : 'Loan added')
      onSaved(d.loan.id)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={loan ? 'Edit loan' : 'New loan'} onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]" data-testid="loan-form">
        <div className="flex flex-col gap-3">
          <Field label="Name"><TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="input-loan-name" placeholder="e.g. HDFC term loan" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Loan ledger" hint="The lender’s loan account (a liability)">
              <LedgerPicker value={loanLedgerId} onPick={setLoanLedger} filter={isLiability} placeholder="Loan account" testId="picker-loan-ledger" onCreateRequest={(n) => void createLoanLedger(n)} />
            </Field>
            <Field label="EMIs paid from">
              <LedgerPicker value={bankLedgerId} onPick={setBank} filter={isCashBank} placeholder="Bank" testId="picker-loan-bank" />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Amount"><AmountInput paise={principal} onPaise={setPrincipal} testId="input-loan-principal" /></Field>
            <Field label="Rate % a year"><TextInput value={rateText} onChange={(e) => setRateText(e.target.value)} data-testid="input-loan-rate" inputMode="decimal" placeholder="10.5" /></Field>
            <Field label="Tenure (EMIs)"><TextInput value={tenure} onChange={(e) => setTenure(e.target.value.replace(/\D/g, ''))} data-testid="input-loan-tenure" inputMode="numeric" placeholder="60" /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Disbursed on"><DateInput value={disbursedOn} context={todayISO()} onChange={setDisbursed} testId="input-loan-disbursed" /></Field>
            <Field label="First EMI on"><DateInput value={firstDueDate} allowEmpty context={disbursedOn} onChange={setFirstDue} testId="input-loan-first-due" /></Field>
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value as 'reducing' | 'flat')} data-testid="select-loan-method">
                <option value="reducing">Reducing balance</option>
                <option value="flat">Flat rate</option>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Moratorium (months)"><TextInput value={moratorium} onChange={(e) => setMoratorium(e.target.value.replace(/\D/g, ''))} data-testid="input-loan-moratorium" inputMode="numeric" /></Field>
            <Field label="During moratorium">
              <Select value={moratoriumMode} onChange={(e) => setMoratoriumMode(e.target.value as typeof moratoriumMode)} disabled={!Number(moratorium)}>
                <option value="capitalise">Interest added to the loan</option>
                <option value="interest_only">Pay interest only</option>
              </Select>
            </Field>
            {method === 'reducing' && (
              <Field label="Bank’s EMI (optional)"><AmountInput paise={emiOverride} onPaise={setEmiOverride} testId="input-loan-emi-override" placeholder="as per formula" /></Field>
            )}
          </div>
          <Field label="Interest ledger (optional)" hint="Blank = “Interest on Loans” under Indirect Expenses">
            <LedgerPicker value={interestLedgerId} onPick={setInterest} filter={isExpense} placeholder="Interest on Loans" testId="picker-loan-interest" />
          </Field>
        </div>
        <aside className="flex flex-col gap-2 rounded-md border border-line bg-panel2 p-3" aria-label="Schedule preview" data-testid="loan-preview">
          <span className="text-caption uppercase tracking-wide text-muted">Preview</span>
          {previewError ? (
            <p className="text-small text-danger">{previewError}</p>
          ) : !preview ? (
            <EmptyState title="Fill in the terms" hint="The EMI and schedule appear here" />
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-2 text-small">
                <dt className="text-muted">EMI</dt><dd className="num text-right text-ink" data-testid="loan-preview-emi">{formatPaise(preview.emi, { symbol: true })}</dd>
                <dt className="text-muted">Total interest</dt><dd className="num text-right text-ink">{formatPaise(preview.totalInterest, { symbol: true })}</dd>
                <dt className="text-muted">Total paid</dt><dd className="num text-right text-ink">{formatPaise(preview.totalPayment, { symbol: true })}</dd>
                <dt className="text-muted">Last EMI</dt><dd className="num text-right text-ink">{toDisplayDate(preview.rows.at(-1)!.dueDate)}</dd>
              </dl>
              <table className="ledger-table text-caption">
                <thead><tr><th>Due</th><th className="r">Interest</th><th className="r">Principal</th></tr></thead>
                <tbody>
                  {preview.rows.slice(0, 4).map((r) => (
                    <tr key={r.seq}><td className="num">{toDisplayDate(r.dueDate)}</td><td className="r num">{formatPaise(r.interest)}</td><td className="r num">{formatPaise(r.principal)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </aside>
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <button type="button" className="text-hint text-blue hover:underline" onClick={() => { onClose(); nav.go({ name: 'masters' }) }}>Ledgers in Masters →</button>
        <span className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-loan-save" onClick={() => void save()} disabled={!input || !!previewError}>Save loan</Button>
        </span>
      </div>
    </Modal>
  )
}
