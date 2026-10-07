// Payroll → Statutory rates (WP 3.7): the effective-dated EPF / EPS / EDLI / admin / ESI rates,
// the Code on Social Security wage rule and the professional-tax slabs per state, each with the
// citation it was seeded from (migration 029). Owner-edited, like the TDS section master.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { StatutoryRateInput, StatutoryRateKind } from '@shared/schemas'
import { statApi, type StatutoryRate } from '../../lib/payrollStatutoryClient'
import { useToasts } from '../../state/stores'
import { confirmDialog } from '../../lib/dialogs'
import { AmountInput, Badge, Button, DateInput, Field, Modal, Panel, Select, Textarea, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'

export const RATE_KIND_LABEL: Record<StatutoryRateKind, string> = {
  epf: 'EPF (employee = employer)',
  eps: 'EPS (out of employer)',
  edli: 'EDLI',
  epf_admin: 'EPF admin charges',
  esi_emp: 'ESI employee',
  esi_er: 'ESI employer',
  ss_wages: 'Code wages (s.2(88))',
  pt: 'Professional tax'
}
const KIND_OPTIONS = (Object.keys(RATE_KIND_LABEL) as StatutoryRateKind[]).map((k) => ({ value: k, label: RATE_KIND_LABEL[k] }))
const BASIS_LABEL = { month: 'Monthly', half_year: 'Half-yearly', year: 'Annual' } as const
const pct = (bp: number | null): string => (bp == null ? '' : `${(bp / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`)
const rs = (p: number | null): string => (p == null ? '' : `₹${formatPaise(p)}`)
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Rate / amount" in words for one row. */
export function rateText(r: StatutoryRate): string {
  if (r.kind === 'pt') {
    const base = `${rs(r.amountPaise)} ${r.basis === 'month' ? '/ month' : r.basis === 'half_year' ? '/ half-year' : '/ year'}`
    return r.specialMonth ? `${base} (${MONTHS[r.specialMonth]} ${rs(r.specialAmountPaise)})` : base
  }
  if (r.kind === 'ss_wages') return `excluded items over ${pct(r.rateBp)} added back`
  return pct(r.rateBp)
}
/** Ceiling / threshold / slab in words. */
export function limitText(r: StatutoryRate): string {
  if (r.kind === 'pt') return r.slabToPaise == null ? `above ${rs(Math.max(0, (r.slabFromPaise ?? 1) - 1))}` : `${rs(r.slabFromPaise ?? 0)} – ${rs(r.slabToPaise)}`
  const parts: string[] = []
  if (r.ceilingPaise != null) parts.push(`ceiling ${rs(r.ceilingPaise)}`)
  if (r.thresholdPaise != null) parts.push(`covered to ${rs(r.thresholdPaise)}${r.variant === 'disabled' ? ' (disability)' : ''}`)
  if (r.minPaise != null) parts.push(r.kind === 'epf_admin' ? `minimum ${rs(r.minPaise)} / month` : `no employee share at ≤ ${rs(r.minPaise)} / day`)
  return parts.join(' · ')
}

export const RATE_COLUMNS = defineColumns<StatutoryRate>([
  { id: 'kind', header: 'Kind', kind: 'enum', value: (r) => r.kind, options: KIND_OPTIONS, width: 170, hideable: false },
  { id: 'state', header: 'State', kind: 'text', value: (r) => r.state ?? '', width: 64, className: 'num' },
  { id: 'from', header: 'From', kind: 'date', value: (r) => r.effectiveFrom, width: 100 },
  { id: 'to', header: 'To', kind: 'date', value: (r) => r.effectiveTo, width: 100, text: (r) => (r.effectiveTo ? toDisplayDate(r.effectiveTo) : 'open') },
  { id: 'rate', header: 'Rate / tax', kind: 'text', value: (r) => rateText(r), width: 190, className: 'num' },
  { id: 'limit', header: 'Ceiling / slab', kind: 'text', value: (r) => limitText(r), minWidth: 190, className: 'text-muted' },
  {
    id: 'gender', header: 'Applies to', kind: 'enum', value: (r) => r.gender, width: 92, defaultHidden: true,
    options: [{ value: 'any', label: 'Everyone' }, { value: 'female', label: 'Women' }, { value: 'male', label: 'Men' }]
  },
  {
    id: 'verified', header: 'Source', kind: 'enum', value: (r) => (r.verified ? 'verified' : 'unverified'), width: 104,
    options: [{ value: 'verified', label: 'Verified' }, { value: 'unverified', label: 'Unverified' }],
    cell: (r) => <Badge tone={r.verified ? 'success' : 'warning'} title={r.source}>{r.verified ? 'Verified' : 'Unverified'}</Badge>
  },
  { id: 'source', header: 'Citation', kind: 'text', value: (r) => r.source, minWidth: 260, className: 'text-muted text-hint', defaultHidden: false }
])

export function RatesTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: rates, isLoading } = useQuery({ queryKey: ['statutoryRates'], queryFn: statApi.rates })
  const [editing, setEditing] = useState<StatutoryRate | 'new' | null>(null)
  const today = todayISO()

  const remove = async (r: StatutoryRate): Promise<void> => {
    if (!(await confirmDialog({ title: 'Delete rate row', message: `Delete this ${RATE_KIND_LABEL[r.kind]} row? Pay runs posted with it keep their figures.`, confirmLabel: 'Delete', danger: true }))) return
    try {
      await statApi.rateDelete(r.id)
      await queryClient.invalidateQueries({ queryKey: ['statutoryRates'] })
      await queryClient.invalidateQueries({ queryKey: ['payrollPreview'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel>
      <div className="flex items-center justify-between px-3 pt-3">
        <p className="text-hint text-muted">
          Rows in force on a wage month's last day apply (the PF ceiling is day-weighted inside a month it changes). Hover a source badge for the citation.
        </p>
        <Button size="sm" data-testid="btn-payroll-add-rate" onClick={() => setEditing('new')}>Add rate row</Button>
      </div>
      <DataTable
        viewId="payroll-rates"
        testId="payroll-rates"
        ariaLabel="Statutory rates"
        columns={RATE_COLUMNS}
        rows={rates ?? []}
        rowKey={(r) => r.id}
        rowAttrs={(r) => ({ 'data-row-id': r.id })}
        rowClassName={(r) => (r.effectiveTo && r.effectiveTo < today ? 'text-muted' : '')}
        loading={isLoading}
        maxHeight="64vh"
        onRowActivate={(r) => setEditing(r)}
        trailingWidth={110}
        trailing={(r) => (
          <>
            <button className="mr-3 text-small text-blue hover:underline" onClick={() => setEditing(r)}>Edit</button>
            <button className="text-small text-cr hover:underline" onClick={() => void remove(r)}>Delete</button>
          </>
        )}
        exportOptions={{ title: 'Statutory rates', periodLabel: '', filename: 'statutory-rates' }}
      />
      {editing && <RateModal rate={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  )
}

function RateModal({ rate, onClose }: { rate: StatutoryRate | null; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [v, setV] = useState<StatutoryRateInput>(() => ({
    kind: rate?.kind ?? 'pt', state: rate?.state ?? 'MH', effectiveFrom: rate?.effectiveFrom ?? todayISO(), effectiveTo: rate?.effectiveTo ?? null,
    rateBp: rate?.rateBp ?? null, ceilingPaise: rate?.ceilingPaise ?? null, thresholdPaise: rate?.thresholdPaise ?? null, minPaise: rate?.minPaise ?? null,
    slabFromPaise: rate?.slabFromPaise ?? 0, slabToPaise: rate?.slabToPaise ?? null, amountPaise: rate?.amountPaise ?? null,
    basis: rate?.basis ?? 'month', gender: rate?.gender ?? 'any', variant: rate?.variant ?? 'standard',
    specialMonth: rate?.specialMonth ?? null, specialAmountPaise: rate?.specialAmountPaise ?? null,
    source: rate?.source ?? '', verified: rate?.verified ?? false
  }))
  const [rateInput, setRateInput] = useState(v.rateBp == null ? '' : String(v.rateBp / 100))
  const set = <K extends keyof StatutoryRateInput>(k: K, value: StatutoryRateInput[K]): void => setV((x) => ({ ...x, [k]: value }))
  const pt = v.kind === 'pt'

  const save = async (): Promise<void> => {
    try {
      const rateBp = pt || rateInput.trim() === '' ? null : Math.round(Number(rateInput) * 100)
      await statApi.rateSave({ ...v, rateBp, state: pt ? v.state : null }, rate?.id)
      await queryClient.invalidateQueries({ queryKey: ['statutoryRates'] })
      await queryClient.invalidateQueries({ queryKey: ['payrollPreview'] })
      toast.push('success', 'Rate row saved')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={rate ? `Edit ${RATE_KIND_LABEL[rate.kind]} row` : 'Add rate row'} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-4 gap-3">
          <Field label="Kind">
            <Select value={v.kind} onChange={(e) => set('kind', e.target.value as StatutoryRateKind)} data-testid="input-rate-kind">
              {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          {pt && <Field label="State"><TextInput value={v.state ?? ''} maxLength={2} onChange={(e) => set('state', e.target.value.toUpperCase())} className="num" /></Field>}
          <Field label="Effective from"><DateInput value={v.effectiveFrom} context={v.effectiveFrom} onChange={(d) => set('effectiveFrom', d)} testId="input-rate-from" /></Field>
          <Field label="Effective to" hint="Empty = open">
            <DateInput value={v.effectiveTo ?? ''} context={v.effectiveFrom} onChange={(d) => set('effectiveTo', d || null)} testId="input-rate-to" />
          </Field>
        </div>
        {pt ? (
          <div className="grid grid-cols-4 gap-3">
            <Field label="Salary from"><AmountInput paise={v.slabFromPaise} onPaise={(p) => set('slabFromPaise', p ?? 0)} /></Field>
            <Field label="Salary up to" hint="Empty = no ceiling"><AmountInput paise={v.slabToPaise} onPaise={(p) => set('slabToPaise', p)} /></Field>
            <Field label="Tax"><AmountInput paise={v.amountPaise} onPaise={(p) => set('amountPaise', p)} testId="input-rate-amount" /></Field>
            <Field label="Basis">
              <Select value={v.basis} onChange={(e) => set('basis', e.target.value as StatutoryRateInput['basis'])}>
                {(Object.keys(BASIS_LABEL) as (keyof typeof BASIS_LABEL)[]).map((b) => <option key={b} value={b}>{BASIS_LABEL[b]}</option>)}
              </Select>
            </Field>
            <Field label="Applies to">
              <Select value={v.gender} onChange={(e) => set('gender', e.target.value as StatutoryRateInput['gender'])}>
                <option value="any">Everyone</option><option value="female">Women</option><option value="male">Men</option>
              </Select>
            </Field>
            <Field label="Special month">
              <Select value={v.specialMonth ?? ''} onChange={(e) => set('specialMonth', e.target.value ? Number(e.target.value) : null)}>
                <option value="">None</option>
                {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </Select>
            </Field>
            <Field label="Tax in that month"><AmountInput paise={v.specialAmountPaise} onPaise={(p) => set('specialAmountPaise', p)} /></Field>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            <Field label="Rate %"><TextInput value={rateInput} onChange={(e) => setRateInput(e.target.value)} className="num text-right" data-testid="input-rate-pct" /></Field>
            <Field label="Wage ceiling"><AmountInput paise={v.ceilingPaise} onPaise={(p) => set('ceilingPaise', p)} /></Field>
            <Field label="Coverage threshold"><AmountInput paise={v.thresholdPaise} onPaise={(p) => set('thresholdPaise', p)} /></Field>
            <Field label={v.kind === 'epf_admin' ? 'Minimum / month' : 'Exempt daily wage'}><AmountInput paise={v.minPaise} onPaise={(p) => set('minPaise', p)} /></Field>
          </div>
        )}
        <Field label="Source (statute / notification, URL, date read)">
          <Textarea value={v.source} rows={3} onChange={(e) => set('source', e.target.value)} data-testid="input-rate-source" />
        </Field>
        <label className="flex items-center gap-2 text-detail">
          <input type="checkbox" checked={v.verified} onChange={(e) => set('verified', e.target.checked)} />
          Read from the official text (verified)
        </label>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-rate-save" onClick={() => void save()}>Save row</Button>
        </div>
      </div>
    </Modal>
  )
}
