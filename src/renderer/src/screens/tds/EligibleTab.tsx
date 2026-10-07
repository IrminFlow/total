// Eligible tab: every voucher in the period that should carry TDS (or, kind 'tcs', TCS) and does
// not — Move to TDS / TCS (per row and bulk), section / amount choice, and "Not applicable".
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ELIGIBLE_REASON_LABELS } from '@shared/tdsEligibility'
import { TCS_ELIGIBLE_REASON_LABELS } from '@shared/tcs'
import { DEDUCTEE_TYPE_LABELS } from '@shared/tds'
import { formatPaise } from '@shared/money'
import type { TdsEligibleRow } from '../../lib/client'
import { AmountInput, Banner, Button, Checkbox, Field, Modal, Select } from '../../components/ui'
import { MenuButton } from '../../components/kit'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { openVoucher, useCanEditMasters } from '../../lib/drill'
import { confirmDialog, promptDialog } from '../../lib/dialogs'
import { KIND_WORDS, pctText, useTdsAction, withholdingApi, type TdsPeriod, type WithholdingKind } from './common'

export function eligibleColumns(kind: WithholdingKind) {
  const w = KIND_WORDS[kind]
  const KIND_LABEL = w.kindLabels
  const REASONS = kind === 'tcs' ? TCS_ELIGIBLE_REASON_LABELS : ELIGIBLE_REASON_LABELS
  return defineColumns<TdsEligibleRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  {
    id: 'voucher', header: 'Voucher', kind: 'text', value: (r) => r.voucherNumber, width: 92, hideable: false, groupable: false,
    text: (r) => `${KIND_LABEL[r.kind] ?? r.kind} ${r.voucherNumber}`,
    cell: (r) => <VoucherLink voucherId={r.voucherId} label={<><span className="text-muted">{KIND_LABEL[r.kind]?.slice(0, 3) ?? ''} </span>{r.voucherNumber}</>} />
  },
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 120, cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> },
  {
    id: 'expense', header: w.ledgerHeader, kind: 'text', value: (r) => r.stockItemName ?? r.expenseLedgerName, minWidth: 110,
    cell: (r) =>
      r.stockItemName ? (
        <span>{r.stockItemName} <span className="text-muted">· goods</span></span>
      ) : r.expenseLedgerId != null && r.expenseLedgerName ? (
        <LedgerLink ledgerId={r.expenseLedgerId} name={r.expenseLedgerName} />
      ) : (
        <span className="text-muted">—</span>
      )
  },
  // TCS section codes are longer ("206C(1F) VEHICLE"): the rate moves to its own column.
  kind === 'tcs'
    ? { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, width: 172, className: 'num' }
    : { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, width: 116, className: 'num', text: (r) => `${r.sectionCode} · ${pctText(r.rateBp)}` },
  { id: 'base', header: 'Base', kind: 'money', value: (r) => r.basePaise, aggregate: 'sum', width: kind === 'tcs' ? 140 : 118 },
  { id: 'rate', header: 'Rate', kind: 'number', value: (r) => (r.rateBp == null ? null : r.rateBp / 100), text: (r) => pctText(r.rateBp), width: 72, defaultHidden: true },
  { id: 'tds', header: `Suggested ${w.name}`, kind: 'money', value: (r) => r.tdsPaise ?? 0, aggregate: 'sum', width: 124 },
  {
    id: 'reason', header: 'Reason', kind: 'enum', value: (r) => (r.exemptReason ? 'exempt' : r.reason), minWidth: 150,
    options: [...Object.entries(REASONS).map(([value, label]) => ({ value, label })), { value: 'exempt', label: 'Marked not applicable' }],
    text: (r) => (r.exemptReason ? `Not applicable: ${r.exemptReason}` : REASONS[r.reason])
  },
  {
    id: 'deductee', header: `${w.party} type`, kind: 'text', value: (r) => (r.deducteeType ? DEDUCTEE_TYPE_LABELS[r.deducteeType] : null), width: 140, defaultHidden: true
  },
  { id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan, width: 120, defaultHidden: true, text: (r) => r.pan ?? 'Missing' }
  ])
}

export const ELIGIBLE_COLUMNS = eligibleColumns('tds')

export function EligibleTab({ period, kind = 'tds' }: { period: TdsPeriod; kind?: WithholdingKind }): React.JSX.Element {
  const w = KIND_WORDS[kind]
  const k = kind
  const wapi = withholdingApi(kind)
  const columns = useMemo(() => eligibleColumns(kind), [kind])
  const canEdit = useCanEditMasters()
  const { busy, run } = useTdsAction()
  const [includeExempt, setIncludeExempt] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [choose, setChoose] = useState<TdsEligibleRow | null>(null)
  const { data: rows, isLoading } = useQuery({
    queryKey: [k, 'eligible', period.from, period.to, includeExempt],
    queryFn: () => wapi.eligible(period.from, period.to, includeExempt)
  })
  const list = useMemo(() => rows ?? [], [rows])
  const movable = list.filter((r) => !r.exemptReason && r.tdsPaise != null && r.tdsPaise > 0)
  const chosen = movable.filter((r) => selected.has(r.voucherId))
  const totalSuggested = movable.reduce((s, r) => s + (r.tdsPaise ?? 0), 0)

  const move = (r: TdsEligibleRow): Promise<unknown> =>
    run(
      () => wapi.applyToVoucher(r.voucherId, { sectionId: r.sectionId }),
      (v) => `${w.name} of ${formatPaise((kind === 'tcs' ? v.tcs?.tcsAmount : v.tds?.tdsAmount) ?? 0, { symbol: true })} moved onto ${v.number}`
    )

  const moveSelected = async (): Promise<void> => {
    if (chosen.length === 0) return
    const ok = await confirmDialog({
      title: `Move to ${w.name}`,
      message: `Add the suggested ${w.noun} to ${chosen.length} voucher${chosen.length > 1 ? 's' : ''} (${formatPaise(chosen.reduce((s, r) => s + (r.tdsPaise ?? 0), 0), { symbol: true })})? Each voucher is altered through the normal save — lock date and audit apply.`,
      confirmLabel: `Move to ${w.name}`
    })
    if (!ok) return
    const res = await run(() => wapi.applyMany(chosen.map((r) => r.voucherId)), (out) => {
      const failed = out.filter((x) => !x.ok)
      return failed.length === 0 ? `Moved ${out.length} to ${w.name}` : `Moved ${out.length - failed.length}; ${failed.length} refused — ${failed[0]!.ok ? '' : failed[0]!.error}`
    })
    if (res) setSelected(new Set())
  }

  const markNa = async (r: TdsEligibleRow): Promise<void> => {
    const reason = await promptDialog({
      title: `${w.name} not applicable — ${r.voucherNumber}`,
      message: `Why does this voucher carry no ${w.name}? (kept with the voucher; the Eligible list skips it and it no longer counts towards the threshold${kind === 'tcs' ? '; a reason naming Form 27C is reported in 27EQ with remark B' : ''})`,
      initial: w.naReason,
      confirmLabel: 'Mark not applicable'
    })
    if (reason == null || !reason.trim()) return
    await run(() => wapi.exempt(r.voucherId, reason.trim().slice(0, 200)), `${r.voucherNumber} marked not applicable`)
  }

  return (
    <>
      {movable.length > 0 && (
        <Banner tone="warning" title={`${movable.length} voucher${movable.length > 1 ? 's' : ''} should carry ${w.name}`} className="mb-3">
          Suggested {w.noun}s total {formatPaise(totalSuggested, { symbol: true })} in {period.label}.{' '}
          {kind === 'tcs'
            ? 'Thresholds count every sale and advance from the buyer this year, collected on or not.'
            : 'Thresholds count every bill and advance to the party this year, deducted or not.'}
        </Banner>
      )}
      <DataTable
        viewId={`${k}-eligible`}
        testId={`${k}-eligible`}
        ariaLabel={`Vouchers that should carry ${w.name} — ${period.label}`}
        columns={columns}
        rows={list}
        loading={isLoading}
        rowKey={(r) => r.voucherId}
        rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
        onRowActivate={(r) => openVoucher(r.voucherId)}
        empty={{
          title: `Nothing eligible in ${period.label}`,
          hint: kind === 'tcs'
            ? 'Every sale to a flagged buyer, of flagged goods or through a flagged sales ledger already carries TCS (or is marked not applicable).'
            : 'Every bill and payment above its threshold already carries TDS (or is marked not applicable).'
        }}
        exportOptions={{ title: `${w.name} eligible vouchers`, periodLabel: period.label, filename: `${k}-eligible-${period.from}` }}
        leadingWidth={44}
        leading={
          canEdit
            ? (r) =>
                r.exemptReason || r.tdsPaise == null ? null : (
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.voucherNumber}`}
                    data-testid={`chk-${k}-eligible-${r.voucherId}`}
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
              <Button size="sm" variant="primary" data-testid={`btn-${k}-move-selected`} disabled={chosen.length === 0 || busy} onClick={() => void moveSelected()}>
                Move selected to {w.name}{chosen.length > 0 ? ` (${chosen.length})` : ''}
              </Button>
            )}
            {canEdit && movable.length > 0 && (
              <button
                type="button"
                className="text-small text-blue hover:underline"
                data-testid={`btn-${k}-select-all`}
                onClick={() => setSelected(chosen.length === movable.length ? new Set() : new Set(movable.map((r) => r.voucherId)))}
              >
                {chosen.length === movable.length ? 'Clear selection' : 'Select all'}
              </button>
            )}
            <Checkbox label="Show not applicable" checked={includeExempt} onChange={setIncludeExempt} testId={`chk-${k}-show-exempt`} />
          </div>
        }
        trailingWidth={canEdit ? 150 : 0}
        trailing={
          canEdit
            ? (r) =>
                r.exemptReason ? (
                  <Button size="sm" variant="ghost" data-testid={`btn-${k}-unexempt-${r.voucherId}`} onClick={() => void run(() => wapi.unexempt(r.voucherId), 'Mark removed')}>
                    Undo not applicable
                  </Button>
                ) : (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      data-testid={`btn-${k}-move-${r.voucherId}`}
                      disabled={busy || r.tdsPaise == null || r.tdsPaise <= 0 || (kind === 'tcs' && r.kind === 'receipt')}
                      disabledTitle={
                        r.tdsPaise == null ? `No ${w.name} rate in force on this date`
                          : kind === 'tcs' && r.kind === 'receipt' ? 'Open the receipt and apply TCS from its banner' : undefined
                      }
                      onClick={() => void move(r)}
                    >
                      Move to {w.name}
                    </Button>
                    <MenuButton
                      label={`More for ${r.voucherNumber}`}
                      testId={`menu-${k}-eligible-${r.voucherId}`}
                      items={[
                        { label: 'Choose section / amount…', onSelect: () => setChoose(r), testId: `btn-${k}-choose-${r.voucherId}` },
                        { label: 'Not applicable…', onSelect: () => void markNa(r), testId: `btn-${k}-na-${r.voucherId}` },
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
      {choose && <ChooseModal row={choose} kind={kind} onClose={() => setChoose(null)} />}
    </>
  )
}

/** Move to TDS / TCS with a different section (among the voucher's candidates) or a manual amount. */
function ChooseModal({ row, kind, onClose }: { row: TdsEligibleRow; kind: WithholdingKind; onClose: () => void }): React.JSX.Element {
  const w = KIND_WORDS[kind]
  const k = kind
  const wapi = withholdingApi(kind)
  const { busy, run } = useTdsAction()
  const { data: sections } = useQuery({ queryKey: [`${k}Sections`], queryFn: wapi.sections })
  const [sectionId, setSectionId] = useState(row.sectionId)
  const [manual, setManual] = useState<number | null>(null)
  const candidates = new Set(row.candidates.map((c) => c.sectionId))
  const submit = async (): Promise<void> => {
    if (manual != null) {
      const ok = await confirmDialog({
        title: `Manual ${w.name} amount`,
        message: `${w.verb[0]!.toUpperCase()}${w.verb.slice(1)} ${formatPaise(manual, { symbol: true })} on ${row.voucherNumber}? A manual ${w.noun} isn't checked against the rate table.`,
        confirmLabel: `${w.verb[0]!.toUpperCase()}${w.verb.slice(1)} manually`
      })
      if (!ok) return
    }
    const r = await run(() => wapi.applyToVoucher(row.voucherId, { sectionId, manualPaise: manual }), (v) => `${w.name} moved onto ${v.number}`)
    if (r) onClose()
  }
  return (
    <Modal title={`Move to ${w.name} — ${row.voucherNumber}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Section" hint="The voucher's candidates come first">
          <Select data-testid={`select-${k}-choose-section`} value={sectionId} onChange={(e) => setSectionId(Number(e.target.value))}>
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
          <AmountInput paise={manual} onPaise={setManual} testId={`input-${k}-choose-manual`} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid={`btn-${k}-choose-apply`} disabled={busy} onClick={() => void submit()}>
            Move to {w.name}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
