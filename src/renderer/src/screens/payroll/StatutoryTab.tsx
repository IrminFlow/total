// Payroll → Statutory (WP 3.7): PF / ESI / PT / salary TDS payable by month with due dates and
// paid / unpaid status, paying a month's dues (a Payment voucher against the tagged payable
// ledger; salary TDS can register its challan on the TDS screen too), the exports per due (ECR,
// ESI upload, PT return per state; 24Q lives on the TDS screen), data for Form 16 per employee,
// and the compute-only gratuity / bonus helpers.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Group, Ledger } from '@shared/domain'
import { fyFromStartYear, fyOf, toDisplayDate, todayISO } from '@shared/dates'
import { CASH_BANK_GROUPS } from '@shared/seed'
import { bonus, gratuity } from '@shared/payrollStatutory'
import { api } from '../../lib/client'
import { statApi, type Form16Data, type StatutoryDueRow, type StatutoryPayment } from '../../lib/payrollStatutoryClient'
import { useNav, useToasts } from '../../state/stores'
import { useGroups, useLedgers } from '../../components/pickers'
import { confirmDialog } from '../../lib/dialogs'
import {
  AmountInput, Badge, Button, DateInput, Field, Modal, Money, Panel, SectionTitle, Select, StatGrid, StatTile, TextInput
} from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { VoucherLink } from '../../components/links'

const KIND_LABEL: Record<StatutoryDueRow['kind'], string> = { pf: 'EPF', esi: 'ESI', pt: 'Professional tax', tds: 'Salary TDS' }
const KIND_OPTIONS = (Object.keys(KIND_LABEL) as StatutoryDueRow['kind'][]).map((k) => ({ value: k, label: KIND_LABEL[k] }))
const STATUS: Record<StatutoryDueRow['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  paid: { label: 'Paid', tone: 'success' },
  part: { label: 'Part paid', tone: 'warning' },
  unpaid: { label: 'Unpaid', tone: 'info' },
  overdue: { label: 'Overdue', tone: 'danger' },
  nil: { label: 'Nil', tone: 'neutral' }
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (m: string): string => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`

export const DUE_COLUMNS = defineColumns<StatutoryDueRow>([
  { id: 'period', header: 'Month', kind: 'text', value: (r) => r.period, text: (r) => monthLabel(r.period), width: 96, hideable: false },
  {
    id: 'kind', header: 'Statute', kind: 'enum', value: (r) => r.kind, options: KIND_OPTIONS, width: 168,
    text: (r) => `${KIND_LABEL[r.kind]}${r.state ? ` · ${r.state}` : ''}`,
    cell: (r) => <span className="font-medium">{KIND_LABEL[r.kind]}{r.state && <span className="num ml-1 font-normal text-muted">· {r.state}</span>}</span>
  },
  { id: 'employees', header: 'Employees', kind: 'number', value: (r) => r.employees, width: 92, defaultHidden: true },
  { id: 'employee', header: 'Employee', kind: 'money', value: (r) => r.employeePaise, aggregate: 'sum', width: 112 },
  { id: 'employer', header: 'Employer', kind: 'money', value: (r) => r.employerPaise, aggregate: 'sum', width: 112 },
  { id: 'payable', header: 'Payable', kind: 'money', value: (r) => r.payablePaise, aggregate: 'sum', width: 112, className: 'font-medium' },
  { id: 'paid', header: 'Paid', kind: 'money', value: (r) => r.paidPaise, aggregate: 'sum', width: 104 },
  { id: 'outstanding', header: 'Outstanding', kind: 'money', value: (r) => r.outstandingPaise, aggregate: 'sum', width: 112 },
  { id: 'due', header: 'Due by', kind: 'date', value: (r) => r.dueDate, width: 100 },
  {
    id: 'status', header: 'Status', kind: 'enum', value: (r) => r.status, width: 96,
    options: (Object.keys(STATUS) as StatutoryDueRow['status'][]).map((s) => ({ value: s, label: STATUS[s].label })),
    cell: (r) => <Badge tone={STATUS[r.status].tone} testId={`due-status-${r.key}`}>{STATUS[r.status].label}</Badge>
  }
])

export const PAYMENT_COLUMNS = defineColumns<StatutoryPayment>([
  { id: 'paidOn', header: 'Paid on', kind: 'date', value: (p) => p.paidOn, width: 104 },
  { id: 'kind', header: 'Statute', kind: 'enum', value: (p) => p.kind, options: KIND_OPTIONS, width: 130, cell: (p) => KIND_LABEL[p.kind] },
  { id: 'period', header: 'For', kind: 'text', value: (p) => p.period, text: (p) => `${monthLabel(p.period)}${p.state ? ` · ${p.state}` : ''}`, width: 120 },
  { id: 'amount', header: 'Amount', kind: 'money', value: (p) => p.amountPaise, aggregate: 'sum', width: 116 },
  { id: 'voucher', header: 'Voucher', kind: 'text', value: (p) => p.voucherNumber ?? '', width: 100, cell: (p) => <VoucherLink voucherId={p.paymentVoucherId} label={p.voucherNumber ?? 'Open'} /> },
  { id: 'reference', header: 'Reference', kind: 'text', value: (p) => p.reference ?? '', className: 'text-muted' },
  { id: 'challan', header: 'TDS challan', kind: 'text', value: (p) => (p.tdsChallanId ? 'Registered' : ''), width: 110, className: 'text-muted' }
])

type F16Row = Form16Data['employees'][number]
export const FORM16_COLUMNS = defineColumns<F16Row>([
  { id: 'name', header: 'Employee', kind: 'text', value: (e) => e.name, hideable: false, minWidth: 140 },
  { id: 'pan', header: 'PAN', kind: 'text', value: (e) => e.pan, text: (e) => e.pan ?? 'Missing', width: 116, className: 'num' },
  { id: 'regime', header: 'Regime', kind: 'enum', value: (e) => e.regime, options: [{ value: 'new', label: 'New' }, { value: 'old', label: 'Old' }], width: 80 },
  { id: 'gross', header: 'Salary paid', kind: 'money', value: (e) => e.workings.gross, aggregate: 'sum', width: 124 },
  { id: 'income', header: 'Total income', kind: 'money', value: (e) => e.workings.totalIncome, width: 124 },
  { id: 'tax', header: 'Tax for the year', kind: 'money', value: (e) => e.workings.taxOnIncome.total, aggregate: 'sum', width: 124 },
  { id: 'tds', header: 'TDS deducted', kind: 'money', value: (e) => e.tdsDeductedPaise, aggregate: 'sum', width: 120 }
])

/** Cash / bank ledgers (CASH_BANK_GROUPS and their sub-groups). */
function cashBank(ledgers: Ledger[], groups: Group[]): Ledger[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const isCb = (gid: number | null): boolean => {
    for (let g = gid != null ? byId.get(gid) : undefined; g; g = g.parentId != null ? byId.get(g.parentId) : undefined) {
      if (CASH_BANK_GROUPS.includes(g.name)) return true
    }
    return false
  }
  return ledgers.filter((l) => isCb(l.groupId))
}

export function StatutoryTab({ fyStartYear }: { fyStartYear: number }): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const fy = fyFromStartYear(fyStartYear)
  const { data: dues, isLoading } = useQuery({ queryKey: ['payrollDues', fyStartYear], queryFn: () => statApi.dues(fyStartYear) })
  const { data: payments } = useQuery({ queryKey: ['payrollPayments', fyStartYear], queryFn: () => statApi.payments(fyStartYear) })
  const { data: f16, isLoading: f16Loading } = useQuery({ queryKey: ['payrollForm16', fyStartYear], queryFn: () => statApi.form16(fyStartYear) })
  const [paying, setPaying] = useState<StatutoryDueRow | null>(null)

  const outstanding = (k: StatutoryDueRow['kind']): number => (dues ?? []).filter((d) => d.kind === k).reduce((s, d) => s + d.outstandingPaise, 0)
  const overdue = (k: StatutoryDueRow['kind']): number => (dues ?? []).filter((d) => d.kind === k && d.status === 'overdue').length

  const exportDue = async (d: StatutoryDueRow): Promise<void> => {
    try {
      if (d.kind === 'tds') return nav.go({ name: 'tds' })
      const r = d.kind === 'pf' ? await api.payroll.ecr(d.runId) : d.kind === 'esi' ? await api.payroll.esiCsv(d.runId) : await statApi.ptReturnCsv(d.runId, d.state!)
      toast.push('success', `${d.kind === 'pf' ? 'PF ECR' : d.kind === 'esi' ? 'ESI upload CSV' : `PT return (${d.state})`}: ${r.path.split('/').pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const removePayment = async (p: StatutoryPayment): Promise<void> => {
    if (!(await confirmDialog({ title: 'Delete payment', message: `Delete this ${KIND_LABEL[p.kind]} payment and move its voucher to the bin?`, confirmLabel: 'Delete', danger: true }))) return
    try {
      await statApi.deletePayment(p.id)
      await queryClient.invalidateQueries()
      toast.push('success', 'Payment deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const pdf = async (employeeId?: number): Promise<void> => {
    try {
      const r = await statApi.form16Pdf(fyStartYear, employeeId)
      toast.push('success', `${f16?.formName ?? 'Form 16'} data saved (${r.path.split('/').pop()}) — Part A comes from TRACES`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const tile = (k: StatutoryDueRow['kind']): React.JSX.Element => (
    <StatTile
      key={k}
      label={`${KIND_LABEL[k]} outstanding`}
      value={<Money paise={outstanding(k)} />}
      delta={overdue(k) ? `${overdue(k)} overdue` : 'nothing overdue'}
      deltaTone={overdue(k) ? 'danger' : 'neutral'}
      loading={isLoading}
      testId={`payroll-due-${k}`}
    />
  )

  return (
    <div className="flex flex-col gap-section">
      <StatGrid>{(['pf', 'esi', 'pt', 'tds'] as const).map(tile)}</StatGrid>

      <Panel>
        <div className="px-3 pt-3">
          <SectionTitle as="h3">Dues — FY {fy.label}</SectionTitle>
        </div>
        <DataTable
          viewId="payroll-dues"
          testId="payroll-dues"
          ariaLabel={`Statutory dues — FY ${fy.label}`}
          columns={DUE_COLUMNS}
          rows={dues ?? []}
          rowKey={(d) => d.key}
          rowAttrs={(d) => ({ 'data-row-id': d.key })}
          loading={isLoading}
          empty={{ title: 'No pay runs posted this year', hint: 'Dues appear here once a pay run is posted' }}
          maxHeight="46vh"
          viewDefaults={{ sort: [{ id: 'period', dir: 'desc' }] }}
          trailingWidth={128}
          trailing={(d) => (
            <span className="inline-flex items-center gap-3 text-small">
              {d.outstandingPaise > 0 && (
                <button className="text-blue hover:underline" data-testid={`btn-due-pay-${d.key}`} onClick={() => setPaying(d)}>
                  Pay…
                </button>
              )}
              <button className="text-muted hover:text-ink" data-testid={`btn-due-export-${d.key}`} onClick={() => void exportDue(d)}
                title={d.kind === 'tds' ? 'Form 24Q is on the TDS screen (Returns)' : 'Export the return / upload file'}>
                {d.kind === 'pf' ? 'ECR' : d.kind === 'esi' ? 'ESI CSV' : d.kind === 'pt' ? 'PT CSV' : '24Q →'}
              </button>
            </span>
          )}
          exportOptions={{ title: 'Statutory dues', periodLabel: `FY ${fy.label}`, filename: `statutory-dues-${fy.label}` }}
        />
      </Panel>

      <Panel>
        <div className="px-3 pt-3"><SectionTitle as="h3">Payments</SectionTitle></div>
        <DataTable
          viewId="payroll-payments"
          testId="payroll-payments"
          ariaLabel="Statutory payments"
          columns={PAYMENT_COLUMNS}
          rows={payments ?? []}
          rowKey={(p) => p.id}
          maxHeight="30vh"
          empty={{ title: 'No statutory payments recorded', hint: 'Use Pay… on a due' }}
          trailingWidth={72}
          trailing={(p) => (
            <button className="text-small text-cr hover:underline" onClick={() => void removePayment(p)}>
              Delete
            </button>
          )}
        />
      </Panel>

      <Panel>
        <div className="px-3 pt-3">
          <SectionTitle
            as="h3"
            right={
              <Button size="sm" data-testid="btn-form16-pdf-all" disabled={!f16?.employees.length} onClick={() => void pdf()}>
                PDF for every employee
              </Button>
            }
          >
            Data for {f16?.formName ?? 'Form 16'} — FY {fy.label}
          </SectionTitle>
        </div>
        <p className="px-3 pb-2 text-hint text-muted">
          {f16?.act === '2025'
            ? 'Form No. 130 (Income-tax Rules 2026 rule 215, certificate u/s 395) — Part C salary workings from the runs posted so far and the declarations; issue by 15 June after the year.'
            : 'Form No. 16 (rule 31(1)(a)) — Part B salary workings from the runs posted so far and the declarations; Part A is downloaded from TRACES.'}
        </p>
        <DataTable
          viewId="payroll-form16"
          testId="payroll-form16"
          ariaLabel={`Form 16 data — FY ${fy.label}`}
          columns={FORM16_COLUMNS}
          rows={f16?.employees ?? []}
          rowKey={(e) => e.employeeId}
          loading={f16Loading}
          maxHeight="30vh"
          empty={{ title: 'No salary paid in this year' }}
          trailingWidth={80}
          trailing={(e) => (
            <Button size="sm" variant="ghost" data-testid={`btn-form16-pdf-${e.employeeId}`} onClick={() => void pdf(e.employeeId)}>
              PDF
            </Button>
          )}
        />
      </Panel>

      <GratuityBonusPanel />

      {paying && <PayDueModal due={paying} onClose={() => setPaying(null)} />}
    </div>
  )
}

function PayDueModal({ due, onClose }: { due: StatutoryDueRow; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const banks = cashBank(useLedgers(), useGroups())
  const [amount, setAmount] = useState<number | null>(due.outstandingPaise)
  const [paidOn, setPaidOn] = useState(todayISO() < due.dueDate ? todayISO() : due.dueDate)
  const [bankId, setBankId] = useState<number | ''>('')
  const [reference, setReference] = useState('')
  const [bsr, setBsr] = useState('')
  const [challan, setChallan] = useState('')
  const [saving, setSaving] = useState(false)
  const bank = bankId || banks.find((b) => b.name !== 'Cash')?.id || banks[0]?.id || ''

  const save = async (): Promise<void> => {
    if (!bank) return void toast.push('error', 'Create a bank or cash ledger first')
    if (!amount || amount <= 0) return void toast.push('error', 'Enter the amount paid')
    setSaving(true)
    try {
      await statApi.recordPayment({
        kind: due.kind, period: due.period, state: due.state, amountPaise: amount, paidOn, bankLedgerId: Number(bank),
        reference: reference.trim() || null,
        bsrCode: due.kind === 'tds' && bsr.trim() ? bsr.trim() : null,
        challanNo: due.kind === 'tds' && challan.trim() ? challan.trim() : null
      })
      await queryClient.invalidateQueries()
      toast.push('success', `${KIND_LABEL[due.kind]} for ${monthLabel(due.period)} paid — Payment voucher booked`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Pay ${KIND_LABEL[due.kind]}${due.state ? ` (${due.state})` : ''} — ${monthLabel(due.period)}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-body-sm text-muted">
          Due by {toDisplayDate(due.dueDate)} · payable <Money paise={due.payablePaise} />, paid so far <Money paise={due.paidPaise} />. Books a Payment voucher debiting the payable ledger.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount"><AmountInput paise={amount} onPaise={setAmount} testId="input-due-amount" /></Field>
          <Field label="Paid on"><DateInput value={paidOn} context={paidOn} onChange={setPaidOn} testId="input-due-date" /></Field>
          <Field label="Paid from">
            <Select value={bank} onChange={(e) => setBankId(e.target.value ? Number(e.target.value) : '')} data-testid="input-due-bank">
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
          <Field label={due.kind === 'pf' ? 'TRRN / challan' : due.kind === 'esi' ? 'Challan no.' : 'Reference'}>
            <TextInput value={reference} onChange={(e) => setReference(e.target.value)} data-testid="input-due-reference" />
          </Field>
          {due.kind === 'tds' && (
            <>
              <Field label="BSR code" hint="Registers the challan on the TDS screen"><TextInput value={bsr} onChange={(e) => setBsr(e.target.value)} className="num" data-testid="input-due-bsr" /></Field>
              <Field label="Challan serial"><TextInput value={challan} onChange={(e) => setChallan(e.target.value)} className="num" data-testid="input-due-challan" /></Field>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} data-testid="btn-due-save" onClick={() => void save()}>Record payment</Button>
        </div>
      </div>
    </Modal>
  )
}

/** Compute-only gratuity (CoSS s.53) and bonus (Code on Wages s.26) helpers — nothing posts. */
function GratuityBonusPanel(): React.JSX.Element {
  const [wages, setWages] = useState<number | null>(30_000_00)
  const [years, setYears] = useState('7')
  const [months, setMonths] = useState('0')
  const [fixedTerm, setFixedTerm] = useState(false)
  const [bonusRate, setBonusRate] = useState('8.33')
  const [bonusSalary, setBonusSalary] = useState<number | null>(15_000_00)
  const g = useMemo(
    () => gratuity({ monthlyWagesPaise: wages ?? 0, years: Number(years) || 0, months: Number(months) || 0, fixedTerm }),
    [wages, years, months, fixedTerm]
  )
  const b = useMemo(
    () => bonus({ monthlySalariesPaise: Array(12).fill(bonusSalary ?? 0), rateBp: Math.round((Number(bonusRate) || 0) * 100), workingDays: 240 }),
    [bonusSalary, bonusRate]
  )
  return (
    <Panel className="p-panel">
      <SectionTitle as="h3">Gratuity and bonus (compute only)</SectionTitle>
      <div className="mt-2 grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-3 gap-2">
            <Field label="Last wages / month"><AmountInput paise={wages} onPaise={setWages} testId="input-gratuity-wages" /></Field>
            <Field label="Years"><TextInput value={years} onChange={(e) => setYears(e.target.value)} className="num text-right" /></Field>
            <Field label="Months"><TextInput value={months} onChange={(e) => setMonths(e.target.value)} className="num text-right" /></Field>
          </div>
          <label className="flex items-center gap-2 text-detail"><input type="checkbox" checked={fixedTerm} onChange={(e) => setFixedTerm(e.target.checked)} />Fixed-term employee (pro rata, no 5-year minimum)</label>
          <p className="text-body-sm" data-testid="gratuity-result">
            {g.eligible ? <>Gratuity <b><Money paise={g.amountPaise} /></b> for {g.serviceYears} year{g.serviceYears === 1 ? '' : 's'} (15/26 × wages × years, ₹20 lakh cap)</> : 'Not eligible — under five years of continuous service'}
          </p>
          <p className="text-hint text-muted">Code on Social Security 2020 s.53 (from 21-11-2025; formerly Payment of Gratuity Act 1972 s.4).</p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Salary / month (basic + DA)"><AmountInput paise={bonusSalary} onPaise={setBonusSalary} testId="input-bonus-salary" /></Field>
            <Field label="Bonus rate %" hint="8.33 – 20"><TextInput value={bonusRate} onChange={(e) => setBonusRate(e.target.value)} className="num text-right" /></Field>
          </div>
          <p className="text-body-sm" data-testid="bonus-result">
            {b.eligible ? <>Bonus for a full year <b><Money paise={b.amountPaise} /></b> on a base of <Money paise={b.basePaise} /></> : 'Not eligible — salary above ₹21,000 a month'}
          </p>
          <p className="text-hint text-muted">Code on Wages 2019 s.26 (from 21-11-2025): ₹21,000 eligibility, calculated on ₹7,000 or the minimum wage.</p>
        </div>
      </div>
    </Panel>
  )
}

export function useFyChoices(booksFrom: number | undefined): number[] {
  const current = fyOf(todayISO()).startYear
  const out: number[] = []
  for (let y = current; y >= Math.min(booksFrom ?? current, current); y--) out.push(y)
  return out
}
