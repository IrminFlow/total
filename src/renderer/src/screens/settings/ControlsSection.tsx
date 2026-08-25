import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ApprovalPolicy, type PermissionAction, type PermissionMatrix, type Role } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Panel, SectionTitle, TextInput } from '../../components/ui'

export function ControlsSection(): React.JSX.Element {
  const { user } = useSession()
  const canEdit = user == null || user.role === 'owner'
  const policyQuery = useQuery({ queryKey: ['approvalPolicy'], queryFn: api.approvals.getPolicy })
  const typesQuery = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const permissionsQuery = useQuery({ queryKey: ['permissionMatrix'], queryFn: api.permissions.get })
  const [value, setValue] = useState<ApprovalPolicy>({ enabled: false, thresholdPaise: null, voucherTypeIds: [], expenseEnabled: false, expenseThresholdPaise: null })
  const [threshold, setThreshold] = useState('')
  const [expenseThreshold, setExpenseThreshold] = useState('')
  const [saving, setSaving] = useState(false)
  const [matrix, setMatrix] = useState<PermissionMatrix | null>(null)
  const toast = useToasts()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!policyQuery.data) return
    setValue(policyQuery.data)
    setThreshold(policyQuery.data.thresholdPaise === null ? '' : String(policyQuery.data.thresholdPaise / 100))
    setExpenseThreshold(policyQuery.data.expenseThresholdPaise === null ? '' : String(policyQuery.data.expenseThresholdPaise / 100))
  }, [policyQuery.data])
  useEffect(() => { if (permissionsQuery.data) setMatrix(permissionsQuery.data) }, [permissionsQuery.data])

  const toggleType = (id: number): void => setValue((current) => ({
    ...current,
    voucherTypeIds: current.voucherTypeIds.includes(id)
      ? current.voucherTypeIds.filter((typeId) => typeId !== id)
      : [...current.voucherTypeIds, id]
  }))

  const save = async (): Promise<void> => {
    const rupees = threshold.trim() === '' ? null : Number(threshold.replace(/,/g, ''))
    const expenseRupees = expenseThreshold.trim() === '' ? null : Number(expenseThreshold.replace(/,/g, ''))
    if (rupees !== null && (!Number.isFinite(rupees) || rupees < 0)) {
      toast.push('error', 'Enter a valid non-negative threshold')
      return
    }
    if (expenseRupees !== null && (!Number.isFinite(expenseRupees) || expenseRupees < 0)) { toast.push('error', 'Enter a valid expense threshold'); return }
    setSaving(true)
    try {
      const saved = await api.approvals.setPolicy({
        ...value,
        thresholdPaise: rupees === null ? null : Math.round(rupees * 100),
        expenseThresholdPaise: expenseRupees === null ? null : Math.round(expenseRupees * 100)
      })
      setValue(saved)
      await queryClient.invalidateQueries({ queryKey: ['approvalPolicy'] })
      toast.push('success', saved.enabled ? 'Maker-checker policy enabled' : 'Maker-checker policy disabled')
    } catch (error) {
      toast.push('error', (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const savePermissions = async (): Promise<void> => {
    if (!matrix) return
    setSaving(true)
    try {
      const saved = await api.permissions.set(matrix)
      setMatrix(saved)
      await queryClient.invalidateQueries({ queryKey: ['permissionMatrix'] })
      toast.push('success', 'Role permissions saved')
    } catch (error) {
      toast.push('error', (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return <div>
    <SectionTitle right={<span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${value.enabled || value.expenseEnabled ? 'border-amber/50 text-amber' : 'border-line text-muted'}`}>{value.enabled || value.expenseEnabled ? 'Enforced' : 'Off'}</span>}>
      Internal controls
    </SectionTitle>
    <Panel className="p-5">
      <div className="flex items-start justify-between gap-8">
        <div className="max-w-md">
          <h3 className="text-[13px] font-semibold">Maker-checker for vouchers</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
            Matching entries become inert approval requests. They do not affect books, GST, stock or reports until a different owner approves them.
          </p>
        </div>
        <label className="flex items-center gap-2 text-[12px] font-medium">
          <input type="checkbox" checked={value.enabled} disabled={!canEdit} onChange={(event) => setValue((current) => ({ ...current, enabled: event.target.checked }))} />
          Require approval
        </label>
      </div>

      <div className="mt-5 rounded-lg border border-line bg-panel2 p-4">
        <div className="flex items-start justify-between gap-6"><div><h3 className="text-[12.5px] font-semibold">Employee & department expenses</h3><p className="mt-1 max-w-xl text-[11px] leading-4 text-muted">Route Payment or Journal entries debiting an expense ledger into the approval inbox. Cost-centre allocations identify the department for the checker.</p></div><label className="flex shrink-0 items-center gap-2 text-[11.5px] font-medium"><input type="checkbox" checked={value.expenseEnabled} disabled={!canEdit} onChange={(event)=>setValue((current)=>({...current,expenseEnabled:event.target.checked}))}/> Require review</label></div>
        <div className="mt-3 max-w-xs"><Field label="Expense threshold (₹)" hint="Leave blank to review every detected expense."><TextInput data-testid="input-expense-approval-threshold" className="num" inputMode="decimal" placeholder="Review every expense" value={expenseThreshold} disabled={!canEdit||!value.expenseEnabled} onChange={(event)=>setExpenseThreshold(event.target.value)}/></Field></div>
      </div>

      <div className="mt-5 border-t border-line pt-5">
        <Field label="Amount threshold (₹)" hint="An entry at or above this total debit requires approval. Leave blank to use voucher types only.">
          <TextInput data-testid="input-approval-threshold" className="num max-w-xs" inputMode="decimal" placeholder="For example 100000" value={threshold} disabled={!canEdit} onChange={(event) => setThreshold(event.target.value)} />
        </Field>
        <p className="mb-2 mt-5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Voucher types that always require approval</p>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line">
          {(typesQuery.data ?? []).map((type) => <label key={type.id} className="flex items-center gap-2 bg-panel2 px-3 py-2.5 text-[12px] hover:bg-panel">
            <input type="checkbox" checked={value.voucherTypeIds.includes(type.id)} disabled={!canEdit} onChange={() => toggleType(type.id)} />
            <span>{type.name}</span>
            <span className="ml-auto text-[10px] capitalize text-muted">{type.kind.replace('_', ' ')}</span>
          </label>)}
        </div>
      </div>
      <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
        <p className="text-[10.5px] text-muted">Enabling requires at least two active users. Maker and checker identity is retained in the audit chain.</p>
        <Button variant="primary" data-testid="btn-approval-policy-save" disabled={!canEdit || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save policy'}</Button>
      </div>
    </Panel>
    {matrix && <PermissionMatrixPanel matrix={matrix} canEdit={canEdit} saving={saving} onChange={setMatrix} onSave={() => void savePermissions()} />}
  </div>
}

const ACTIONS: { id: PermissionAction; label: string; detail: string }[] = [
  { id: 'view', label: 'View', detail: 'Books and reports' },
  { id: 'create', label: 'Create', detail: 'New entries and masters' },
  { id: 'edit', label: 'Edit', detail: 'Change or remove records' },
  { id: 'approve', label: 'Approve', detail: 'Post controlled requests' },
  { id: 'export', label: 'Export', detail: 'Files, PDF and print' },
  { id: 'backup', label: 'Backup', detail: 'Create and restore copies' },
  { id: 'settings', label: 'Settings', detail: 'Company and security policy' }
]

function PermissionMatrixPanel({ matrix, canEdit, saving, onChange, onSave }: {
  matrix: PermissionMatrix
  canEdit: boolean
  saving: boolean
  onChange: (matrix: PermissionMatrix) => void
  onSave: () => void
}): React.JSX.Element {
  const set = (role: Role, action: PermissionAction, allowed: boolean): void => onChange({
    ...matrix,
    [role]: { ...matrix[role], [action]: allowed }
  })
  return <Panel className="mt-4 p-5">
    <div className="flex items-start justify-between gap-8">
      <div><h3 className="text-[13px] font-semibold">Role permission matrix</h3><p className="mt-1 text-[11.5px] text-muted">Enforced in the main process for every request. Hiding a button never grants or removes authority.</p></div>
      <Button variant="primary" disabled={!canEdit || saving} onClick={onSave}>{saving ? 'Saving…' : 'Save permissions'}</Button>
    </div>
    <div className="mt-5 overflow-hidden rounded-md border border-line">
      <div className="grid grid-cols-[1fr_110px_110px_110px] bg-panel2 px-3 py-2 text-[10px] font-semibold tracking-[0.08em] text-muted uppercase">
        <span>Action</span><span className="text-center">Owner</span><span className="text-center">Accountant</span><span className="text-center">Viewer</span>
      </div>
      {ACTIONS.map((action) => <div key={action.id} className="grid grid-cols-[1fr_110px_110px_110px] items-center border-t border-line px-3 py-2.5">
        <span><span className="block text-[12px] font-medium">{action.label}</span><span className="block text-[10px] text-muted">{action.detail}</span></span>
        {(['owner', 'accountant', 'viewer'] as Role[]).map((role) => <label key={role} className="flex justify-center">
          <input type="checkbox" aria-label={`${role} can ${action.label.toLowerCase()}`} checked={matrix[role][action.id]} disabled={!canEdit || role === 'owner'} onChange={(event) => set(role, action.id, event.target.checked)} />
        </label>)}
      </div>)}
    </div>
    <p className="mt-3 text-[10.5px] text-muted">Owner rights stay enabled to guarantee local recovery. Sensitive payroll, statutory IDs and margins remain masked from viewers even when View is allowed.</p>
  </Panel>
}
