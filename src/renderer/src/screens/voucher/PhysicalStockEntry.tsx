import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Voucher } from '@shared/domain'
import {
  blankCountRow as blankCountState, buildPhysicalPayload, countedMilli, emptyPhysicalState,
  type CountRowState, type PhysicalFormState
} from '@shared/voucherEdit'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Button, DateInput, Field, isAnyModalOpen, Panel, TextInput, inputCls } from '../../components/ui'
import { ItemPicker, useStockItems } from '../../components/pickers'
import { confirmDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { nextLineKey, NUMBER_LOADING, useAlterationDirty, useLeaveAfterSave, useVoucherNumberField } from './hooks'

// ---------- physical stock mode (counted closing quantities, is_absolute lines) ----------

interface CountRow extends CountRowState {
  /** Stable React key (see nextLineKey). */
  key: number
}

const blankCountRow = (): CountRow => ({ ...blankCountState(), key: nextLineKey() })

/**
 * Physical Stock voucher: each line is the COUNTED closing quantity of an item as on the
 * voucher date (inventory_lines.is_absolute = 1), not a movement — the engine turns the
 * difference from book stock into an adjustment valued at the running average cost
 * (src/shared/valuation.ts). No ledger lines; a count of 0 is a legitimate entry.
 * State → payload lives in @shared/voucherEdit/physical; an alteration (`initial`) keeps each
 * saved line's godown and batch.
 */
export function PhysicalStockEntry({
  typeId,
  voucherId,
  voucher,
  initial
}: {
  typeId: number
  voucherId?: number
  voucher?: Voucher
  initial?: PhysicalFormState
}): React.JSX.Element {
  const isEdit = voucherId != null
  const { workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const [base] = useState(() => initial ?? emptyPhysicalState(workingDate))
  const [date, setDate] = useState(base.date)
  const [rows, setRows] = useState<CountRow[]>(() =>
    initial ? [...initial.rows.map((r) => ({ ...r, key: nextLineKey() })), blankCountRow()] : [blankCountRow()]
  )
  const [narration, setNarration] = useState(base.narration)
  const [saving, setSaving] = useState(false)
  const numberField = useVoucherNumberField(typeId, date, voucherId)
  const [alterNumber, setAlterNumber] = useState(base.number)
  const { saved, leave } = useLeaveAfterSave()

  // Book stock as on the count date, for the counted-vs-book readout per line.
  const { data: stock } = useQuery({
    queryKey: ['stockSummary', date],
    queryFn: () => api.stock.summary(date)
  })
  const bookOf = useMemo(() => new Map((stock ?? []).map((s) => [s.stockItemId, s])), [stock])
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const itemName = useCallback((id: number): string => itemMap.get(id)?.name ?? '', [itemMap])

  const formState: PhysicalFormState = useMemo(
    () => ({
      ...base,
      date,
      number: isEdit ? alterNumber : numberField.forPayload,
      rows: rows.map(({ key: _key, ...r }) => r),
      narration
    }),
    [base, date, isEdit, alterNumber, numberField.forPayload, rows, narration]
  )

  const alterationDirty = useAlterationDirty(voucher, isEdit ? buildPhysicalPayload(formState, { voucherTypeId: typeId, itemName }) : null)
  useUnsavedGuard(!saved && (isEdit ? alterationDirty : rows.some((r) => r.itemId != null) || narration.trim() !== ''))

  const setRow = (i: number, patch: Partial<CountRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      if (next[next.length - 1]!.itemId != null) next.push(blankCountRow())
      return next
    })
  }

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    const built = buildPhysicalPayload(formState, { voucherTypeId: typeId, itemName })
    if (!built.ok) return void toast.push('error', built.error)
    const counted = built.payload.inventory.length
    setSaving(true)
    try {
      const result = await api.vouchers.save(built.payload, voucherId)
      toast.push(
        'success',
        `Physical stock ${result.number} ${isEdit ? 'altered' : 'saved'} — ${counted} item${counted > 1 ? 's' : ''} counted`
      )
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (isEdit) return leave()
      setRows([blankCountRow()])
      setNarration('')
      numberField.reset()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, formState, typeId, itemName, toast, voucherId, isEdit, setWorkingDate, date, queryClient, leave, numberField.reset])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (isAnyModalOpen()) return
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  const remove = async (): Promise<void> => {
    if (!voucherId) return
    const proceed = await confirmDialog({
      title: 'Move to Bin',
      message: 'Move this voucher to the Bin? You can restore it from the bin for 30 days.',
      confirmLabel: 'Move to Bin',
      danger: true
    })
    if (!proceed) return
    try {
      await api.vouchers.remove(voucherId)
      toast.push('success', 'Moved to Bin')
      await queryClient.invalidateQueries()
      leave()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="p-5">
      <div className="grid grid-cols-4 gap-3">
        <Field label="No." hint={isEdit || numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override'}>
          <TextInput
            value={isEdit ? alterNumber : numberField.value === NUMBER_LOADING ? '' : numberField.value}
            onChange={(e) => (isEdit ? setAlterNumber(e.target.value) : numberField.onChange(e.target.value))}
            placeholder="Auto"
            className="num"
          />
        </Field>
        <Field label="Date of count">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <div className="col-span-2 flex items-end">
          <p className="text-hint text-muted">
            Enter the counted closing quantity per item — the difference from book stock posts as an
            adjustment at average cost.
          </p>
        </div>
      </div>

      <table className="ledger-table mt-4">
        <thead>
          <tr>
            <th>Item</th>
            <th className="r w-32">Book qty</th>
            <th className="r w-32">Counted</th>
            <th className="r w-36">Difference</th>
          </tr>
        </thead>
        <tbody data-testid="rows-physical-lines">
          {rows.map((r, i) => {
            const book = r.itemId != null ? (bookOf.get(r.itemId)?.closingQtyMilli ?? 0) : null
            const unit = r.itemId != null ? (bookOf.get(r.itemId)?.unitSymbol ?? '') : ''
            const counted = countedMilli(r)
            const diff = book != null && counted != null ? counted - book : null
            return (
              <tr key={r.key}>
                <td>
                  {/* A different item can't keep the old line's batch (batches belong to an item). */}
                  <ItemPicker value={r.itemId} onPick={(id) => setRow(i, id === r.itemId ? { itemId: id } : { itemId: id, batchId: null })} />
                </td>
                <td className="r">
                  {book != null && <span className="num text-body-sm text-muted">{book / 1000} {unit}</span>}
                </td>
                <td className="r">
                  <input
                    className={`${inputCls} num text-right`}
                    data-testid="input-counted-qty"
                    value={r.qtyText}
                    inputMode="decimal"
                    placeholder="0"
                    onChange={(e) => setRow(i, { qtyText: e.target.value })}
                  />
                </td>
                <td className="r">
                  {diff != null && (
                    <span className={`num text-body-sm ${diff === 0 ? 'text-muted' : diff > 0 ? 'text-dr' : 'text-cr'}`}>
                      {diff > 0 ? '+' : ''}{diff / 1000} {unit}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="mt-4">
        <Field label="Narration">
          <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Being physical stock verified…" />
        </Field>
      </div>

      <div className="mt-5 flex justify-between">
        <div>{isEdit && <Button variant="danger" onClick={() => void remove()}>Delete voucher</Button>}</div>
        <div className="flex gap-2">
          <Button onClick={() => nav.back()}>Cancel</Button>
          <Button variant="primary" data-testid="btn-save-physical" disabled={saving} onClick={() => void save()}>
            {isEdit ? 'Save changes' : 'Save count'} ⌘↵
          </Button>
        </div>
      </div>
    </Panel>
  )
}
