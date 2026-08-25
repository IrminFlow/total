import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Loan, type StockStatement } from '../lib/client'
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
  Select,
  SkeletonRows,
  TextInput
} from '../components/ui'
import { useStickyTab } from '../lib/useStickyTab'
import { toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { DEFAULT_MARGINS } from '@shared/drawingPower'
import { drawingPowerRows } from '@shared/drawingPower'
import { confirmDialog } from '../lib/dialogs'
import { CmaTab } from './borrowing/CmaTab'

/**
 * Money the business borrowed, parked or paid ahead (roadmap #369–#375, #380).
 *
 * Six registers that have nothing in common except that none of them existed and all of them
 * produce a journal somebody has to decide to post. Nothing here posts by itself.
 */
type Tab = 'loans' | 'bank' | 'cma' | 'deposits' | 'projects' | 'prepaid' | 'commission'

const TABS: [Tab, string][] = [
  ['loans', 'Loans'],
  ['bank', 'Stock statement'],
  // The CMA pack sits beside the stock statement rather than on a screen of its own: it is the
  // same borrower, the same bank and the same working capital, and it reuses their classification.
  ['cma', 'CMA data'],
  ['deposits', 'Deposits'],
  ['projects', 'Work in progress'],
  ['prepaid', 'Prepaid & accrued'],
  ['commission', 'Commission']
]

export function BorrowingScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab<Tab>('borrowing-tab', TABS.map(([t]) => t), 'loans')
  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <div className="flex gap-1" role="group" aria-label="Borrowing view">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                data-testid={`tab-borrowing-${id}`}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
                className={`rounded-md px-2.5 py-1 text-small ${
                  tab === id ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        Borrowing & the bank
      </SectionTitle>
      {tab === 'loans' && <LoansTab />}
      {tab === 'bank' && <BankTab />}
      {tab === 'cma' && <CmaTab />}
      {tab === 'deposits' && <DepositsTab />}
      {tab === 'projects' && <ProjectsTab />}
      {tab === 'prepaid' && <PrepaidTab />}
      {tab === 'commission' && <CommissionTab />}
    </div>
  )
}

// ---------- loans (#370) ----------

function LoansTab(): React.JSX.Element {
  const [editing, setEditing] = useState<Loan | 'new' | null>(null)
  const [viewing, setViewing] = useState<Loan | null>(null)
  const { data, isLoading } = useQuery({ queryKey: ['loans'], queryFn: api.borrowing.loans })
  const rows = data ?? []

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid="btn-loan-add" onClick={() => setEditing('new')}>
          Add loan
        </Button>
      </div>
      <Panel scroll={{ maxH: '66vh' }} data-testid="panel-loans">
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No loans recorded"
            hint="Every business with a vehicle or a machine has one, and almost every one of them books the whole EMI to the loan account."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Loan</th>
                <th scope="col" className="w-40">Lender</th>
                <th scope="col" className="r w-24">Rate</th>
                <th scope="col" className="r w-20">Months</th>
                <th scope="col" className="r w-32">Borrowed</th>
                <th scope="col" className="r w-32">EMI</th>
                <th scope="col" className="w-32" />
              </tr>
            </thead>
            <tbody data-testid="rows-loans">
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="text-muted">{l.lender ?? '—'}</td>
                  <td className="r num">{(l.annualRateBp / 100).toFixed(2)}%</td>
                  <td className="r num">{l.months}</td>
                  <td className="r"><Money paise={l.principalPaise} /></td>
                  <td className="r">{l.emiPaise ? <Money paise={l.emiPaise} /> : <span className="text-muted">computed</span>}</td>
                  <td className="r whitespace-nowrap">
                    <Button variant="ghost" data-testid={`btn-loan-schedule-${l.id}`} onClick={() => setViewing(l)}>
                      Schedule
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(l)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        An EMI is not an expense. Part of it repays what was borrowed and part of it is interest,
        and the proportion changes every month — which is why the loan account is debited with the
        principal only.
      </p>
      {editing && <LoanModal loan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {viewing && <ScheduleModal loan={viewing} onClose={() => setViewing(null)} />}
    </>
  )
}

function LoanModal({ loan, onClose }: { loan: Loan | null; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  const [name, setName] = useState(loan?.name ?? '')
  const [lender, setLender] = useState(loan?.lender ?? '')
  const [kind, setKind] = useState(loan?.kind ?? 'vehicle')
  const [principal, setPrincipal] = useState<number | null>(loan?.principalPaise ?? null)
  const [ratePercent, setRatePercent] = useState(loan ? String(loan.annualRateBp / 100) : '')
  const [months, setMonths] = useState(loan ? String(loan.months) : '')
  const [emi, setEmi] = useState<number | null>(loan?.emiPaise ?? null)
  const [disbursedOn, setDisbursedOn] = useState(loan?.disbursedOn ?? todayISO())
  const [firstInstalmentDate, setFirst] = useState(loan?.firstInstalmentDate ?? todayISO())
  const [ledgerId, setLedgerId] = useState<number | ''>(loan?.ledgerId ?? '')
  const [interestLedgerId, setInterestLedgerId] = useState<number | ''>(loan?.interestLedgerId ?? '')

  const submit = async (): Promise<void> => {
    try {
      await api.borrowing.saveLoan(
        {
          name: name.trim(),
          lender: lender.trim() || null,
          accountNumber: null,
          kind,
          ledgerId: ledgerId === '' ? null : ledgerId,
          interestLedgerId: interestLedgerId === '' ? null : interestLedgerId,
          principalPaise: principal ?? 0,
          annualRateBp: Math.round(Number(ratePercent) * 100),
          months: Number(months),
          emiPaise: emi,
          disbursedOn,
          firstInstalmentDate,
          notes: null
        },
        loan?.id
      )
      await queryClient.invalidateQueries({ queryKey: ['loans'] })
      toast.push('success', `${name.trim()} saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={loan ? `Edit ${loan.name}` : 'Add loan'} onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3">
        <Field label="What it bought">
          <TextInput data-testid="input-loan-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Lender">
          <TextInput data-testid="input-loan-lender" value={lender} onChange={(e) => setLender(e.target.value)} />
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as Loan['kind'])}>
            <option value="vehicle">Vehicle</option>
            <option value="machinery">Machinery</option>
            <option value="term">Term loan</option>
            <option value="working_capital">Working capital</option>
            <option value="other">Other</option>
          </Select>
        </Field>

        <Field label="Borrowed">
          <AmountInput testId="input-loan-principal" paise={principal} onPaise={setPrincipal} />
        </Field>
        <Field label="Rate % a year">
          <TextInput
            data-testid="input-loan-rate"
            className="num text-right"
            inputMode="decimal"
            value={ratePercent}
            onChange={(e) => setRatePercent(e.target.value)}
          />
        </Field>
        <Field label="Instalments">
          <TextInput
            data-testid="input-loan-months"
            className="num text-right"
            inputMode="numeric"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
          />
        </Field>

        <Field label="EMI" hint="From the sanction letter. Leave empty and it is computed">
          <AmountInput testId="input-loan-emi" paise={emi} onPaise={setEmi} />
        </Field>
        <Field label="Disbursed on">
          <TextInput type="date" value={disbursedOn} onChange={(e) => setDisbursedOn(e.target.value)} />
        </Field>
        <Field label="First instalment">
          <TextInput type="date" data-testid="input-loan-first" value={firstInstalmentDate} onChange={(e) => setFirst(e.target.value)} />
        </Field>

        <Field label="Loan ledger" hint="So the register reconciles to the books">
          <Select value={ledgerId} onChange={(e) => setLedgerId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Not linked</option>
            {(ledgers ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Interest ledger">
          <Select value={interestLedgerId} onChange={(e) => setInterestLedgerId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Interest on Loans</option>
            {(ledgers ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-loan-save" onClick={() => void submit()}>
          Save
        </Button>
      </div>
    </Modal>
  )
}

function ScheduleModal({ loan, onClose }: { loan: Loan; onClose: () => void }): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { from, to } = useSession()
  const { data } = useQuery({
    queryKey: ['loanView', loan.id, from, to],
    queryFn: () => api.borrowing.loanView(loan.id, to, from, to)
  })
  const posted = new Set((data?.postings ?? []).map((p) => p.instalmentNo))

  const post = async (n: number): Promise<void> => {
    try {
      const draft = await api.borrowing.instalmentDraft(loan.id, n)
      await api.borrowing.postInstalment(loan.id, n, null)
      await queryClient.invalidateQueries({ queryKey: ['loanView'] })
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
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={`${loan.name} — amortisation`} onClose={onClose} wide>
      {data && (
        <div className="mb-3 flex gap-6 text-body-sm" data-testid="loan-summary">
          <div>
            <div className="text-caption text-muted uppercase">EMI</div>
            <div className="num font-medium">{formatPaise(data.schedule.emiPaise)}</div>
            <div className="text-hint text-muted">{data.schedule.emiStated ? 'as stated' : 'computed'}</div>
          </div>
          <div>
            <div className="text-caption text-muted uppercase">Last instalment</div>
            <div className="num font-medium">{formatPaise(data.schedule.finalInstalmentPaise)}</div>
            <div className="text-hint text-muted">the EMI rarely divides evenly</div>
          </div>
          <div>
            <div className="text-caption text-muted uppercase">Interest over the loan</div>
            <div className="num font-medium">{formatPaise(data.schedule.totalInterestPaise)}</div>
          </div>
          <div>
            <div className="text-caption text-muted uppercase">Still owed</div>
            <div className="num font-medium">{formatPaise(data.outstandingPaise)}</div>
          </div>
          <div>
            <div className="text-caption text-muted uppercase">Behind</div>
            <div className="num font-medium">{data.unposted.length}</div>
            <div className="text-hint text-muted">instalments due, not booked</div>
          </div>
        </div>
      )}
      <Panel scroll={{ maxH: '46vh' }}>
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col" className="w-12">#</th>
              <th scope="col" className="w-28">Due</th>
              <th scope="col" className="r w-32">Opening</th>
              <th scope="col" className="r w-32">EMI</th>
              <th scope="col" className="r w-32">Interest</th>
              <th scope="col" className="r w-32">Principal</th>
              <th scope="col" className="r w-32">Closing</th>
              <th scope="col" className="w-28" />
            </tr>
          </thead>
          <tbody data-testid="rows-loan-schedule">
            {(data?.schedule.rows ?? []).map((r) => (
              <tr key={r.n} className={posted.has(r.n) ? 'opacity-50' : ''}>
                <td className="num">{r.n}</td>
                <td className="num text-muted">{toDisplayDate(r.dueDate)}</td>
                <td className="r"><Money paise={r.openingPaise} /></td>
                <td className="r"><Money paise={r.emiPaise} /></td>
                <td className="r text-cr"><Money paise={r.interestPaise} /></td>
                <td className="r"><Money paise={r.principalPaise} /></td>
                <td className="r"><Money paise={r.closingPaise} /></td>
                <td className="r">
                  {posted.has(r.n) ? (
                    <span className="text-hint text-muted">posted</span>
                  ) : (
                    <Button variant="ghost" data-testid={`btn-loan-post-${r.n}`} onClick={() => void post(r.n)}>
                      Journal
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Modal>
  )
}

// ---------- the stock statement and drawing power (#372, #373) ----------

function BankTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { to } = useSession()
  const [asOn, setAsOn] = useState(to)
  const [margins, setMargins] = useState({ ...DEFAULT_MARGINS })
  const { data, isLoading } = useQuery({
    queryKey: ['stockStatement', asOn, margins],
    queryFn: () => api.borrowing.stockStatement(asOn, margins)
  })
  const { data: filed } = useQuery({ queryKey: ['filedStatements'], queryFn: api.borrowing.statements })

  const file = async (): Promise<void> => {
    try {
      await api.borrowing.fileStatement(asOn, margins, null)
      await queryClient.invalidateQueries({ queryKey: ['filedStatements'] })
      await queryClient.invalidateQueries({ queryKey: ['stockStatement'] })
      toast.push('success', `Statement as at ${asOn} filed`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 grid grid-cols-5 gap-3">
        <Field label="As at">
          <TextInput type="date" data-testid="input-statement-ason" value={asOn} onChange={(e) => setAsOn(e.target.value)} />
        </Field>
        <Field label="Stock margin %">
          <TextInput
            data-testid="input-statement-stock-margin"
            className="num text-right"
            value={String(margins.stockMarginPercent)}
            onChange={(e) => setMargins((m) => ({ ...m, stockMarginPercent: Number(e.target.value) || 0 }))}
          />
        </Field>
        <Field label="Debtor margin %">
          <TextInput
            data-testid="input-statement-debtor-margin"
            className="num text-right"
            value={String(margins.debtorMarginPercent)}
            onChange={(e) => setMargins((m) => ({ ...m, debtorMarginPercent: Number(e.target.value) || 0 }))}
          />
        </Field>
        <Field label="Debts older than" hint="Days. Beyond this they are not security at all">
          <TextInput
            data-testid="input-statement-age"
            className="num text-right"
            value={String(margins.debtorAgeLimitDays)}
            onChange={(e) => setMargins((m) => ({ ...m, debtorAgeLimitDays: Number(e.target.value) || 90 }))}
          />
        </Field>
        <Field label="Sanctioned limit">
          <AmountInput
            testId="input-statement-limit"
            paise={margins.sanctionedLimitPaise}
            onPaise={(p) => setMargins((m) => ({ ...m, sanctionedLimitPaise: p ?? 0 }))}
          />
        </Field>
      </div>

      <div className="flex gap-3">
        <Panel className="flex-1 p-4" data-testid="panel-drawing-power">
          {isLoading || !data ? (
            <SkeletonRows rows={8} />
          ) : (
            <>
              <table className="ledger-table">
                <tbody data-testid="rows-drawing-power">
                  {drawingPowerRows(data as StockStatement, margins).map((r) => (
                    <tr key={r.label}>
                      <td className={r.emphasis ? 'font-medium' : 'text-muted'}>{r.label}</td>
                      <td className={`r ${r.emphasis ? 'font-medium' : ''}`}>
                        <Money paise={r.value} signed />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex items-center gap-3">
                <Button variant="primary" data-testid="btn-statement-file" onClick={() => void file()}>
                  File this statement
                </Button>
                {data.excess && (
                  <span className="text-body-sm text-cr" data-testid="statement-excess">
                    The account is drawn beyond its security. That is what the bank charges penal interest on.
                  </span>
                )}
              </div>
            </>
          )}
        </Panel>

        <Panel className="w-96 shrink-0 p-4" data-testid="panel-statement-history">
          <div className="text-caption tracking-[0.08em] text-muted uppercase">Filed</div>
          {(filed ?? []).length === 0 ? (
            <p className="mt-2 text-body-sm text-muted">Nothing filed yet.</p>
          ) : (
            <table className="ledger-table mt-2">
              <tbody data-testid="rows-filed-statements">
                {(filed ?? []).map((f) => (
                  <tr key={f.id}>
                    <td className="num">{toDisplayDate(f.asOn)}</td>
                    <td className="r"><Money paise={f.drawingPowerPaise} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data && data.excludedParties.length > 0 && (
            <>
              <div className="mt-4 text-caption tracking-[0.08em] text-muted uppercase">Left out — too old</div>
              <table className="ledger-table mt-2">
                <tbody>
                  {data.excludedParties.map((p) => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td className="r"><Money paise={p.pending} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>
      </div>

      <p className="mt-2 text-hint text-muted">
        Creditors come off before the margin, not after — stock bought on credit is not the
        borrower&rsquo;s security. Debts past the cut-off are excluded outright rather than
        discounted, which is the most common overstatement in a filed statement.
      </p>
    </>
  )
}

// ---------- deposits (#375) ----------

function DepositsTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { to } = useSession()
  const [adding, setAdding] = useState(false)
  const { data } = useQuery({ queryKey: ['deposits'], queryFn: () => api.borrowing.deposits(false) })
  const { data: summary } = useQuery({ queryKey: ['depositSummary', to], queryFn: () => api.borrowing.depositSummary(to) })
  const rows = data ?? []

  const back = async (id: number, amountPaise: number): Promise<void> => {
    const ok = await confirmDialog({ title: 'Deposit returned', message: 'Record it as come back?', confirmLabel: 'Yes' })
    if (!ok) return
    try {
      await api.borrowing.returnDeposit(id, todayISO(), amountPaise)
      await queryClient.invalidateQueries({ queryKey: ['deposits'] })
      await queryClient.invalidateQueries({ queryKey: ['depositSummary'] })
      toast.push('success', 'Recorded')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-6 text-body-sm">
          <span>
            Paid out <Money paise={summary?.paidPaise ?? 0} />
          </span>
          <span>
            Held <Money paise={summary?.receivedPaise ?? 0} />
          </span>
          {(summary?.overdue.length ?? 0) > 0 && (
            <span className="text-cr" data-testid="deposits-overdue">
              {summary!.overdue.length} due back and still out
            </span>
          )}
          {(summary?.stale.length ?? 0) > 0 && (
            <span className="text-muted" data-testid="deposits-stale">
              {summary!.stale.length} out for years with no date on them
            </span>
          )}
        </div>
        <Button variant="primary" data-testid="btn-deposit-add" onClick={() => setAdding(true)}>
          Add deposit
        </Button>
      </div>
      <Panel scroll={{ maxH: '60vh' }} data-testid="panel-deposits">
        {rows.length === 0 ? (
          <EmptyState title="No deposits" hint="Money that is genuinely the business's and is routinely forgotten." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-24">Which way</th>
                <th scope="col">With whom</th>
                <th scope="col">What for</th>
                <th scope="col" className="w-28">Paid</th>
                <th scope="col" className="w-28">Due back</th>
                <th scope="col" className="r w-32">Amount</th>
                <th scope="col" className="w-28" />
              </tr>
            </thead>
            <tbody data-testid="rows-deposits">
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="text-muted">{d.direction === 'paid' ? 'We paid' : 'We hold'}</td>
                  <td>{d.counterparty}</td>
                  <td className="text-muted">{d.purpose ?? '—'}</td>
                  <td className="num text-muted">{toDisplayDate(d.paidOn)}</td>
                  <td className="num text-muted">{d.refundableOn ? toDisplayDate(d.refundableOn) : 'on ending'}</td>
                  <td className="r"><Money paise={d.amountPaise} /></td>
                  <td className="r">
                    <Button variant="ghost" data-testid={`btn-deposit-return-${d.id}`} onClick={() => void back(d.id, d.amountPaise)}>
                      Came back
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {adding && <DepositModal onClose={() => setAdding(false)} />}
    </>
  )
}

function DepositModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [direction, setDirection] = useState<'paid' | 'received'>('paid')
  const [counterparty, setCounterparty] = useState('')
  const [purpose, setPurpose] = useState('')
  const [amount, setAmount] = useState<number | null>(null)
  const [paidOn, setPaidOn] = useState(todayISO())
  const [refundableOn, setRefundableOn] = useState('')

  const submit = async (): Promise<void> => {
    try {
      await api.borrowing.saveDeposit({
        direction,
        counterparty: counterparty.trim(),
        partyLedgerId: null,
        ledgerId: null,
        purpose: purpose.trim() || null,
        amountPaise: amount ?? 0,
        paidOn,
        refundableOn: refundableOn || null,
        interestRateBp: null,
        notes: null
      })
      await queryClient.invalidateQueries({ queryKey: ['deposits'] })
      await queryClient.invalidateQueries({ queryKey: ['depositSummary'] })
      toast.push('success', 'Recorded')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Add deposit" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Which way">
          <Select data-testid="select-deposit-direction" value={direction} onChange={(e) => setDirection(e.target.value as 'paid' | 'received')}>
            <option value="paid">We paid it</option>
            <option value="received">We are holding it</option>
          </Select>
        </Field>
        <Field label="With whom">
          <TextInput data-testid="input-deposit-party" value={counterparty} autoFocus onChange={(e) => setCounterparty(e.target.value)} />
        </Field>
        <Field label="What for">
          <TextInput data-testid="input-deposit-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <Field label="Amount">
          <AmountInput testId="input-deposit-amount" paise={amount} onPaise={setAmount} />
        </Field>
        <Field label="Paid on">
          <TextInput type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Due back" hint="Leave empty if it comes back on ending the arrangement">
          <TextInput type="date" data-testid="input-deposit-due" value={refundableOn} onChange={(e) => setRefundableOn(e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-deposit-save" onClick={() => void submit()}>
          Save
        </Button>
      </div>
    </Modal>
  )
}

// ---------- capital work in progress (#369) ----------

function ProjectsTab(): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [costFor, setCostFor] = useState<number | null>(null)
  const { data } = useQuery({ queryKey: ['cwipProjects'], queryFn: () => api.borrowing.projects(true) })
  const rows = data ?? []

  const create = async (): Promise<void> => {
    try {
      await api.borrowing.saveProject({ name: name.trim(), startedOn: todayISO() })
      await queryClient.invalidateQueries({ queryKey: ['cwipProjects'] })
      setName('')
      setAdding(false)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const capitalise = async (id: number, projectName: string): Promise<void> => {
    try {
      const draft = await api.borrowing.capitaliseDraft(id, todayISO(), projectName)
      await api.borrowing.capitalise(id, todayISO(), null, null)
      await queryClient.invalidateQueries({ queryKey: ['cwipProjects'] })
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
      toast.push('info', 'Now record it in the asset register — depreciation starts from this date')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-end gap-2">
        {adding && (
          <TextInput
            data-testid="input-project-name"
            className="w-64"
            placeholder="What is being built"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
        )}
        <Button variant="primary" data-testid="btn-project-add" onClick={() => (adding ? void create() : setAdding(true))}>
          {adding ? 'Create' : 'New project'}
        </Button>
      </div>

      <Panel scroll={{ maxH: '62vh' }} data-testid="panel-projects">
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing under construction"
            hint="Costs accumulate against a project and become an asset on a date. Today they land in an expense or sit in a ledger nobody revisits."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col" className="w-28">Started</th>
                <th scope="col" className="r w-20">Costs</th>
                <th scope="col" className="r w-36">Spent so far</th>
                <th scope="col" className="w-48" />
              </tr>
            </thead>
            <tbody data-testid="rows-projects">
              {rows.map((p) => (
                <tr key={p.id} className={p.capitalisedOn ? 'opacity-50' : ''}>
                  <td>
                    {p.name}
                    {p.capitalisedOn && <span className="ml-2 text-caption text-muted">capitalised {toDisplayDate(p.capitalisedOn)}</span>}
                  </td>
                  <td className="num text-muted">{toDisplayDate(p.startedOn)}</td>
                  <td className="r num text-muted">{p.costs.length}</td>
                  <td className="r font-medium"><Money paise={p.totalPaise} /></td>
                  <td className="r whitespace-nowrap">
                    {!p.capitalisedOn && (
                      <>
                        <Button variant="ghost" data-testid={`btn-project-cost-${p.id}`} onClick={() => setCostFor(p.id)}>
                          Add cost
                        </Button>
                        <Button variant="ghost" data-testid={`btn-project-capitalise-${p.id}`} onClick={() => void capitalise(p.id, p.name)}>
                          Capitalise
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {costFor !== null && <CostModal projectId={costFor} onClose={() => setCostFor(null)} />}
    </>
  )
}

function CostModal({ projectId, onClose }: { projectId: number; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [date, setDate] = useState(todayISO())
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState<number | null>(null)

  const submit = async (): Promise<void> => {
    try {
      await api.borrowing.addCost(projectId, { date, description: description.trim(), amountPaise: amount ?? 0 })
      await queryClient.invalidateQueries({ queryKey: ['cwipProjects'] })
      toast.push('success', 'Cost added')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Add a cost to the project" onClose={onClose}>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Date">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="What">
          <TextInput data-testid="input-cost-desc" value={description} autoFocus onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Amount">
          <AmountInput testId="input-cost-amount" paise={amount} onPaise={setAmount} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-cost-save" onClick={() => void submit()}>
          Add
        </Button>
      </div>
    </Modal>
  )
}

// ---------- prepaid and accrued (#374) ----------

function PrepaidTab(): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const { to } = useSession()
  const [adding, setAdding] = useState(false)
  const { data } = useQuery({ queryKey: ['prepaid', to], queryFn: () => api.borrowing.prepaid(to) })
  const rows = data ?? []

  const postMonth = async (id: number, month: string): Promise<void> => {
    try {
      const draft = await api.borrowing.prepaidDraft(id, month)
      await api.borrowing.postPrepaid(id, month, null)
      await queryClient.invalidateQueries({ queryKey: ['prepaid'] })
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
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid="btn-prepaid-add" onClick={() => setAdding(true)}>
          Add schedule
        </Button>
      </div>
      <Panel scroll={{ maxH: '62vh' }} data-testid="panel-prepaid">
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing being spread"
            hint="An annual premium paid in April is not an April expense — it belongs to the twelve months it covers."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col" className="w-24">Kind</th>
                <th scope="col" className="w-44">Period</th>
                <th scope="col" className="r w-32">Amount</th>
                <th scope="col" className="r w-32">Still unexpired</th>
                <th scope="col" className="r w-32">Due to post</th>
                <th scope="col" className="w-32" />
              </tr>
            </thead>
            <tbody data-testid="rows-prepaid">
              {rows.map((s) => {
                const nextDue = s.rows.find((r) => r.to <= to && !s.postedMonths.includes(r.month))
                return (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="text-muted">{s.kind}</td>
                    <td className="num text-muted">
                      {toDisplayDate(s.periodFrom)} – {toDisplayDate(s.periodTo)}
                    </td>
                    <td className="r"><Money paise={s.amountPaise} /></td>
                    <td className="r"><Money paise={s.unexpiredPaise} /></td>
                    <td className="r text-cr"><Money paise={s.duePaise} /></td>
                    <td className="r">
                      {nextDue && (
                        <Button
                          variant="ghost"
                          data-testid={`btn-prepaid-post-${s.id}`}
                          onClick={() => void postMonth(s.id, nextDue.month)}
                        >
                          Post {nextDue.month}
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>
      {adding && <PrepaidModal onClose={() => setAdding(false)} />}
    </>
  )
}

function PrepaidModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  const [kind, setKind] = useState<'prepaid' | 'accrued'>('prepaid')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState<number | null>(null)
  const [periodFrom, setFrom] = useState(todayISO())
  const [periodTo, setTo] = useState(todayISO())
  const [basis, setBasis] = useState<'month' | 'day'>('month')
  const [expenseLedgerId, setExpenseLedgerId] = useState<number | ''>('')

  const submit = async (): Promise<void> => {
    try {
      await api.borrowing.savePrepaid({
        kind,
        name: name.trim(),
        amountPaise: amount ?? 0,
        periodFrom,
        periodTo,
        basis,
        expenseLedgerId: expenseLedgerId === '' ? null : expenseLedgerId,
        balanceLedgerId: null,
        sourceVoucherId: null,
        notes: null
      })
      await queryClient.invalidateQueries({ queryKey: ['prepaid'] })
      toast.push('success', 'Schedule saved')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Spread a payment over the months it covers" onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Which" hint="Paid ahead, or incurred and not yet paid">
          <Select data-testid="select-prepaid-kind" value={kind} onChange={(e) => setKind(e.target.value as 'prepaid' | 'accrued')}>
            <option value="prepaid">Prepaid</option>
            <option value="accrued">Accrued</option>
          </Select>
        </Field>
        <Field label="What">
          <TextInput data-testid="input-prepaid-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Amount">
          <AmountInput testId="input-prepaid-amount" paise={amount} onPaise={setAmount} />
        </Field>
        <Field label="Covers from">
          <TextInput type="date" data-testid="input-prepaid-from" value={periodFrom} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <TextInput type="date" data-testid="input-prepaid-to" value={periodTo} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Split" hint="By days when the period starts mid-month">
          <Select value={basis} onChange={(e) => setBasis(e.target.value as 'month' | 'day')}>
            <option value="month">Evenly by month</option>
            <option value="day">Weighted by days</option>
          </Select>
        </Field>
        <Field label="Expense ledger">
          <Select value={expenseLedgerId} onChange={(e) => setExpenseLedgerId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Named after the schedule</option>
            {(ledgers ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-prepaid-save" onClick={() => void submit()}>
          Save
        </Button>
      </div>
    </Modal>
  )
}

// ---------- commission (#380) ----------

function CommissionTab(): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const { from, to } = useSession()
  const [adding, setAdding] = useState(false)
  const [person, setPerson] = useState('')
  const [rate, setRate] = useState('2.5')
  const [basis, setBasis] = useState<'gross' | 'net_of_tax'>('net_of_tax')
  const { data } = useQuery({ queryKey: ['commissionReport', from, to], queryFn: () => api.commission.report(from, to) })
  const { data: schemes } = useQuery({ queryKey: ['commissionSchemes'], queryFn: api.commission.schemes })

  const saveScheme = async (): Promise<void> => {
    try {
      await api.commission.saveScheme({
        salesperson: person.trim(),
        rateBp: Math.round(Number(rate) * 100),
        basis,
        fromDate: from
      })
      await queryClient.invalidateQueries({ queryKey: ['commissionSchemes'] })
      await queryClient.invalidateQueries({ queryKey: ['commissionReport'] })
      setPerson('')
      setAdding(false)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const draft = async (): Promise<void> => {
    try {
      const d = await api.commission.draft(from, to)
      if (!d) return void toast.push('info', 'Nothing was collected, so nothing was earned')
      nav.go({
        name: 'voucher-entry',
        kindHint: 'journal',
        draft: {
          date: d.date,
          narration: d.narration,
          lines: d.lines.map((l) => ({ ledgerName: l.ledgerName, drCr: l.drCr, amount: l.amount }))
        },
        draftId: Date.now()
      } as never)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-body-sm text-muted">
          Collected {formatPaise(data?.totalCollectedPaise ?? 0)} · commission{' '}
          <span className="font-medium text-ink">{formatPaise(data?.totalCommissionPaise ?? 0)}</span>
          {(data?.unassignedCollectedPaise ?? 0) > 0 && (
            <span className="ml-3" data-testid="commission-unassigned">
              {formatPaise(data!.unassignedCollectedPaise)} collected from parties with no salesperson
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {adding && (
            <>
              <TextInput className="w-40" data-testid="input-commission-person" placeholder="Salesperson" value={person} onChange={(e) => setPerson(e.target.value)} />
              <TextInput className="num w-20 text-right" data-testid="input-commission-rate" value={rate} onChange={(e) => setRate(e.target.value)} />
              <Select value={basis} onChange={(e) => setBasis(e.target.value as 'gross' | 'net_of_tax')}>
                <option value="net_of_tax">Net of tax</option>
                <option value="gross">On the receipt</option>
              </Select>
            </>
          )}
          <Button data-testid="btn-commission-scheme" onClick={() => (adding ? void saveScheme() : setAdding(true))}>
            {adding ? 'Save scheme' : 'Rates'}
          </Button>
          <Button variant="primary" data-testid="btn-commission-draft" onClick={() => void draft()}>
            Draft the journal
          </Button>
        </div>
      </div>

      {(data?.withoutScheme.length ?? 0) > 0 && (
        <p className="mb-2 text-hint text-cr" data-testid="commission-noscheme">
          {data!.withoutScheme.join(', ')} collected money but {data!.withoutScheme.length === 1 ? 'has' : 'have'} no
          rate. No rate is not a zero rate, so nothing was computed for them.
        </p>
      )}

      <Panel scroll={{ maxH: '58vh' }} data-testid="panel-commission">
        {(data?.statements.length ?? 0) === 0 ? (
          <EmptyState
            title="Nothing earned in this period"
            hint="Commission is earned when the money arrives, not when the invoice is raised — an uncollected invoice earns nothing."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Salesperson / bill</th>
                <th scope="col">Party</th>
                <th scope="col" className="w-28">Collected on</th>
                <th scope="col" className="r w-32">Collected</th>
                <th scope="col" className="r w-32">Base</th>
                <th scope="col" className="r w-32">Commission</th>
              </tr>
            </thead>
            <tbody data-testid="rows-commission">
              {(data?.statements ?? []).flatMap((s) => [
                <tr key={`h-${s.salesperson}`} className="total-row">
                  <td colSpan={3}>{s.salesperson}</td>
                  <td className="r"><Money paise={s.collectedPaise} /></td>
                  <td className="r"><Money paise={s.basePaise} /></td>
                  <td className="r"><Money paise={s.commissionPaise} /></td>
                </tr>,
                ...s.rows.map((r) => (
                  <tr key={`${s.salesperson}-${r.billNumber}`}>
                    <td className="num pl-6 text-muted">{r.billNumber}</td>
                    <td className="text-muted">{r.partyName}</td>
                    <td className="num text-muted">{toDisplayDate(r.date)}</td>
                    <td className="r"><Money paise={r.collectedPaise} /></td>
                    <td className="r text-muted"><Money paise={r.basePaise} /></td>
                    <td className="r"><Money paise={r.commissionPaise} /></td>
                  </tr>
                ))
              ])}
            </tbody>
          </table>
        )}
      </Panel>

      {(schemes?.length ?? 0) > 0 && (
        <p className="mt-2 text-hint text-muted" data-testid="commission-rates">
          {schemes!.map((s) => `${s.salesperson} ${(s.rateBp / 100).toFixed(2)}% ${s.basis === 'gross' ? 'on the receipt' : 'net of tax'} from ${s.fromDate}`).join(' · ')}
        </p>
      )}
    </>
  )
}
