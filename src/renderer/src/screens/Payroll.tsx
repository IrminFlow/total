import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Employee, PayrollRun } from '@shared/domain'
import { daysInMonth } from '@shared/payroll'
import { todayISO } from '@shared/dates'
import { api, type EmployeeHeadRow, type PayHead, type PtSummaryRow } from '../lib/client'
import { formatPaise, parseRupees } from '@shared/money'
import { useNav, useToasts } from '../state/stores'
import {
  AmountInput, Button, DrawerSection, EmptyState, Field, Modal, Money, Page, PageHeader, Panel, ScrollList, Select, SkeletonRows, Spinner, TextInput, inputCls
} from '../components/ui'
import { OptionToggle, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { confirmDialog } from '../lib/dialogs'
import { TabBar } from '../components/TabBar'
import { DataTable, defineColumns, Popover } from '../components/table'

type Tab = 'employees' | 'runs'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-08' → 'Aug 2026'. */
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`
}

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' }
]

/** Monthly salary totals count active employees only — an inactive one isn't on the payroll. */
const activeSum =
  (pick: (e: Employee) => number) =>
  (rows: Employee[]): number =>
    rows.filter((e) => e.active).reduce((s, e) => s + pick(e), 0)
const grossOf = (e: Employee): number => e.basic + e.hra + e.special

export const EMPLOYEE_COLUMNS = defineColumns<Employee>([
  {
    id: 'name',
    header: 'Name',
    kind: 'text',
    value: (e) => e.name,
    hideable: false,
    groupable: false,
    minWidth: 160,
    cell: (e) => (
      <>
        {e.name}
        {!e.active && <span className="ml-2 text-caption text-muted">inactive</span>}
      </>
    )
  },
  { id: 'code', header: 'Code', kind: 'text', value: (e) => e.code, defaultHidden: true, groupable: false, width: 100, className: 'num text-muted' },
  { id: 'designation', header: 'Designation', kind: 'text', value: (e) => e.designation, className: 'text-muted' },
  { id: 'basic', header: 'Basic', kind: 'money', value: (e) => e.basic, aggregate: activeSum((e) => e.basic), width: 124 },
  { id: 'hra', header: 'HRA', kind: 'money', value: (e) => e.hra, aggregate: activeSum((e) => e.hra), width: 124 },
  { id: 'special', header: 'Special', kind: 'money', value: (e) => e.special, aggregate: activeSum((e) => e.special), width: 124 },
  { id: 'gross', header: 'Gross / mo', kind: 'money', value: grossOf, aggregate: activeSum(grossOf), width: 140, className: 'font-medium' },
  { id: 'status', header: 'Status', kind: 'enum', value: (e) => (e.active ? 'active' : 'inactive'), options: STATUS_OPTIONS, defaultHidden: true, width: 112 }
])

const runNet = (run: PayrollRun): number => run.lines.reduce((s, l) => s + l.net, 0)
const runGross = (run: PayrollRun): number => run.lines.reduce((s, l) => s + l.gross, 0)

// Gross and net are per-month payouts, so their totals (the year's payroll so far) are meaningful.
export const RUN_COLUMNS = defineColumns<PayrollRun>([
  // 'YYYY-MM' sorts chronologically; shown as "Aug 2026".
  { id: 'month', header: 'Month', kind: 'text', value: (r) => r.month, text: (r) => monthLabel(r.month), hideable: false, groupable: false, minWidth: 110, className: 'font-medium' },
  { id: 'employees', header: 'Employees', kind: 'number', value: (r) => r.lines.length, width: 132 },
  { id: 'gross', header: 'Gross', kind: 'money', value: runGross, aggregate: 'sum', width: 140, defaultHidden: true },
  { id: 'net', header: 'Net pay', kind: 'money', value: runNet, aggregate: 'sum', width: 140 }
])

const STATUTORY_NOTE =
  'Statutory defaults: EPF 12% + 12% on basic (₹15,000 ceiling) · ESI 0.75% / 3.25% when gross ≤ ₹21,000 · simplified professional-tax slab. Posting books one Journal voucher: salaries and employer contributions against PF/ESI/PT/Salaries payable.'

/** The Options drawer's note on how payroll is computed (moved off the page). */
function StatutorySection(): React.JSX.Element {
  return (
    <DrawerSection title="How payroll is computed">
      <p className="text-hint text-muted">{STATUTORY_NOTE}</p>
    </DrawerSection>
  )
}

export function PayrollScreen(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('employees')
  const tabs = (
    <TabBar
      screen="payroll"
      tabs={[
        { id: 'employees', label: 'Employees' },
        { id: 'runs', label: 'Pay runs' }
      ]}
      active={tab}
      onSelect={setTab}
    />
  )
  return <Page>{tab === 'employees' ? <EmployeesTab tabs={tabs} /> : <RunsTab tabs={tabs} />}</Page>
}

// ---------- employees ----------

function EmployeesTab({ tabs }: { tabs: React.ReactNode }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: employees, isLoading: employeesLoading } = useQuery({ queryKey: ['employees'], queryFn: api.payroll.employees })
  const [editing, setEditing] = useState<Employee | 'new' | null>(null)
  const [headsOpen, setHeadsOpen] = useState(false)
  const [overridesFor, setOverridesFor] = useState<Employee | null>(null)
  const opts = useScreenOptions('payroll', { hideInactive: false })

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
      <PageHeader
        title="Payroll"
        tabs={tabs}
        secondary={
          <Button data-testid="btn-payroll-pay-heads" onClick={() => setHeadsOpen(true)}>
            Pay heads…
          </Button>
        }
        actions={
          <Button variant="primary" data-testid="btn-payroll-add-employee" onClick={() => setEditing('new')}>
            Add employee
          </Button>
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <DrawerSection title="Display">
                <OptionToggle label="Hide inactive employees" checked={opts.options.hideInactive} onChange={(v) => opts.set('hideInactive', v)} testId="input-payroll-hide-inactive" />
              </DrawerSection>
              <OptionsTable area="payroll-employees" />
              <StatutorySection />
            </>
          )
        }}
      />
      <Panel>
        <DataTable
          viewId="payroll-employees"
          testId="payroll-employees"
          ariaLabel="Employees"
          columns={EMPLOYEE_COLUMNS}
          rows={(employees ?? []).filter((e) => !opts.options.hideInactive || e.active)}
          rowKey={(e) => e.id}
          rowAttrs={(e) => ({ 'data-row-id': e.id })}
          rowClassName={(e) => (e.active ? '' : 'text-muted')}
          loading={employeesLoading}
          empty={{ title: 'No employees yet', hint: 'Add employees with their monthly salary structure, then post a pay run' }}
          maxHeight="58vh"
          totalsLabel="Total (active)"
          trailingWidth={176}
          trailing={(e) => (
            <>
              <button
                type="button"
                className="mr-3 text-small text-muted hover:text-ink"
                data-testid="btn-payroll-overrides"
                aria-label={`Pay heads for ${e.name}`}
                onClick={() => setOverridesFor(e)}
              >
                Heads
              </button>
              <button
                type="button"
                className="mr-3 text-small text-blue hover:underline"
                data-testid="btn-payroll-edit-employee"
                aria-label={`Edit ${e.name}`}
                onClick={() => setEditing(e)}
              >
                Edit
              </button>
              <button
                type="button"
                className="text-small text-danger hover:underline"
                data-testid="btn-payroll-delete-employee"
                aria-label={`Delete ${e.name}`}
                onClick={() => void remove(e)}
              >
                Delete
              </button>
            </>
          )}
          exportOptions={{ title: 'Employees', periodLabel: 'Monthly salary structure', filename: 'employees' }}
        />
      </Panel>
      {editing && <EmployeeModal employee={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {headsOpen && <PayHeadsModal onClose={() => setHeadsOpen(false)} />}
      {overridesFor && <EmployeeHeadsModal employee={overridesFor} onClose={() => setOverridesFor(null)} />}
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
  const [basic, setBasic] = useState<number | null>(employee?.basic ?? null)
  const [hra, setHra] = useState<number | null>(employee?.hra ?? null)
  const [special, setSpecial] = useState<number | null>(employee?.special ?? null)
  const [pfEnabled, setPf] = useState(employee?.pfEnabled ?? true)
  const [esiEnabled, setEsi] = useState(employee?.esiEnabled ?? true)
  const [ptEnabled, setPt] = useState(employee?.ptEnabled ?? true)
  const [active, setActive] = useState(employee?.active ?? true)

  const save = async (): Promise<void> => {
    try {
      await api.payroll.saveEmployee(
        {
          name: name.trim(),
          code: code.trim() || null,
          designation: designation.trim() || null,
          joined: employee?.joined ?? null,
          pan: pan.trim() || null,
          uan: uan.trim() || null,
          esicNo: employee?.esicNo ?? null,
          basic: basic ?? 0,
          hra: hra ?? 0,
          special: special ?? 0,
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

// ---------- pay heads (masters) ----------

/** Percent-of-basic values are stored as percent × 100 (4000 = 40%). */
function percentLabel(value: number): string {
  return `${(value / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`
}

const HEAD_KIND_OPTIONS = [
  { value: 'earning', label: 'Earning' },
  { value: 'deduction', label: 'Deduction' }
]
const HEAD_CALC_OPTIONS = [
  { value: 'flat', label: 'Flat / month' },
  { value: 'percent_of_basic', label: '% of basic' }
]
/** A head's value: rupees for flat heads, a percent for %-of-basic ones (mixed units, so the
 *  column sorts by the raw figure but has no range filter). */
const headValueText = (h: PayHead): string => (h.calc === 'flat' ? formatPaise(h.value) : percentLabel(h.value))
const headValueCell = (h: PayHead): React.JSX.Element =>
  h.calc === 'flat' ? <Money paise={h.value} /> : <span className="num">{percentLabel(h.value)}</span>

const PAY_HEAD_COLUMNS = defineColumns<PayHead>([
  { id: 'name', header: 'Name', kind: 'text', value: (h) => h.name, hideable: false, groupable: false, minWidth: 160 },
  { id: 'kind', header: 'Kind', kind: 'enum', value: (h) => h.kind, options: HEAD_KIND_OPTIONS, className: 'text-muted', width: 100 },
  { id: 'calc', header: 'Calculation', kind: 'enum', value: (h) => h.calc, options: HEAD_CALC_OPTIONS, className: 'text-muted', width: 128 },
  { id: 'value', header: 'Value', kind: 'number', value: (h) => h.value, text: headValueText, cell: headValueCell, filterable: false, width: 112 },
  {
    id: 'active',
    header: 'Active',
    kind: 'enum',
    value: (h) => (h.active ? 'yes' : 'no'),
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' }
    ],
    className: 'text-muted',
    width: 84
  }
])

/** Tables inside dialogs: quick filter, columns and count — no saved views, grouping, density
 *  or export in a modal. */
const MODAL_TABLE_FEATURES = { groupBy: false, density: false, views: false, export: false } as const

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
        <div className="overflow-hidden rounded-md border border-line">
          <DataTable
            testId="payroll-heads"
            ariaLabel="Pay heads"
            columns={PAY_HEAD_COLUMNS}
            rows={heads ?? []}
            rowKey={(h) => h.id}
            rowAttrs={(h) => ({ 'data-row-id': h.id })}
            loading={heads === undefined}
            empty={{ title: 'No pay heads yet', hint: 'Add earnings (e.g. Conveyance) or deductions (e.g. Canteen) beyond the built-in salary structure' }}
            onRowActivate={edit}
            toolbarFeatures={MODAL_TABLE_FEATURES}
            maxHeight="38vh"
            trailingWidth={110}
            trailing={(h) => (
              <>
                <button className="mr-3 text-small text-blue hover:underline" onClick={() => edit(h)}>
                  Edit
                </button>
                <button className="text-small text-cr hover:underline" onClick={() => void remove(h)}>
                  Delete
                </button>
              </>
            )}
          />
        </div>

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

  // The cells read the latest assignment state through a ref, so the column set (and the
  // table's memoised model) stays stable while the user ticks heads and types overrides.
  const stateRef = useRef({ stateOf, setState })
  stateRef.current = { stateOf, setState }
  const firstName = employee.name.split(' ')[0] ?? employee.name
  const columns = useMemo(
    () =>
      defineColumns<PayHead>([
        {
          id: 'head',
          header: 'Head',
          kind: 'text',
          value: (h) => h.name,
          hideable: false,
          groupable: false,
          minWidth: 160,
          cell: (h) => (
            <>
              {h.name}
              {!h.active && <span className="ml-2 text-caption text-muted">paused</span>}
            </>
          )
        },
        { id: 'kind', header: 'Kind', kind: 'enum', value: (h) => h.kind, options: HEAD_KIND_OPTIONS, className: 'text-muted', width: 116 },
        { id: 'default', header: 'Default', kind: 'number', value: (h) => h.value, text: headValueText, cell: headValueCell, filterable: false, width: 128 },
        {
          id: 'override',
          header: `Override for ${firstName}`,
          kind: 'number',
          value: (h) => stateRef.current.stateOf(h).overrideValue,
          text: (h) => {
            const v = stateRef.current.stateOf(h).overrideValue
            return v == null ? '' : h.calc === 'flat' ? formatPaise(v) : percentLabel(v)
          },
          sortable: false,
          filterable: false,
          groupable: false,
          hideable: false,
          width: 200,
          cell: (h) => {
            const s = stateRef.current.stateOf(h)
            return s.assigned ? (
              <OverrideInput calc={h.calc} value={s.overrideValue} onChange={(v) => stateRef.current.setState(h.id, { ...s, overrideValue: v })} />
            ) : null
          }
        }
      ]),
    [firstName]
  )

  return (
    <Modal title={`Pay heads — ${employee.name}`} onClose={onClose} wide dirty={dirty}>
      {!loaded ? (
        <SkeletonRows rows={4} />
      ) : !heads.length ? (
        <EmptyState title="No pay heads defined" hint="Create pay heads first (Employees tab → Pay heads…)" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-md border border-line">
            <DataTable
              testId="payroll-employee-heads"
              ariaLabel={`Pay heads assigned to ${employee.name}`}
              columns={columns}
              rows={heads}
              rowKey={(h) => h.id}
              rowAttrs={(h) => ({ 'data-row-id': h.id })}
              rowClassName={(h) => (stateOf(h).assigned ? '' : 'text-muted')}
              toolbarFeatures={MODAL_TABLE_FEATURES}
              maxHeight="48vh"
              leadingWidth={40}
              leading={(h) => {
                const st = stateOf(h)
                return (
                  <input
                    type="checkbox"
                    aria-label={`Assign ${h.name}`}
                    checked={st.assigned}
                    onChange={(e) => setState(h.id, { ...st, assigned: e.target.checked })}
                  />
                )
              }}
            />
          </div>
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
      className={`${inputCls} num !h-[22px] !w-36 !py-0 !text-detail text-right`}
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

function RunsTab({ tabs }: { tabs: React.ReactNode }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: employees } = useQuery({ queryKey: ['employees'], queryFn: api.payroll.employees })
  const { data: runs, isLoading: runsLoading } = useQuery({ queryKey: ['payrollRuns'], queryFn: api.payroll.runs })
  const [month, setMonth] = useState(todayISO().slice(0, 7))
  const [daysOverride, setDaysOverride] = useState<Record<number, string>>({})
  const [posting, setPosting] = useState(false)
  const [ptRun, setPtRun] = useState<PayrollRun | null>(null)

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
      <PageHeader
        title="Payroll"
        tabs={tabs}
        options={{
          content: (
            <>
              <OptionsTable area="payroll-runs" label="Posted runs table" />
              <StatutorySection />
            </>
          )
        }}
      />
      <Panel className="mb-section p-panel">
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
                  <th>Employee</th>
                  <th className="r w-24">Days</th>
                  <th className="r w-32">Gross</th>
                  <th className="r w-24">PF</th>
                  <th className="r w-24">ESI</th>
                  <th className="r w-20">PT</th>
                  <th className="r w-32">Net pay</th>
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
                          aria-label={`Days worked by ${e.name}`}
                          className={`num w-16 rounded border px-1.5 py-0.5 text-right text-body-sm bg-panel2 ${err ? 'border-danger/70' : 'border-line'}`}
                          value={daysOverride[e.id] ?? String(monthDays)}
                          onChange={(ev) => setDaysOverride((d) => ({ ...d, [e.id]: ev.target.value }))}
                        />
                        {err && <span className="block text-hint text-danger">{err}</span>}
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

      <Panel>
        <p className="border-b border-line px-4 py-2.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase">
          Posted runs
        </p>
        <DataTable
          viewId="payroll-runs"
          testId="payroll-runs"
          ariaLabel="Posted pay runs"
          columns={RUN_COLUMNS}
          rows={runs ?? []}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-row-id': r.id })}
          loading={runsLoading}
          empty={{ title: 'Nothing posted yet' }}
          maxHeight="52vh"
          // Newest month first, as the runs come from the service.
          viewDefaults={{ sort: [{ id: 'month', dir: 'desc' }] }}
          toolbarFeatures={{ groupBy: false }}
          trailingWidth={380}
          trailing={(run) => <RunActions run={run} onPt={setPtRun} />}
          exportOptions={{ title: 'Posted pay runs', periodLabel: '', filename: 'pay-runs' }}
        />
      </Panel>
      {ptRun && <PtSummaryModal run={ptRun} onClose={() => setPtRun(null)} />}
    </>
  )
}

/** A posted run's actions (the trailing cell of the runs table). The payslip menu is a portalled
 *  Popover — the table's single-line cells clip anything absolutely positioned inside them — and
 *  it closes on outside click / Escape. */
function RunActions({ run, onPt }: { run: PayrollRun; onPt: (run: PayrollRun) => void }): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [payslipsOpen, setPayslipsOpen] = useState(false)
  const payslipsRef = useRef<HTMLButtonElement>(null)

  const exportFile = async (kind: 'ecr' | 'esi'): Promise<void> => {
    try {
      const r = kind === 'ecr' ? await api.payroll.ecr(run.id) : await api.payroll.esiCsv(run.id)
      toast.push('success', `${kind === 'ecr' ? 'PF ECR' : 'ESI CSV'}: ${r.path}`)
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
    <span className="inline-flex items-center gap-3 text-small">
      {run.voucherId && (
        <button
          className="text-blue hover:underline"
          data-testid="btn-payroll-voucher"
          onClick={() => nav.go({ name: 'voucher-entry', voucherId: run.voucherId! })}
        >
          Voucher
        </button>
      )}
      <button
        ref={payslipsRef}
        className="text-blue hover:underline"
        data-testid="btn-payroll-payslips"
        aria-haspopup="dialog"
        aria-expanded={payslipsOpen}
        onClick={() => setPayslipsOpen((o) => !o)}
      >
        Payslips ▾
      </button>
      {payslipsOpen && (
        <Popover anchor={payslipsRef} onClose={() => setPayslipsOpen(false)} label={`Payslips — ${monthLabel(run.month)}`} align="right" width={224}>
          <ScrollList maxH="40vh" className="-m-2">
            {run.lines.map((l) => (
              <button
                key={l.id}
                className="block w-full truncate rounded px-3 py-1.5 text-left text-body-sm text-ink hover:bg-panel2"
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
        </Popover>
      )}
      <button className="text-muted hover:text-ink" data-testid="btn-payroll-ecr" onClick={() => void exportFile('ecr')} title="EPFO ECR upload file">
        PF ECR
      </button>
      <button className="text-muted hover:text-ink" data-testid="btn-payroll-esi" onClick={() => void exportFile('esi')} title="ESIC upload CSV">
        ESI CSV
      </button>
      <button className="text-muted hover:text-ink" data-testid="btn-payroll-pt" onClick={() => onPt(run)} title="Professional tax summary by state">
        PT
      </button>
      <button className="text-cr hover:underline" data-testid="btn-payroll-delete-run" onClick={() => void remove()}>
        Delete
      </button>
    </span>
  )
}

const PT_COLUMNS = defineColumns<PtSummaryRow>([
  { id: 'state', header: 'State', kind: 'text', value: (r) => r.state, hideable: false, groupable: false, minWidth: 96 },
  { id: 'employees', header: 'Employees', kind: 'number', value: (r) => r.employees, aggregate: 'sum', width: 104 },
  { id: 'gross', header: 'Gross', kind: 'money', value: (r) => r.gross, aggregate: 'sum', width: 124 },
  { id: 'pt', header: 'PT payable', kind: 'money', value: (r) => r.pt, aggregate: 'sum', width: 124, className: 'font-medium' }
])

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
      <div className="overflow-hidden rounded-md border border-line">
        <DataTable
          testId="payroll-pt"
          ariaLabel={`Professional tax by state — ${monthLabel(run.month)}`}
          columns={PT_COLUMNS}
          rows={rows ?? []}
          rowKey={(r) => r.state}
          loading={isLoading}
          empty={{ title: 'No professional tax this run' }}
          toolbar={false}
          maxHeight="50vh"
        />
      </div>
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
