// Eligible tab: every voucher in the period that should carry TDS and does not — Move to TDS
// (per row and bulk), section / amount choice, and "Not applicable".
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ELIGIBLE_REASON_LABELS } from '@shared/tdsEligibility'
import { DEDUCTEE_TYPE_LABELS } from '@shared/tds'
import { formatPaise } from '@shared/money'
import { api, type TdsEligibleRow } from '../../lib/client'
import { AmountInput, Banner, Button, Checkbox, Field, Modal, Select } from '../../components/ui'
import { MenuButton } from '../../components/kit'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { openVoucher, useCanEditMasters } from '../../lib/drill'
import { confirmDialog, promptDialog } from '../../lib/dialogs'
import { pctText, useTdsAction, type TdsPeriod } from './common'

const KIND_LABEL: Record<string, string> = { purchase: 'Purchase', journal: 'Journal', payment: 'Payment' }

export const ELIGIBLE_COLUMNS = defineColumns<TdsEligibleRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  {
    id: 'voucher', header: 'Voucher', kind: 'text', value: (r) => r.voucherNumber, width: 130, hideable: false, groupable: false,
    text: (r) => `${KIND_LABEL[r.kind] ?? r.kind} ${r.voucherNumber}`,
    cell: (r) => <VoucherLink voucherId={r.voucherId} label={<><span className="text-muted">{KIND_LABEL[r.kind]?.slice(0, 3) ?? ''} </span>{r.voucherNumber}</>} />
  },
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 160, cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> },
  {
    id: 'expense', header: 'Expense ledger', kind: 'text', value: (r) => r.expenseLedgerName, minWidth: 140,
    cell: (r) => (r.expenseLedgerId != null && r.expenseLedgerName ? <LedgerLink ledgerId={r.expenseLedgerId} name={r.expenseLedgerName} /> : <span className="text-muted">—</span>)
  },
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, width: 92, className: 'num' },
  { id: 'base', header: 'Base', kind: 'money', value: (r) => r.basePaise, aggregate: 'sum', width: 140 },
  { id: 'rate', header: 'Rate', kind: 'number', value: (r) => (r.rateBp == null ? null : r.rateBp / 100), text: (r) => pctText(r.rateBp), width: 80 },
  { id: 'tds', header: 'Suggested TDS', kind: 'money', value: (r) => r.tdsPaise ?? 0, aggregate: 'sum', width: 140 },
  {
    id: 'reason', header: 'Reason', kind: 'enum', value: (r) => (r.exemptReason ? 'exempt' : r.reason), width: 230,
    options: [...Object.entries(ELIGIBLE_REASON_LABELS).map(([value, label]) => ({ value, label })), { value: 'exempt', label: 'Marked not applicable' }],
    text: (r) => (r.exemptReason ? `Not applicable: ${r.exemptReason}` : ELIGIBLE_REASON_LABELS[r.reason])
  },
  {
    id: 'deductee', header: 'Deductee type', kind: 'text', value: (r) => (r.deducteeType ? DEDUCTEE_TYPE_LABELS[r.deducteeType] : null), width: 140, defaultHidden: true
  },
  { id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan, width: 120, defaultHidden: true, text: (r) => r.pan ?? 'Missing' }
])

export function EligibleTab({ period }: { period: TdsPeriod }): React.JSX.Element {
  const canEdit = useCanEditMasters()
  const { busy, run } = useTdsAction()
  const [includeExempt, setIncludeExempt] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [choose, setChoose] = useState<TdsEligibleRow | null>(null)
  const { data: rows, isLoading } = useQuery({
    queryKey: ['tds', 'eligible', period.from, period.to, includeExempt],
    queryFn: () => api.tds.eligible(period.from, period.to, includeExempt)
  })
  const list = useMemo(() => rows ?? [], [rows])
  const movable = list.filter((r) => !r.exemptReason && r.tdsPaise != null && r.tdsPaise > 0)
  const chosen = movable.filter((r) => selected.has(r.voucherId))
  const totalSuggested = movable.reduce((s, r) => s + (r.tdsPaise ?? 0), 0)

  const move = (r: TdsEligibleRow): Promise<unknown> =>
    run(() => api.tds.applyToVoucher(r.voucherId, { sectionId: r.sectionId }), (v) => `TDS of ${formatPaise(v.tds?.tdsAmount ?? 0, { symbol: true })} moved onto ${v.number}`)

  const moveSelected = async (): Promise<void> => {
    if (chosen.length === 0) return
    const ok = await confirmDialog({
      title: 'Move to TDS',
      message: `Add the suggested deduction to ${chosen.length} voucher${chosen.length > 1 ? 's' : ''} (${formatPaise(chosen.reduce((s, r) => s + (r.tdsPaise ?? 0), 0), { symbol: true })})? Each voucher is altered through the normal save — lock date and audit apply.`,
      confirmLabel: 'Move to TDS'
    })
    if (!ok) return
    const res = await run(() => api.tds.applyMany(chosen.map((r) => r.voucherId)), (out) => {
      const failed = out.filter((x) => !x.ok)
      return failed.length === 0 ? `Moved ${out.length} to TDS` : `Moved ${out.length - failed.length}; ${failed.length} refused — ${failed[0]!.ok ? '' : failed[0]!.error}`
    })
    if (res) setSelected(new Set())
  }

  const markNa = async (r: TdsEligibleRow): Promise<void> => {
    const reason = await promptDialog({
      title: `TDS not applicable — ${r.voucherNumber}`,
      message: 'Why does this voucher carry no TDS? (kept with the voucher; the Eligible list skips it and it no longer counts towards the threshold)',
      initial: 'Not a sum liable to TDS',
      confirmLabel: 'Mark not applicable'
    })
    if (reason == null || !reason.trim()) return
    await run(() => api.tds.exempt(r.voucherId, reason.trim().slice(0, 200)), `${r.voucherNumber} marked not applicable`)
  }

  return (
    <>
      {movable.length > 0 && (
        <Banner tone="warning" title={`${movable.length} voucher${movable.length > 1 ? 's' : ''} should carry TDS`} className="mb-3">
          Suggested deductions total {formatPaise(totalSuggested, { symbol: true })} in {period.label}. Thresholds count every bill and advance
          to the party this year, deducted or not.
        </Banner>
      )}
      <DataTable
        viewId="tds-eligible"
        testId="tds-eligible"
        ariaLabel={`Vouchers that should carry TDS — ${period.label}`}
        columns={ELIGIBLE_COLUMNS}
        rows={list}
        loading={isLoading}
        rowKey={(r) => r.voucherId}
        rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
        onRowActivate={(r) => openVoucher(r.voucherId)}
        empty={{ title: `Nothing eligible in ${period.label}`, hint: 'Every bill and payment above its threshold already carries TDS (or is marked not applicable).' }}
        exportOptions={{ title: 'TDS eligible vouchers', periodLabel: period.label, filename: `tds-eligible-${period.from}` }}
        leadingWidth={36}
        leading={
          canEdit
            ? (r) =>
                r.exemptReason || r.tdsPaise == null ? null : (
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.voucherNumber}`}
                    data-testid={`chk-tds-eligible-${r.voucherId}`}
                    checked={selected.has(r.voucherId)}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = new Set(s)
                        if (e.target.checked) n.add(r.voucherId)
                        else n.delete(r.voucherId)
                        return n
                      })
                    }
                  />
                )
            : undefined
        }
        toolbarStart={
          <div className="flex items-center gap-3">
            {canEdit && (
              <Button size="sm" variant="primary" data-testid="btn-tds-move-selected" disabled={chosen.length === 0 || busy} onClick={() => void moveSelected()}>
                Move selected to TDS{chosen.length > 0 ? ` (${chosen.length})` : ''}
              </Button>
            )}
            {canEdit && movable.length > 0 && (
              <button
                type="button"
                className="text-small text-blue hover:underline"
                data-testid="btn-tds-select-all"
                onClick={() => setSelected(chosen.length === movable.length ? new Set() : new Set(movable.map((r) => r.voucherId)))}
              >
                {chosen.length === movable.length ? 'Clear selection' : 'Select all'}
              </button>
            )}
            <Checkbox label="Show not applicable" checked={includeExempt} onChange={setIncludeExempt} testId="chk-tds-show-exempt" />
          </div>
        }
        trailingWidth={canEdit ? 196 : 0}
        trailing={
          canEdit
            ? (r) =>
                r.exemptReason ? (
                  <Button size="sm" variant="ghost" data-testid={`btn-tds-unexempt-${r.voucherId}`} onClick={() => void run(() => api.tds.unexempt(r.voucherId), 'Mark removed')}>
                    Undo not applicable
                  </Button>
                ) : (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      data-testid={`btn-tds-move-${r.voucherId}`}
                      disabled={busy || r.tdsPaise == null || r.tdsPaise <= 0}
                      disabledTitle={r.tdsPaise == null ? 'No TDS rate in force on this date' : undefined}
                      onClick={() => void move(r)}
                    >
                      Move to TDS
                    </Button>
                    <MenuButton
                      label={`More for ${r.voucherNumber}`}
                      testId={`menu-tds-eligible-${r.voucherId}`}
                      items={[
                        { label: 'Choose section / amount…', onSelect: () => setChoose(r), testId: `btn-tds-choose-${r.voucherId}` },
                        { label: 'Not applicable…', onSelect: () => void markNa(r), testId: `btn-tds-na-${r.voucherId}` },
                        { label: 'Open voucher', onSelect: () => openVoucher(r.voucherId) }
                      ]}
                    >
                      ⋯
                    </MenuButton>
                  </div>
                )
            : undefined
        }
      />
      {choose && <ChooseModal row={choose} onClose={() => setChoose(null)} />}
    </>
  )
}

/** Move to TDS with a different section (among the voucher's candidates) or a manual amount. */
function ChooseModal({ row, onClose }: { row: TdsEligibleRow; onClose: () => void }): React.JSX.Element {
  const { busy, run } = useTdsAction()
  const { data: sections } = useQuery({ queryKey: ['tdsSections'], queryFn: api.tds.sections })
  const [sectionId, setSectionId] = useState(row.sectionId)
  const [manual, setManual] = useState<number | null>(null)
  const candidates = new Set(row.candidates.map((c) => c.sectionId))
  const submit = async (): Promise<void> => {
    if (manual != null) {
      const ok = await confirmDialog({
        title: 'Manual TDS amount',
        message: `Deduct ${formatPaise(manual, { symbol: true })} on ${row.voucherNumber}? A manual deduction isn't checked against the rate table.`,
        confirmLabel: 'Deduct manually'
      })
      if (!ok) return
    }
    const r = await run(() => api.tds.applyToVoucher(row.voucherId, { sectionId, manualPaise: manual }), (v) => `TDS moved onto ${v.number}`)
    if (r) onClose()
  }
  return (
    <Modal title={`Move to TDS — ${row.voucherNumber}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Section" hint="The voucher's candidates come first">
          <Select data-testid="select-tds-choose-section" value={sectionId} onChange={(e) => setSectionId(Number(e.target.value))}>
            {[...(sections ?? [])]
              .sort((a, b) => Number(candidates.has(b.id)) - Number(candidates.has(a.id)) || a.code.localeCompare(b.code))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.description}
                  {candidates.has(s.id) ? ' (suggested)' : ''}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Manual amount" hint={`Blank = the rate table's figure${sectionId === row.sectionId && row.tdsPaise != null ? ` (${formatPaise(row.tdsPaise, { symbol: true })})` : ''}`}>
          <AmountInput paise={manual} onPaise={setManual} testId="input-tds-choose-manual" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-tds-choose-apply" disabled={busy} onClick={() => void submit()}>
            Move to TDS
          </Button>
        </div>
      </div>
    </Modal>
  )
}
