import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Employee } from '@shared/domain'
import { computeMonthlyPay, daysInMonth } from '@shared/payroll'
import { todayISO } from '@shared/dates'
import { api } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { AmountInput, Button, EmptyState, Field, Modal, Money, Panel, TextInput } from '../components/ui'

type Tab = 'employees' | 'runs'

export function PayrollScreen(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('employees')
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-1">
        <h2 className="mr-4 font-serif text-[19px] font-semibold tracking-tight">Payroll</h2>
        {(['employees', 'runs'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-[13px] capitalize ${tab === t ? 'bg-amberbar/20 font-medium text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'}`}
          >
            {t === 'runs' ? 'Pay runs' : 'Employees'}
          </button>
        ))}
      </div>
      {tab === 'employees' ? <EmployeesTab /> : <RunsTab />}
      <p className="mt-3 text-[11.5px] text-muted">
        Statutory defaults: EPF 12% + 12% on basic (₹15,000 ceiling) · ESI 0.75% / 3.25% when gross ≤ ₹21,000 · simplified professional-tax slab. Posting books one Journal voucher: salaries and employer contributions against PF/ESI/PT/Salaries payable.
      </p>
    </div>
  )
}

// ---------- employees ----------

function EmployeesTab(): React.JSX.Element {
  const { data: employees } = useQuery({ queryKey: ['employees'], queryFn: api.payroll.employees })
  const [editing, setEditing] = useState<Employee | 'new' | null>(null)

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add employee
        </Button>
      </div>
      <Panel>
        {!employees?.length ? (
          <EmptyState title="No employees yet" hint="Add employees with their monthly salary structure, then post a pay run" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Designation</th>
                <th className="r w-32">Basic</th>
                <th className="r w-32">HRA</th>
                <th className="r w-32">Special</th>
                <th className="r w-32">Gross / mo</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id} className={e.active ? '' : 'opacity-50'}>
                  <td>
                    {e.name}
                    {!e.active && <span className="ml-2 text-[11px] text-muted">inactive</span>}
                  </td>
                  <td className="text-muted">{e.designation}</td>
                  <td className="r"><Money paise={e.basic} /></td>
                  <td className="r"><Money paise={e.hra} /></td>
                  <td className="r"><Money paise={e.special} /></td>
                  <td className="r font-medium"><Money paise={e.basic + e.hra + e.special} /></td>
                  <td className="r">
                    <button className="text-[12px] text-blue hover:underline" onClick={() => setEditing(e)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {editing && <EmployeeModal employee={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
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
      await queryClient.invalidateQueries({ queryKey: ['employees'] })
      toast.push('success', `${name.trim()} saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const check = (label: string, value: boolean, set: (v: boolean) => void): React.JSX.Element => (
    <label className="flex items-center gap-2 text-[13px]">
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
          <Button variant="primary" onClick={() => void save()}>
            Save employee
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- pay runs ----------

function RunsTab(): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const { data: employees } = useQuery({ queryKey: ['employees'], queryFn: api.payroll.employees })
  const { data: runs } = useQuery({ queryKey: ['payrollRuns'], queryFn: api.payroll.runs })
  const [month, setMonth] = useState(todayISO().slice(0, 7))
  const [daysOverride, setDaysOverride] = useState<Record<number, string>>({})
  const [posting, setPosting] = useState(false)

  const active = (employees ?? []).filter((e) => e.active)
  const monthDays = /^\d{4}-\d{2}$/.test(month) ? daysInMonth(month) : 30
  const alreadyRun = (runs ?? []).some((r) => r.month === month)

  const preview = useMemo(
    () =>
      active.map((e) => {
        const payableDays = daysOverride[e.id] !== undefined && daysOverride[e.id] !== '' ? Number(daysOverride[e.id]) : monthDays
        const safeDays = Number.isFinite(payableDays) ? Math.min(monthDays, Math.max(0, payableDays)) : monthDays
        return { employee: e, payableDays: safeDays, pay: computeMonthlyPay(e, safeDays, monthDays) }
      }),
    [active, daysOverride, monthDays]
  )
  const totals = preview.reduce(
    (acc, p) => ({
      gross: acc.gross + p.pay.gross,
      deductions: acc.deductions + p.pay.pfEmp + p.pay.esiEmp + p.pay.pt,
      net: acc.net + p.pay.net,
      cost: acc.cost + p.pay.employerCost
    }),
    { gross: 0, deductions: 0, net: 0, cost: 0 }
  )

  const post = async (): Promise<void> => {
    if (posting) return
    setPosting(true)
    try {
      const run = await api.payroll.commit(
        month,
        preview.map((p) => ({ employeeId: p.employee.id, payableDays: p.payableDays }))
      )
      toast.push('success', `Payroll for ${run.month} posted — net ${'' + run.lines.length} employees`)
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
            <TextInput value={month} onChange={(e) => setMonth(e.target.value)} className="num w-32" placeholder="2026-08" />
          </Field>
          <Button variant="primary" disabled={alreadyRun || active.length === 0 || posting} onClick={() => void post()}>
            {alreadyRun ? `Posted for ${month}` : 'Post payroll'}
          </Button>
        </div>
        {active.length === 0 ? (
          <EmptyState title="No active employees" />
        ) : (
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
            <tbody>
              {preview.map((p) => (
                <tr key={p.employee.id}>
                  <td>{p.employee.name}</td>
                  <td className="r">
                    <input
                      className="num w-16 rounded border border-line bg-panel2 px-1.5 py-0.5 text-right text-[12.5px]"
                      value={daysOverride[p.employee.id] ?? String(monthDays)}
                      onChange={(e) => setDaysOverride((d) => ({ ...d, [p.employee.id]: e.target.value }))}
                    />
                  </td>
                  <td className="r"><Money paise={p.pay.gross} /></td>
                  <td className="r"><Money paise={p.pay.pfEmp} /></td>
                  <td className="r"><Money paise={p.pay.esiEmp} /></td>
                  <td className="r"><Money paise={p.pay.pt} /></td>
                  <td className="r font-medium"><Money paise={p.pay.net} /></td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total · employer cost <Money paise={totals.cost} /></td>
                <td></td>
                <td className="r"><Money paise={totals.gross} /></td>
                <td className="r" colSpan={3}><Money paise={totals.deductions} /></td>
                <td className="r"><Money paise={totals.net} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>

      <Panel>
        <p className="border-b border-line px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          Posted runs
        </p>
        {!runs?.length ? (
          <EmptyState title="Nothing posted yet" />
        ) : (
          runs.map((run) => (
            <div key={run.id} className="border-b border-line/50 px-4 py-2.5 last:border-b-0">
              <div className="flex items-center justify-between">
                <span className="font-medium">{run.month}</span>
                <span className="flex items-center gap-3 text-[12px]">
                  <Money paise={run.lines.reduce((s, l) => s + l.net, 0)} />
                  {run.voucherId && (
                    <button className="text-blue hover:underline" onClick={() => nav.go({ name: 'voucher-entry', voucherId: run.voucherId! })}>
                      Voucher
                    </button>
                  )}
                  <button
                    className="text-cr hover:underline"
                    onClick={async () => {
                      if (!window.confirm(`Delete the ${run.month} pay run and its voucher?`)) return
                      await api.payroll.removeRun(run.id)
                      await queryClient.invalidateQueries()
                      toast.push('success', `${run.month} pay run deleted`)
                    }}
                  >
                    Delete
                  </button>
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                {run.lines.map((l) => (
                  <button
                    key={l.id}
                    className="text-[12px] text-muted hover:text-blue hover:underline"
                    onClick={() => void api.payroll.payslip(run.id, l.employeeId)}
                    title="Open payslip PDF"
                  >
                    {l.employeeName} · payslip
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </Panel>
    </>
  )
}
