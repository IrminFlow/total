import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Employee, PayrollRun } from '@shared/domain'
import { daysInMonth } from '@shared/payroll'
import { todayISO, toDisplayDate } from '@shared/dates'
import { api, type EmployeeHeadRow, type PayHead } from '../lib/client'
import { formatPaise, parseRupees } from '@shared/money'
import { useNav, useToasts } from '../state/stores'
import {
  AmountInput,
  Button,
  EmptyState,
  ExportGroup,
  Field,
  inputCls,
  Modal,
  Money,
  Panel,
  RowAction,
  ScrollList,
  SectionTitle,
  Select,
  SkeletonRows,
  Spinner,
  TextInput,
  useTableNav
} from '../components/ui'
import { confirmDialog } from '../lib/dialogs'
import { TabBar } from '../components/TabBar'
import { useStickyTab } from '../lib/useStickyTab'
import { AttendanceTab, AdvancesTab, Form16Modal, PayslipsModal, SettlementModal } from './payrollTabs'
import { auditFieldChanges, fieldLabel } from '@shared/auditDiff'
import { csvReport, printReport } from '../lib/reportExport'
import type { ReportColumn as PdfColumn, ReportRow as PdfRow } from '../lib/client'

type Tab = 'employees' | 'attendance' | 'advances' | 'runs' | 'trend'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-08' → 'Aug 2026'. */
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`
}

export function PayrollScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab<Tab>(
    'payroll',
    ['employees', 'attendance', 'advances', 'runs', 'trend'],
    'employees'
  )
  // One month drives the attendance register and the "what will the next run recover" banner, so
  // moving between the two tabs does not mean picking the month twice.
  const [month, setMonth] = useState(() => todayISO().slice(0, 7))
  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <TabBar
            screen="payroll"
            tabs={[
              { id: 'employees', label: 'Employees' },
              { id: 'attendance', label: 'Attendance' },
              { id: 'advances', label: 'Advances' },
              { id: 'runs', label: 'Pay runs' },
              { id: 'trend', label: 'Cost over time' }
            ]}
            active={tab}
            onSelect={setTab}
          />
        }
      >
        Payroll
      </SectionTitle>
      {tab === 'employees' && <EmployeesTab />}
      {tab === 'attendance' && <AttendanceTab month={month} onMonth={setMonth} />}
      {tab === 'advances' && <AdvancesTab month={month} />}
      {tab === 'runs' && <RunsTab />}
      {tab === 'trend' && <TrendTab />}
      <StatutoryFootnote month={month} />
    </div>
  )
}

// ---------- employees ----------

function EmployeesTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: employees } = useQuery({ queryKey: ['employees'], queryFn: api.payroll.employees })
  const [editing, setEditing] = useState<Employee | 'new' | null>(null)
  const [settling, setSettling] = useState<Employee | null>(null)
  const [form16For, setForm16For] = useState<Employee | null>(null)
  const [headsOpen, setHeadsOpen] = useState(false)
  const [overridesFor, setOverridesFor] = useState<Employee | null>(null)
  // Enter opens the selected employee for editing, matching the row's Edit button.
  const table = useTableNav(employees ?? [], { rowId: (e) => e.id, onEnter: (e) => setEditing(e) })

  const remove = async (e: Employee): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete employee',
      message: `Delete ${e.name}? Employees with payroll history can't be deleted — mark them inactive instead.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.payroll.removeEmployee(e.id)
      await queryClient.invalidateQueries({ queryKey: ['employees'] })
      toast.push('success', `${e.name} deleted`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end gap-2">
        <Button data-testid="btn-payroll-pay-heads" onClick={() => setHeadsOpen(true)}>
          Pay heads…
        </Button>
        <Button variant="primary" data-testid="btn-payroll-add-employee" onClick={() => setEditing('new')}>
          Add employee
        </Button>
      </div>
      <Panel scroll={{ maxH: '58vh' }}>
        {!employees?.length ? (
          <EmptyState title="No employees yet" hint="Add employees with their monthly salary structure, then post a pay run" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Designation</th>
                <th scope="col" className="r w-28">Basic</th>
                <th scope="col" className="r w-28">HRA</th>
                <th scope="col" className="r w-28">Special</th>
                <th scope="col" className="r w-28">Gross / mo</th>
                <th scope="col" className="w-[22rem]"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-payroll-employees">
              {employees.map((e, i) => (
                <tr
                  key={e.id}
                  {...table.rowProps(i, e)}
                  className={`${table.rowProps(i, e).className} ${e.active ? '' : 'opacity-50'}`}
                >
                  <td>
                    {e.name}
                    {!e.active && <span className="ml-2 text-caption text-muted">inactive</span>}
                  </td>
                  <td className="text-muted">{e.designation}</td>
                  <td className="r"><Money paise={e.basic} /></td>
                  <td className="r"><Money paise={e.hra} /></td>
                  <td className="r"><Money paise={e.special} /></td>
                  <td className="r font-medium"><Money paise={e.basic + e.hra + e.special} /></td>
                  <td className="r">
                    <button
                      className="mr-3 text-small text-muted hover:text-ink"
                      data-testid="btn-payroll-overrides"
                      onClick={() => setOverridesFor(e)}
                    >
                      Heads
                    </button>
                    <RowAction
                      data-testid="btn-payroll-edit-employee"
                      onClick={() => setEditing(e)}
                    >
                      Edit
                    </RowAction>
                    <button
                      className="mr-3 text-small text-muted hover:text-ink"
                      data-testid={`btn-payroll-form16-${e.id}`}
                      title="Form 16 Part B"
                      onClick={() => setForm16For(e)}
                    >
                      Form 16
                    </button>
                    <button
                      className="mr-3 text-small text-muted hover:text-ink"
                      data-testid={`btn-payroll-settle-${e.id}`}
                      title="Full and final settlement"
                      onClick={() => setSettling(e)}
                    >
                      Settle
                    </button>
                    <button
                      className="text-small text-cr hover:underline"
                      data-testid="btn-payroll-delete-employee"
                      onClick={() => void remove(e)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {editing && <EmployeeModal employee={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {headsOpen && <PayHeadsModal onClose={() => setHeadsOpen(false)} />}
      {overridesFor && <EmployeeHeadsModal employee={overridesFor} onClose={() => setOverridesFor(null)} />}
      {settling && (
        <SettlementModal employeeId={settling.id} employeeName={settling.name} onClose={() => setSettling(null)} />
      )}
      {form16For && (
        <Form16Modal employeeId={form16For.id} employeeName={form16For.name} onClose={() => setForm16For(null)} />
      )}
    </>
  )
}

function EmployeeModal({ employee, onClose }: { employee: Employee | null; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [name, setName] = useState(employee?.name ?? '')
  const [designation, setDesignation] = useState(employee?.designation ?? '')
  const [code, setCode] = useState(employee?.code ?? '')
  const [pan, setPan] = useState(employee?.pan ?? '')
  const [uan, setUan] = useState(employee?.uan ?? '')
  const [bankAccount, setBankAccount] = useState(employee?.bankAccount ?? '')
  const [ifsc, setIfsc] = useState(employee?.ifsc ?? '')
  const [basic, setBasic] = useState<number | null>(employee?.basic ?? null)
  const [hra, setHra] = useState<number | null>(employee?.hra ?? null)
  const [special, setSpecial] = useState<number | null>(employee?.special ?? null)
  const [pfEnabled, setPf] = useState(employee?.pfEnabled ?? true)
  const [esiEnabled, setEsi] = useState(employee?.esiEnabled ?? true)
  const [ptEnabled, setPt] = useState(employee?.ptEnabled ?? true)
  const [active, setActive] = useState(employee?.active ?? true)
  const [joined, setJoined] = useState(employee?.joined ?? '')
  const [email, setEmail] = useState(employee?.email ?? '')
  const [phone, setPhone] = useState(employee?.phone ?? '')
  const [taxRegime, setTaxRegime] = useState<'new' | 'old'>(employee?.taxRegime ?? 'new')
  const [declared, setDeclared] = useState<number | null>(employee?.declaredDeductions ?? null)
  const [openingTds, setOpeningTds] = useState<number | null>(employee?.openingTds ?? null)

  const save = async (): Promise<void> => {
    try {
      await api.payroll.saveEmployee(
        {
          name: name.trim(),
          code: code.trim() || null,
          designation: designation.trim() || null,
          joined: joined.trim() || null,
          pan: pan.trim() || null,
          uan: uan.trim() || null,
          esicNo: employee?.esicNo ?? null,
          bankAccount: bankAccount.trim() || null,
          ifsc: ifsc.trim().toUpperCase() || null,
          basic: basic ?? 0,
          hra: hra ?? 0,
          special: special ?? 0,
          email: email.trim() || null,
          phone: phone.trim() || null,
          taxRegime,
          declaredDeductions: taxRegime === 'old' ? declared : null,
          openingTds,
          pfEnabled,
          esiEnabled,
          ptEnabled,
          active
        },
        employee?.id
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['employees'] }),
        queryClient.invalidateQueries({ queryKey: ['payrollPreview'] }),
        queryClient.invalidateQueries({ queryKey: ['employeeHeads'] })
      ])
      toast.push('success', `${name.trim()} saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const check = (label: string, value: boolean, set: (v: boolean) => void): React.JSX.Element => (
    <label className="flex items-center gap-2 text-detail">
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  )

  return (
    <Modal title={employee ? `Edit ${employee.name}` : 'Add employee'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Designation">
            <TextInput value={designation} onChange={(e) => setDesignation(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Employee code">
            <TextInput value={code} onChange={(e) => setCode(e.target.value)} className="num" />
          </Field>
          <Field label="PAN">
            <TextInput value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} className="num" />
          </Field>
          <Field label="UAN">
            <TextInput value={uan} onChange={(e) => setUan(e.target.value)} className="num" />
          </Field>
        </div>
        {/* Needed only for the bulk transfer file. An employee genuinely paid in cash has
            neither, and payroll must not refuse a run over it. */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank account" hint="For the salary transfer file. Leave blank if paid in cash.">
            <TextInput
              data-testid="input-employee-account"
              value={bankAccount}
              onChange={(e) => setBankAccount(e.target.value)}
              className="num"
            />
          </Field>
          <Field
            label="IFSC"
            error={ifsc.trim() && !/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(ifsc.trim()) ? 'Not an IFSC (e.g. HDFC0001234)' : null}
          >
            <TextInput
              data-testid="input-employee-ifsc"
              value={ifsc}
              onChange={(e) => setIfsc(e.target.value.toUpperCase())}
              className="num"
              placeholder="HDFC0001234"
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Joined" hint="Gratuity cannot be computed without it">
            <TextInput
              type="date"
              data-testid="input-employee-joined"
              value={joined}
              onChange={(e) => setJoined(e.target.value)}
            />
          </Field>
          <Field label="Email" hint="Where the payslip goes">
            <TextInput
              data-testid="input-employee-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              inputMode="email"
            />
          </Field>
          <Field label="Phone" hint="Drives WhatsApp payslip delivery">
            <TextInput
              data-testid="input-employee-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="num"
              inputMode="tel"
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field
            label="Tax regime"
            hint={taxRegime === 'new' ? 'The statutory default. Almost no deductions survive it.' : 'Chosen deliberately'}
          >
            <Select
              data-testid="select-employee-regime"
              value={taxRegime}
              onChange={(e) => setTaxRegime(e.target.value as 'new' | 'old')}
            >
              <option value="new">New (section 115BAC)</option>
              <option value="old">Old</option>
            </Select>
          </Field>
          <Field
            label="Declared deductions"
            hint={taxRegime === 'old' ? '80C, 80D and the rest, for the year' : 'Not allowed under the new regime'}
          >
            <AmountInput paise={declared} onPaise={setDeclared} />
          </Field>
          <Field label="TDS already taken" hint="This financial year, by a previous system">
            <AmountInput paise={openingTds} onPaise={setOpeningTds} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Basic / month">
            <AmountInput paise={basic} onPaise={setBasic} />
          </Field>
          <Field label="HRA / month">
            <AmountInput paise={hra} onPaise={setHra} />
          </Field>
          <Field label="Special / month">
            <AmountInput paise={special} onPaise={setSpecial} />
          </Field>
        </div>
        <div className="flex gap-5">
          {check('EPF', pfEnabled, setPf)}
          {check('ESI', esiEnabled, setEsi)}
          {check('Professional tax', ptEnabled, setPt)}
          {check('Active', active, setActive)}
        </div>
        {employee && <SalaryHistory employeeId={employee.id} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-payroll-save-employee" onClick={() => void save()}>
            Save employee
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Pay fields, in the order they appear on the form. Anything else — a corrected PAN, a change of
 *  professional-tax state — is a change to the record but not a salary revision, and listing it
 *  here would bury the ones that are. */
const PAY_FIELDS = new Set(['basic', 'hra', 'special'])

/**
 * When this employee's pay changed, and by how much.
 *
 * Derived from the audit log rather than a second table: employee saves have always recorded
 * their full before and after, so the revision history already existed — it simply had nowhere to
 * be read. A separate salary-history table would be a second record of the same fact, free to
 * disagree with the first.
 *
 * Collapsed by default. Most edits are opened to fix a detail, not to review a history.
 */
function SalaryHistory({ employeeId }: { employeeId: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['employeeAudit', employeeId],
    queryFn: () => api.audit.list({ entity: 'employee', entityId: employeeId, page: 0, pageSize: 50 }),
    enabled: open
  })

  const revisions = (data?.rows ?? [])
    .filter((row) => row.beforeJson && row.afterJson)
    .map((row) => ({
      row,
      changes: auditFieldChanges(
        JSON.parse(row.beforeJson!) as unknown,
        JSON.parse(row.afterJson!) as unknown,
        (paise) => formatPaise(paise)
      ).filter((c) => PAY_FIELDS.has(c.field))
    }))
    .filter((r) => r.changes.length > 0)

  return (
    <div>
      <button
        data-testid="btn-salary-history"
        className="text-small text-muted hover:text-ink"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} Salary history
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-line bg-panel2 p-3" data-testid="salary-history">
          {!data ? (
            <p className="text-hint text-muted">Loading…</p>
          ) : revisions.length === 0 ? (
            // Possible and unremarkable: an employee whose pay has never been changed since they
            // were added, or one imported before the audit log covered them.
            <p className="text-hint text-muted">No pay changes recorded for this employee.</p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {revisions.map(({ row, changes }) => (
                <li key={row.id} className="text-body-sm">
                  <span className="num text-muted">{row.at}</span>
                  <span className="text-muted"> · {row.userName ?? 'someone'}</span>
                  <ul className="mt-0.5 ml-4 flex flex-col gap-0.5 text-hint text-muted">
                    {changes.map((c) => (
                      <li key={c.field}>
                        {fieldLabel(c.field)}: <span className="num">{c.before ?? '—'}</span> →{' '}
                        <span className="num text-ink">{c.after ?? '—'}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- pay heads (masters) ----------

/** Percent-of-basic values are stored as percent × 100 (4000 = 40%). */
function percentLabel(value: number): string {
  return `${(value / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`
}

function PayHeadsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: heads } = useQuery({ queryKey: ['payHeads'], queryFn: api.payroll.heads.list })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'earning' | 'deduction'>('earning')
  const [calc, setCalc] = useState<'flat' | 'percent_of_basic'>('flat')
  const [flatPaise, setFlatPaise] = useState<number | null>(null)
  const [percentText, setPercentText] = useState('')
  const [active, setActive] = useState(true)
  const [saving, setSaving] = useState(false)

  const invalidate = (): Promise<void> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['payHeads'] }),
      queryClient.invalidateQueries({ queryKey: ['employeeHeads'] }),
      queryClient.invalidateQueries({ queryKey: ['payrollPreview'] })
    ]).then(() => undefined)

  const resetForm = (): void => {
    setEditingId(null)
    setName('')
    setKind('earning')
    setCalc('flat')
    setFlatPaise(null)
    setPercentText('')
    setActive(true)
  }

  const edit = (h: PayHead): void => {
    setEditingId(h.id)
    setName(h.name)
    setKind(h.kind)
    setCalc(h.calc)
    setFlatPaise(h.calc === 'flat' ? h.value : null)
    setPercentText(h.calc === 'percent_of_basic' ? String(h.value / 100) : '')
    setActive(h.active)
  }

  const percentInvalid =
    calc === 'percent_of_basic' &&
    (percentText.trim() === '' || !Number.isFinite(Number(percentText)) || Number(percentText) < 0 || Number(percentText) > 100)

  const save = async (): Promise<void> => {
    if (!name.trim()) return void toast.push('error', 'Name the pay head')
    let value: number
    if (calc === 'flat') {
      value = flatPaise ?? 0
    } else {
      if (percentInvalid) return void toast.push('error', 'Percent must be between 0 and 100')
      value = Math.round(Number(percentText) * 100)
    }
    setSaving(true)
    try {
      await api.payroll.heads.save({ name: name.trim(), kind, calc, value, active }, editingId ?? undefined)
      await invalidate()
      toast.push('success', editingId ? 'Pay head updated' : 'Pay head created')
      resetForm()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (h: PayHead): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete pay head',
      message: `Delete "${h.name}"? Employees assigned this head lose it.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.payroll.heads.remove(h.id)
      await invalidate()
      if (editingId === h.id) resetForm()
      toast.push('success', `${h.name} deleted`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Pay heads" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        {!heads?.length ? (
          <EmptyState title="No pay heads yet" hint="Add earnings (e.g. Conveyance) or deductions (e.g. Canteen) beyond the built-in salary structure" />
        ) : (
          <ScrollList maxH="38vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="w-24">Kind</th>
                  <th scope="col" className="w-36">Calculation</th>
                  <th scope="col" className="r w-32">Value</th>
                  <th scope="col" className="w-16">Active</th>
                  <th scope="col" className="w-28"></th>
                </tr>
              </thead>
              <tbody data-testid="rows-payroll-heads">
                {heads.map((h) => (
                  <tr key={h.id} data-row-id={h.id} className="hover:bg-panel2">
                    <td>{h.name}</td>
                    <td className="capitalize text-muted">{h.kind}</td>
                    <td className="text-muted">{h.calc === 'flat' ? 'Flat / month' : '% of basic'}</td>
                    <td className="num r">{h.calc === 'flat' ? <Money paise={h.value} /> : percentLabel(h.value)}</td>
                    <td className="text-muted">{h.active ? 'Yes' : 'No'}</td>
                    <td className="r">
                      <RowAction onClick={() => edit(h)}>
                        Edit
                      </RowAction>
                      <button className="text-small text-cr hover:underline" onClick={() => void remove(h)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollList>
        )}

        <div className="border-t border-line pt-4">
          <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">{editingId ? 'Edit pay head' : 'Add pay head'}</p>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Conveyance" />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as 'earning' | 'deduction')}>
                <option value="earning">Earning</option>
                <option value="deduction">Deduction</option>
              </Select>
            </Field>
            <Field label="Calculation">
              <Select value={calc} onChange={(e) => setCalc(e.target.value as 'flat' | 'percent_of_basic')}>
                <option value="flat">Flat / month</option>
                <option value="percent_of_basic">% of basic</option>
              </Select>
            </Field>
            {calc === 'flat' ? (
              <Field label="Amount / month">
                <AmountInput paise={flatPaise} onPaise={setFlatPaise} testId="input-payroll-head-value" />
              </Field>
            ) : (
              <Field label="Percent of basic" error={percentInvalid && percentText.trim() !== '' ? '0 – 100' : null}>
                <TextInput
                  value={percentText}
                  onChange={(e) => setPercentText(e.target.value)}
                  className="num text-right"
                  placeholder="e.g. 10"
                  data-testid="input-payroll-head-value"
                />
              </Field>
            )}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <label className="flex items-center gap-2 text-detail text-ink">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              Active
            </label>
            <span className="flex gap-2">
              {editingId && <Button onClick={resetForm}>Cancel edit</Button>}
              <Button variant="primary" disabled={saving} data-testid="btn-payroll-save-head" onClick={() => void save()}>
                {editingId ? 'Save changes' : 'Add pay head'}
              </Button>
            </span>
          </div>
          <p className="mt-2 text-hint text-muted">
            Basic, HRA and Special Allowance are the built-in salary heads — their per-employee values live on the employee form and mirror here automatically.
          </p>
        </div>
      </div>
    </Modal>
  )
}

// ---------- per-employee head assignments ----------

interface HeadAssignment {
  assigned: boolean
  /** Flat: paise. Percent: percent × 100. null = use the head's default value. */
  overrideValue: number | null
}

function EmployeeHeadsModal({ employee, onClose }: { employee: Employee; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: heads } = useQuery({ queryKey: ['payHeads'], queryFn: api.payroll.heads.list })
  const { data: assignedRows } = useQuery({
    queryKey: ['employeeHeads', employee.id],
    queryFn: () => api.payroll.employeeHeads.get(employee.id)
  })
  const [edits, setEdits] = useState<Record<number, HeadAssignment>>({})
  const [saving, setSaving] = useState(false)

  const loaded = heads !== undefined && assignedRows !== undefined
  const assignedById = useMemo(
    () => new Map((assignedRows ?? []).map((r: EmployeeHeadRow) => [r.payHeadId, r])),
    [assignedRows]
  )

  const stateOf = (h: PayHead): HeadAssignment => {
    const edit = edits[h.id]
    if (edit) return edit
    const row = assignedById.get(h.id)
    return row ? { assigned: true, overrideValue: row.overrideValue } : { assigned: false, overrideValue: null }
  }

  const setState = (headId: number, next: HeadAssignment): void => setEdits((e) => ({ ...e, [headId]: next }))

  const save = async (): Promise<void> => {
    if (!heads) return
    setSaving(true)
    try {
      const list = heads
        .map((h) => ({ head: h, s: stateOf(h) }))
        .filter(({ s }) => s.assigned)
        .map(({ head, s }) => ({ payHeadId: head.id, overrideValue: s.overrideValue }))
      await api.payroll.employeeHeads.set({ employeeId: employee.id, heads: list })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['employeeHeads'] }),
        queryClient.invalidateQueries({ queryKey: ['employees'] }),
        queryClient.invalidateQueries({ queryKey: ['payrollPreview'] })
      ])
      toast.push('success', `${employee.name}'s pay heads saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const dirty = Object.keys(edits).length > 0

  return (
    <Modal title={`Pay heads — ${employee.name}`} onClose={onClose} wide dirty={dirty}>
      {!loaded ? (
        <div className="flex items-center gap-2 py-4 text-detail text-muted">
          <Spinner /> Loading…
        </div>
      ) : !heads.length ? (
        <EmptyState title="No pay heads defined" hint="Create pay heads first (Employees tab → Pay heads…)" />
      ) : (
        <div className="flex flex-col gap-4">
          <ScrollList maxH="48vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th scope="col" className="w-10"></th>
                  <th scope="col">Head</th>
                  <th scope="col" className="w-24">Kind</th>
                  <th scope="col" className="r w-32">Default</th>
                  <th scope="col" className="r w-44">Override for {employee.name.split(' ')[0]}</th>
                </tr>
              </thead>
              <tbody data-testid="rows-payroll-employee-heads">
                {heads.map((h) => {
                  const s = stateOf(h)
                  return (
                    <tr key={h.id} data-row-id={h.id} className={s.assigned ? '' : 'opacity-50'}>
                      <td>
                        <input
                          type="checkbox"
                          checked={s.assigned}
                          onChange={(e) => setState(h.id, { ...s, assigned: e.target.checked })}
                        />
                      </td>
                      <td>
                        {h.name}
                        {!h.active && <span className="ml-2 text-caption text-muted">paused</span>}
                      </td>
                      <td className="capitalize text-muted">{h.kind}</td>
                      <td className="num r">{h.calc === 'flat' ? <Money paise={h.value} /> : percentLabel(h.value)}</td>
                      <td className="r">
                        {s.assigned && (
                          <OverrideInput
                            calc={h.calc}
                            value={s.overrideValue}
                            onChange={(v) => setState(h.id, { ...s, overrideValue: v })}
                          />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </ScrollList>
          <p className="text-hint text-muted">
            Empty override = the head's default value. Basic, HRA and Special Allowance overrides write back to the salary fields on the employee form.
          </p>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={saving} data-testid="btn-payroll-save-overrides" onClick={() => void save()}>
              Save pay heads
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Override editor for one assignment: rupee amount for flat heads, percent for %-of-basic. */
function OverrideInput({
  calc,
  value,
  onChange
}: {
  calc: 'flat' | 'percent_of_basic'
  value: number | null
  onChange: (v: number | null) => void
}): React.JSX.Element {
  const [text, setText] = useState(
    value == null ? '' : calc === 'flat' ? formatPaise(value) : String(value / 100)
  )
  const commit = (raw: string): void => {
    const t = raw.trim()
    if (t === '') return void onChange(null)
    if (calc === 'flat') {
      const paise = parseRupees(t)
      if (paise != null && paise >= 0) onChange(paise)
    } else {
      const n = Number(t)
      if (Number.isFinite(n) && n >= 0 && n <= 100) onChange(Math.round(n * 100))
    }
  }
  return (
    <input
      className={`${inputCls} num w-36 text-right`}
      data-testid="input-payroll-override"
      value={text}
      placeholder="default"
      onChange={(e) => {
        setText(e.target.value)
        commit(e.target.value)
      }}
    />
  )
}

// ---------- pay runs ----------

function RunsTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: employees } = useQuery({ queryKey: ['employees'], queryFn: api.payroll.employees })
  const { data: runs, isLoading: runsLoading } = useQuery({ queryKey: ['payrollRuns'], queryFn: api.payroll.runs })
  const [month, setMonth] = useState(todayISO().slice(0, 7))
  const [daysOverride, setDaysOverride] = useState<Record<number, string>>({})
  const [posting, setPosting] = useState(false)

  // Last 12 months, current first — replaces the free-text YYYY-MM field.
  const monthOptions = useMemo(() => {
    const [y, m] = todayISO().slice(0, 7).split('-').map(Number)
    return Array.from({ length: 12 }, (_, i) => {
      const total = (y ?? 2026) * 12 + ((m ?? 1) - 1) - i
      return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
    })
  }, [])

  const active = (employees ?? []).filter((e) => e.active)
  const monthDays = daysInMonth(month)
  const alreadyRun = (runs ?? []).some((r) => r.month === month)

  // Per-employee payable days: validated inline, clamped copy goes to the server preview.
  const dayError = (raw: string | undefined): string | null => {
    if (raw === undefined || raw === '') return null
    const n = Number(raw)
    if (!Number.isFinite(n)) return 'Not a number'
    if (n < 0) return 'Min 0'
    if (n > monthDays) return `Max ${monthDays}`
    return null
  }
  const anyDayInvalid = active.some((e) => dayError(daysOverride[e.id]) !== null)

  const daysPayload = useMemo(
    () =>
      active.map((e) => {
        const raw = daysOverride[e.id]
        const n = raw !== undefined && raw !== '' ? Number(raw) : monthDays
        const safe = Number.isFinite(n) ? Math.min(monthDays, Math.max(0, n)) : monthDays
        return { employeeId: e.id, payableDays: safe }
      }),
    [active, daysOverride, monthDays]
  )

  // Server-side preview — the single payroll engine in src/main computes what a commit would post
  // (pay heads, ESI eligibility, PT slabs included), so preview and posted figures can't drift.
  const { data: previewLines, isFetching: previewFetching } = useQuery({
    queryKey: ['payrollPreview', month, daysPayload],
    queryFn: () => api.payroll.preview(month, daysPayload),
    enabled: active.length > 0,
    placeholderData: (prev) => prev
  })
  const linesByEmployee = new Map((previewLines ?? []).map((l) => [l.employeeId, l]))

  const totals = (previewLines ?? []).reduce(
    (acc, l) => ({
      gross: acc.gross + l.gross,
      deductions: acc.deductions + l.pfEmp + l.esiEmp + l.pt + l.otherDeductions,
      net: acc.net + l.net,
      cost: acc.cost + l.gross + l.pfEr + l.pfAdmin + l.edli + l.esiEr
    }),
    { gross: 0, deductions: 0, net: 0, cost: 0 }
  )

  const post = async (): Promise<void> => {
    if (posting || anyDayInvalid) return
    setPosting(true)
    try {
      const run = await api.payroll.commit(month, daysPayload)
      toast.push('success', `Payroll for ${monthLabel(run.month)} posted — ${run.lines.length} employee${run.lines.length === 1 ? '' : 's'}`)
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setPosting(false)
    }
  }

  return (
    <>
      <Panel className="mb-4 p-4">
        <div className="mb-3 flex items-end justify-between">
          <Field label="Month">
            <Select value={month} onChange={(e) => setMonth(e.target.value)} className="w-36" data-testid="payroll-month">
              {monthOptions.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
          <span className="flex items-center gap-2">
            {previewFetching && <Spinner />}
            <Button
              variant="primary"
              data-testid="btn-payroll-post-run"
              disabled={alreadyRun || active.length === 0 || posting || anyDayInvalid}
              disabledTitle={anyDayInvalid ? 'Fix the days column first' : undefined}
              onClick={() => void post()}
            >
              {alreadyRun ? `Posted for ${monthLabel(month)}` : 'Post payroll'}
            </Button>
          </span>
        </div>
        {active.length === 0 ? (
          <EmptyState title="No active employees" />
        ) : (
          <ScrollList maxH="46vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th scope="col">Employee</th>
                  <th scope="col" className="r w-24">Days</th>
                  <th scope="col" className="r w-32">Gross</th>
                  <th scope="col" className="r w-24">PF</th>
                  <th scope="col" className="r w-24">ESI</th>
                  <th scope="col" className="r w-20">PT</th>
                  <th scope="col" className="r w-32">Net pay</th>
                </tr>
              </thead>
              <tbody data-testid="rows-payroll-preview">
                {active.map((e) => {
                  const line = linesByEmployee.get(e.id)
                  const err = dayError(daysOverride[e.id])
                  return (
                    <tr key={e.id} data-row-id={e.id}>
                      <td>{e.name}</td>
                      <td className="r">
                        <input
                          type="number"
                          min={0}
                          max={monthDays}
                          step={0.5}
                          data-testid="input-payroll-days"
                          aria-invalid={err ? true : undefined}
                          className={`num w-16 rounded-md border px-1.5 py-0.5 text-right text-body-sm bg-panel2 ${err ? 'border-cr/70' : 'border-line'}`}
                          value={daysOverride[e.id] ?? String(monthDays)}
                          onChange={(ev) => setDaysOverride((d) => ({ ...d, [e.id]: ev.target.value }))}
                        />
                        {err && <span className="block text-hint text-cr">{err}</span>}
                      </td>
                      <td className="r">{line ? <Money paise={line.gross} /> : '—'}</td>
                      <td className="r">{line ? <Money paise={line.pfEmp} /> : '—'}</td>
                      <td className="r">{line ? <Money paise={line.esiEmp} /> : '—'}</td>
                      <td className="r">{line ? <Money paise={line.pt} /> : '—'}</td>
                      <td className="r font-medium">{line ? <Money paise={line.net} /> : '—'}</td>
                    </tr>
                  )
                })}
                <tr className="total-row">
                  <td>Total · employer cost <Money paise={totals.cost} /></td>
                  <td></td>
                  <td className="r"><Money paise={totals.gross} /></td>
                  <td className="r" colSpan={3}><Money paise={totals.deductions} /></td>
                  <td className="r"><Money paise={totals.net} /></td>
                </tr>
              </tbody>
            </table>
          </ScrollList>
        )}
      </Panel>

      <Panel scroll={{ maxH: '52vh' }}>
        <p className="border-b border-line px-4 py-2.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase">
          Posted runs
        </p>
        {runsLoading ? (
          <SkeletonRows rows={3} />
        ) : !runs?.length ? (
          <EmptyState title="Nothing posted yet" />
        ) : (
          runs.map((run) => <RunRow key={run.id} run={run} />)
        )}
      </Panel>
    </>
  )
}

function RunRow({ run }: { run: PayrollRun }): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [payslipsOpen, setPayslipsOpen] = useState(false)
  const [sendingPayslips, setSendingPayslips] = useState(false)
  const [ptOpen, setPtOpen] = useState(false)
  const payslipsRef = useRef<HTMLSpanElement>(null)

  // Overflow menu closes on outside click / Escape.
  useEffect(() => {
    if (!payslipsOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (!payslipsRef.current?.contains(e.target as Node)) setPayslipsOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPayslipsOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [payslipsOpen])

  /**
   * Write a statutory file, after checking the portal would take it.
   *
   * The ECR is checked first because EPFO rejects the whole upload over one bad line and answers
   * with a line number rather than a name. Anyone the file cannot carry is named here too: a
   * member silently left out only finds out when their passbook does not update.
   */
  const exportFile = async (kind: 'ecr' | 'esi'): Promise<void> => {
    try {
      if (kind === 'ecr') {
        const check = await api.payroll.ecrCheck(run.id)
        const errors = check.problems.filter((p) => p.severity === 'error')
        if (errors.length > 0) {
          toast.push('error', `EPFO would reject this: ${errors[0]!.employee} — ${errors[0]!.message}`)
          return
        }
        for (const w of check.problems.filter((p) => p.severity === 'warning')) {
          toast.push('warning', `${w.employee}: ${w.message}`)
        }
        for (const s of check.skipped) toast.push('warning', `${s.name} is not in the file — ${s.reason}`)
      }
      const r = kind === 'ecr' ? await api.payroll.ecr(run.id) : await api.payroll.esiCsv(run.id)
      toast.push('success', `${kind === 'ecr' ? 'PF ECR' : 'ESI CSV'}: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  /**
   * The bulk transfer file for this run.
   *
   * Anyone left out is named in the toast rather than reported only in the file. A transfer file
   * that silently omits someone is how a person does not get paid, and the business finds out
   * from them rather than from the file.
   */
  const transferFile = async (): Promise<void> => {
    try {
      const r = await api.payroll.transferFile(run.id)
      if (r.skipped.length > 0) {
        toast.push(
          'warning',
          `${r.count} of ${r.count + r.skipped.length} in the file — ` +
            r.skipped.map((s) => `${s.employeeName} (${s.reason})`).join(', ')
        )
      } else {
        toast.push('success', `${r.count} transfers: ${r.path}`)
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete pay run',
      message: `Delete the ${monthLabel(run.month)} pay run and its voucher?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.payroll.removeRun(run.id)
      await queryClient.invalidateQueries()
      toast.push('success', `${monthLabel(run.month)} pay run deleted`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="border-b border-line/50 px-4 py-2.5 last:border-b-0" data-row-id={run.id}>
      <div className="flex items-center justify-between">
        <span className="font-medium">{monthLabel(run.month)}</span>
        <span className="flex items-center gap-3 text-small">
          <Money paise={run.lines.reduce((s, l) => s + l.net, 0)} />
          {run.voucherId && (
            <button
              className="text-blue hover:underline"
              data-testid="btn-payroll-voucher"
              onClick={() => nav.go({ name: 'voucher-entry', voucherId: run.voucherId! })}
            >
              Voucher
            </button>
          )}
          <span className="relative" ref={payslipsRef}>
            <button
              className="text-blue hover:underline"
              data-testid="btn-payroll-payslips"
              onClick={() => setPayslipsOpen((o) => !o)}
            >
              Payslips ▾
            </button>
            {payslipsOpen && (
              <span className="absolute right-0 top-6 z-20 block w-56 rounded-md border border-line bg-panel py-1 panel-shadow">
                <ScrollList maxH="40vh">
                  {run.lines.map((l) => (
                    <button
                      key={l.id}
                      className="block w-full truncate px-3 py-1.5 text-left text-body-sm text-ink hover:bg-panel2"
                      title="Open payslip PDF"
                      onClick={() => {
                        setPayslipsOpen(false)
                        api.payroll.payslip(run.id, l.employeeId).catch((err: Error) => toast.push('error', err.message))
                      }}
                    >
                      {l.employeeName}
                    </button>
                  ))}
                </ScrollList>
                <span className="mt-1 block border-t border-line pt-1">
                  <button
                    className="block w-full px-3 py-1.5 text-left text-body-sm font-medium text-ink hover:bg-panel2"
                    data-testid="btn-payroll-payslips-all"
                    title="Write every payslip and get a way to send each one"
                    onClick={() => {
                      setPayslipsOpen(false)
                      setSendingPayslips(true)
                    }}
                  >
                    All {run.lines.length}, with sending…
                  </button>
                </span>
              </span>
            )}
          </span>
          <button
            className="text-muted hover:text-ink"
            data-testid="btn-payroll-transfer"
            onClick={() => void transferFile()}
            title="Bulk salary transfer CSV for your bank"
          >
            Transfer file
          </button>
          <button className="text-muted hover:text-ink" data-testid="btn-payroll-ecr" onClick={() => void exportFile('ecr')} title="EPFO ECR upload file">
            PF ECR
          </button>
          <button className="text-muted hover:text-ink" data-testid="btn-payroll-esi" onClick={() => void exportFile('esi')} title="ESIC upload CSV">
            ESI CSV
          </button>
          <button className="text-muted hover:text-ink" data-testid="btn-payroll-pt" onClick={() => setPtOpen(true)} title="Professional tax summary by state">
            PT
          </button>
          <button className="text-cr hover:underline" data-testid="btn-payroll-delete-run" onClick={() => void remove()}>
            Delete
          </button>
        </span>
      </div>
      {ptOpen && <PtSummaryModal run={run} onClose={() => setPtOpen(false)} />}
      {sendingPayslips && (
        <PayslipsModal
          runId={run.id}
          monthLabel={monthLabel(run.month)}
          count={run.lines.length}
          onClose={() => setSendingPayslips(false)}
        />
      )}
    </div>
  )
}

function PtSummaryModal({ run, onClose }: { run: PayrollRun; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const { data: rows, isLoading } = useQuery({
    queryKey: ['ptSummary', run.id],
    queryFn: () => api.payroll.ptSummary(run.id)
  })

  const exportCsv = async (): Promise<void> => {
    try {
      const r = await api.payroll.ptCsv(run.id)
      toast.push('success', `PT return CSV: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={`Professional tax — ${monthLabel(run.month)}`} onClose={onClose}>
      {isLoading || !rows ? (
        <div className="flex items-center gap-2 py-4 text-detail text-muted">
          <Spinner /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No professional tax this run" />
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col" className="r w-28">Employees</th>
              <th scope="col" className="r w-32">Gross</th>
              <th scope="col" className="r w-32">PT payable</th>
            </tr>
          </thead>
          <tbody data-testid="rows-payroll-pt">
            {rows.map((r) => (
              <tr key={r.state}>
                <td>{r.state}</td>
                <td className="num r">{r.employees}</td>
                <td className="r"><Money paise={r.gross} /></td>
                <td className="r font-medium"><Money paise={r.pt} /></td>
              </tr>
            ))}
            <tr className="total-row">
              <td>Total</td>
              <td className="num r">{rows.reduce((s, r) => s + r.employees, 0)}</td>
              <td className="r"><Money paise={rows.reduce((s, r) => s + r.gross, 0)} /></td>
              <td className="r"><Money paise={rows.reduce((s, r) => s + r.pt, 0)} /></td>
            </tr>
          </tbody>
        </table>
      )}
      {rows && rows.length > 0 && (
        <div className="mt-4 flex justify-end border-t border-line pt-3">
          <Button data-testid="btn-payroll-pt-csv" onClick={() => void exportCsv()} title="State-wise PT return CSV (exports folder)">
            Export PT return CSV
          </Button>
        </div>
      )}
    </Modal>
  )
}

// ---------- cost over time ----------

/**
 * What payroll cost, month by month, and how many people it covered.
 *
 * Payroll is usually the largest single expense a small business has and the one it looks at
 * least: the run is committed, the payslips go out, and nobody asks what it did over the year.
 *
 * Employer cost, not gross, is the headline. Gross understates what actually left the business by
 * roughly a seventh once the employer's own PF and ESI are counted, and that gap is precisely
 * what someone budgeting a hire needs to see. Cost per head sits beside it because a rise on more
 * people is a different fact from the same rise on the same people.
 */
function TrendTab(): React.JSX.Element {
  const toast = useToasts()
  const { data, isLoading } = useQuery({ queryKey: ['payrollTrend'], queryFn: () => api.payroll.trend() })
  const rows = data ?? []

  const columns: PdfColumn[] = [
    { label: 'Month', align: 'l' },
    { label: 'People', align: 'r' },
    { label: 'Gross', align: 'r' },
    { label: 'Employer PF/ESI', align: 'r' },
    { label: 'Total cost', align: 'r' },
    { label: 'Per head', align: 'r' },
    { label: 'Net paid', align: 'r' }
  ]
  const exportRows: PdfRow[] = rows.map((r) => ({
    cells: [
      r.label,
      String(r.headcount),
      formatPaise(r.gross),
      formatPaise(r.employerContributions),
      formatPaise(r.employerCost),
      formatPaise(r.costPerHead),
      formatPaise(r.net)
    ]
  }))

  if (isLoading) return <SkeletonRows rows={6} />
  if (rows.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="No pay runs yet"
          hint="Commit a pay run and its cost will show here, month by month."
        />
      </Panel>
    )
  }

  const latest = rows[rows.length - 1]!
  const previous = rows.length > 1 ? rows[rows.length - 2] : null

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-body-sm">
          <b>{latest.label}</b>: <Money paise={latest.employerCost} /> for {latest.headcount}{' '}
          {latest.headcount === 1 ? 'person' : 'people'}
        </span>
        {previous && previous.employerCost > 0 && (
          <span
            className={`text-hint ${latest.employerCost > previous.employerCost ? 'text-cr' : 'text-dr'}`}
            data-testid="payroll-trend-change"
          >
            {latest.employerCost >= previous.employerCost ? '+' : ''}
            {Math.round(((latest.employerCost - previous.employerCost) / previous.employerCost) * 100)}% on{' '}
            {previous.label}
            {latest.headcount !== previous.headcount &&
              ` · ${latest.headcount > previous.headcount ? '+' : ''}${latest.headcount - previous.headcount} ${
                Math.abs(latest.headcount - previous.headcount) === 1 ? 'person' : 'people'
              }`}
          </span>
        )}
        <span className="flex-1" />
        <ExportGroup
          items={[
            {
              label: 'PDF',
              onClick: () => void printReport(
                {
                  title: 'Payroll cost over time',
                  periodLabel: `${rows[0]!.label} to ${latest.label}`,
                  columns,
                  rows: exportRows,
                  filename: 'payroll-trend'
                },
                toast
              )
            },
            {
              label: 'CSV',
              onClick: () => void csvReport(columns.map((c) => c.label), exportRows.map((r) => r.cells), 'payroll-trend', toast)
            }
          ]}
        />
      </div>

      <Panel>
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col" className="r w-24">People</th>
              <th scope="col" className="r w-36">Gross</th>
              <th scope="col" className="r w-36">Employer PF/ESI</th>
              <th scope="col" className="r w-36">Total cost</th>
              <th scope="col" className="r w-32">Per head</th>
              <th scope="col" className="r w-36">Net paid</th>
            </tr>
          </thead>
          <tbody data-testid="rows-payroll-trend">
            {rows.map((r) => (
              <tr key={r.month}>
                <td>{r.label}</td>
                <td className="r num">{r.headcount}</td>
                <td className="r"><Money paise={r.gross} /></td>
                <td className="r text-muted"><Money paise={r.employerContributions} /></td>
                <td className="r font-semibold"><Money paise={r.employerCost} /></td>
                <td className="r text-muted"><Money paise={r.costPerHead} /></td>
                <td className="r"><Money paise={r.net} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Total cost is gross plus the employer&rsquo;s own PF and ESI — what actually left the
        business, which gross alone understates by roughly a seventh.
      </p>
    </>
  )
}


/**
 * The rates the run will actually use, rather than the rates that happen to apply today.
 *
 * Stated per month because they change on dates: a June 2019 run and a July 2019 run are computed
 * on different ESI rates, and a footnote that says otherwise is a footnote that will be quoted
 * back during an inspection.
 */
function StatutoryFootnote({ month }: { month: string }): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['payrollRates', month], queryFn: () => api.payroll.rates(month) })
  const r = data?.rates
  if (!r) return <p className="mt-3 text-hint text-muted">Loading the rates in force…</p>
  const pct = (n: number): string => `${n}%`
  return (
    <p className="mt-3 text-hint text-muted" data-testid="statutory-footnote">
      Rates in force for {monthLabel(month)} (effective {toDisplayDate(r.effectiveFrom)}): EPF{' '}
      {pct(r.pfRate)} + {pct(r.pfRate)} on basic, ceiling {formatPaise(r.pfWageCeiling, { symbol: true })} · EPS{' '}
      {pct(r.epsRate)} · admin {pct(r.pfAdminRate)} + EDLI {pct(r.edliRate)} · ESI {pct(r.esiEmpRate)} /{' '}
      {pct(r.esiErRate)} when gross ≤ {formatPaise(r.esiGrossLimit, { symbol: true })} · professional tax by state
      slab. Posting books one Journal voucher; a run is always computed on its own month&rsquo;s rates,
      so re-opening an old one cannot change what was filed.
    </p>
  )
}
