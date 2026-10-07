// Payroll statutory (WP 3.7), per employee: the tax-declarations editor (one financial year at a
// time) and the TDS workings behind a month's deduction.
import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Employee, SalaryWorkingsSnapshot } from '@shared/domain'
import { DECLARATION_LABELS, DECLARATION_SECTIONS, hraMetroCities, type DeclarationSection } from '@shared/payrollStatutory'
import { fyOf, todayISO } from '@shared/dates'
import { formatPaise, parseRupees } from '@shared/money'
import { statApi } from '../../lib/payrollStatutoryClient'
import { useToasts } from '../../state/stores'
import { Badge, Button, Modal, Money, Select, SkeletonRows, inputCls } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'

interface DeclRow {
  section: DeclarationSection
  label: string
  /** Allowed in the employee's regime (the new regime ignores Chapter VI-A, HRA, PT and 24(b)). */
  counts: boolean
}

const NEW_REGIME_SECTIONS: ReadonlySet<DeclarationSection> = new Set(['OTHER_INCOME', 'PREV_SALARY', 'PREV_TDS', 'PREV_PT'])

interface Edit {
  amountPaise: number
  proofReceived: boolean
}

const MODAL_TABLE_FEATURES = { groupBy: false, density: false, views: false, export: false } as const

/** Investment / income declarations for one employee and financial year. */
export function DeclarationsModal({ employee, onClose }: { employee: Employee; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const currentFy = fyOf(todayISO()).startYear
  const [fy, setFy] = useState(currentFy)
  const { data: saved, isLoading } = useQuery({
    queryKey: ['taxDeclarations', employee.id, fy],
    queryFn: () => statApi.declarations(employee.id, fy)
  })
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [saving, setSaving] = useState(false)
  const key = (s: DeclarationSection): string => `${fy}:${s}`
  const savedBy = useMemo(() => new Map((saved ?? []).map((d) => [d.section, d])), [saved])
  const stateOf = (s: DeclarationSection): Edit =>
    edits[key(s)] ?? { amountPaise: savedBy.get(s)?.amountPaise ?? 0, proofReceived: savedBy.get(s)?.proofReceived ?? false }
  const set = (s: DeclarationSection, e: Edit): void => setEdits((x) => ({ ...x, [key(s)]: e }))
  const stateRef = useRef({ stateOf, set })
  stateRef.current = { stateOf, set }

  const rows: DeclRow[] = DECLARATION_SECTIONS.map((s) => ({
    section: s, label: DECLARATION_LABELS[s], counts: employee.taxRegime === 'old' || NEW_REGIME_SECTIONS.has(s)
  }))
  const dirty = Object.keys(edits).some((k) => k.startsWith(`${fy}:`))

  const columns = useMemo(
    () =>
      defineColumns<DeclRow>([
        {
          id: 'section', header: 'Declaration', kind: 'text', value: (r) => r.label, hideable: false, groupable: false, minWidth: 260,
          cell: (r) => (
            <span className={r.counts ? '' : 'text-muted'}>
              {r.label}
              {!r.counts && <span className="ml-2"><Badge tone="neutral">not in the new regime</Badge></span>}
            </span>
          )
        },
        {
          id: 'amount', header: 'Amount for the year', kind: 'money', value: (r) => stateRef.current.stateOf(r.section).amountPaise,
          sortable: false, filterable: false, width: 170,
          cell: (r) => (
            <RupeeInput
              testId={`input-decl-${r.section}`}
              label={r.label}
              value={stateRef.current.stateOf(r.section).amountPaise}
              onChange={(v) => stateRef.current.set(r.section, { ...stateRef.current.stateOf(r.section), amountPaise: v })}
            />
          )
        },
        {
          id: 'proof', header: 'Proof', kind: 'enum', value: (r) => (stateRef.current.stateOf(r.section).proofReceived ? 'yes' : 'no'),
          options: [{ value: 'yes', label: 'Received' }, { value: 'no', label: 'Pending' }], sortable: false, filterable: false, width: 96,
          cell: (r) => (
            <input
              type="checkbox"
              aria-label={`Proof received — ${r.label}`}
              checked={stateRef.current.stateOf(r.section).proofReceived}
              onChange={(e) => stateRef.current.set(r.section, { ...stateRef.current.stateOf(r.section), proofReceived: e.target.checked })}
            />
          )
        }
      ]),
    []
  )

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await statApi.setDeclarations({
        employeeId: employee.id,
        fyStartYear: fy,
        rows: DECLARATION_SECTIONS.map((s) => ({ section: s, ...stateOf(s) })).filter((r) => r.amountPaise > 0)
      })
      setEdits({})
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['taxDeclarations'] }),
        queryClient.invalidateQueries({ queryKey: ['payrollPreview'] })
      ])
      toast.push('success', `${employee.name}'s declarations for FY ${fy}-${String((fy + 1) % 100).padStart(2, '0')} saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Tax declarations — ${employee.name}`} onClose={onClose} wide dirty={dirty}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Select aria-label="Financial year" value={fy} onChange={(e) => setFy(Number(e.target.value))} className="w-32" data-testid="decl-fy">
            {[currentFy + 1, currentFy, currentFy - 1].map((y) => (
              <option key={y} value={y}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</option>
            ))}
          </Select>
          <Badge tone={employee.taxRegime === 'old' ? 'amber' : 'info'}>{employee.taxRegime === 'old' ? 'Old regime' : 'New regime (default)'}</Badge>
          <span className="text-hint text-muted">
            HRA at 50% of salary in {hraMetroCities(fy).join(', ')}{employee.metro ? ' — this employee rents in one' : ''}; 40% elsewhere.
          </span>
        </div>
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : (
          <div className="overflow-hidden rounded-md border border-line">
            <DataTable
              key={fy}
              testId="payroll-declarations"
              ariaLabel={`Tax declarations — ${employee.name}`}
              columns={columns}
              rows={rows}
              rowKey={(r) => r.section}
              toolbarFeatures={MODAL_TABLE_FEATURES}
              maxHeight="38vh"
            />
          </div>
        )}
        <p className="text-hint text-muted">
          The pay run projects the year's tax from these and spreads what is still due over the months left. Employee PF counts under 80C automatically.
          Previous-employer figures are the Form 12B / Form 122 declaration.
        </p>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} data-testid="btn-payroll-save-declarations" onClick={() => void save()}>
            Save declarations
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Rupee input that keeps its own text while typing (paise out). */
function RupeeInput({ value, onChange, label, testId }: { value: number; onChange: (paise: number) => void; label: string; testId: string }): React.JSX.Element {
  const [text, setText] = useState(value ? formatPaise(value) : '')
  return (
    <input
      className={`${inputCls} num !h-[22px] !w-36 !py-0 !text-detail text-right`}
      aria-label={label}
      data-testid={testId}
      value={text}
      placeholder="0.00"
      onChange={(e) => {
        setText(e.target.value)
        const t = e.target.value.trim()
        if (t === '') return onChange(0)
        const p = parseRupees(t)
        if (p != null && p >= 0) onChange(p)
      }}
    />
  )
}

/** The projection a month's TDS came from. */
export function TdsWorkingsModal({ name, month, tds, w, onClose }: { name: string; month: string; tds: number; w: SalaryWorkingsSnapshot; onClose: () => void }): React.JSX.Element {
  const line = (label: string, amount: number, opts: { minus?: boolean; bold?: boolean } = {}): React.JSX.Element => (
    <tr className={opts.bold ? 'font-medium' : ''}>
      <td className="py-0.5 pr-6">{label}</td>
      <td className="num py-0.5 text-right">{opts.minus && amount ? '− ' : ''}<Money paise={amount} /></td>
    </tr>
  )
  return (
    <Modal title={`TDS workings — ${name}, ${month}`} onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="payroll-tds-workings">
        <div className="flex gap-2">
          <Badge tone={w.regime === 'old' ? 'amber' : 'info'}>{w.regime === 'old' ? 'Old regime' : 'New regime'}</Badge>
          <Badge tone="neutral">{w.act === '2025' ? 'Income-tax Act 2025 · s.392' : 'Income-tax Act 1961 · s.192'}</Badge>
        </div>
        <table className="text-body-sm">
          <tbody>
            {line('Projected salary for the year', w.gross)}
            {line('HRA exemption', w.hraExemption, { minus: true })}
            {line('Standard deduction', w.standardDeduction, { minus: true })}
            {line('Professional tax', w.professionalTax, { minus: true })}
            {line('Other income declared', w.otherIncome)}
            {line('House-property loss', w.housePropertyLoss, { minus: true })}
            {line('Chapter VI-A deductions', w.deductionsTotal, { minus: true })}
            {line('Total income (rounded to ₹10)', w.totalIncome, { bold: true })}
            {line('Tax for the year (after rebate, surcharge, 4% cess)', w.annualTax, { bold: true })}
            {line('Less: deducted by a previous employer', w.previousEmployerTds, { minus: true })}
            {line('Less: deducted in earlier months', w.deductedBefore, { minus: true })}
          </tbody>
        </table>
        <p className="text-body-sm">
          Spread over <b>{w.monthsRemaining}</b> month{w.monthsRemaining === 1 ? '' : 's'} left (this one included): <b><Money paise={tds} /></b> this month.
        </p>
        <div className="flex justify-end border-t border-line pt-3">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  )
}
