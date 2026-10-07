import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Voucher } from '@shared/domain'
import { formatPaise } from '@shared/money'
import {
  blankStockLineRow, buildStockLinesPayload, emptyStockLinesState, recomputeStockLineAmount,
  type StockLineRowState, type StockLinesFormState
} from '@shared/voucherEdit'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, isAnyModalOpen, Panel, TextInput, inputCls } from '../../components/ui'
import { ItemPicker, useStockItems } from '../../components/pickers'
import { confirmDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { nextLineKey, NUMBER_LOADING, useAlterationDirty, useLeaveAfterSave, useVoucherNumberField } from './hooks'
import { LineDetailToggle, LineStockDetail, LineStockSummary, useLineDetails } from './LineStockDetail'

// ---------- generic stock lines (lossless fallback for stock journals / physical stock) ----------
// One row per inventory line: item, in/out, qty, rate, amount, godown, batch. Used when a saved
// stock voucher can't be shown by the manufacture or physical-count form (transfers, imported
// Tally journals, hand-made lines). Godown, batch and serials are picked in each line's detail
// row (WP 2.3); hidden per-line fields (discount, physical-count flag) and any ledger lines ride
// along untouched. State → payload: @shared/voucherEdit/stockLines. Also the free-form
// adjustment mode of the Stock journal screen (screens/StockJournal.tsx) for new vouchers.

interface StockRow extends StockLineRowState {
  key: number
  /** Bumped when amount is recomputed, to remount its AmountInput (which owns its text). */
  amountRev: number
}

const blankRow = (): StockRow => ({ ...blankStockLineRow(), key: nextLineKey(), amountRev: 0 })

export function StockLinesEntry({
  typeId,
  voucherId,
  voucher,
  initial: initialProp,
  fallbackReason = null,
  formName = 'manufacture'
}: {
  typeId: number
  /** Alteration: the saved voucher and its reconstructed state. Omitted = a new free-form stock
   *  journal (the Stock journal screen's adjustment mode, WP 2.3). */
  voucherId?: number
  voucher?: Voucher
  initial?: StockLinesFormState
  fallbackReason?: string | null
  /** The specialised form this voucher couldn't open in ('manufacture', 'physical-count'). */
  formName?: string
}): React.JSX.Element {
  const isEdit = voucherId != null
  const { workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [initial] = useState(() => initialProp ?? emptyStockLinesState(workingDate))
  const [date, setDate] = useState(initial.date)
  const [alterNumber, setNumber] = useState(initial.number)
  const numberField = useVoucherNumberField(typeId, date, voucherId)
  const number = isEdit ? alterNumber : numberField.forPayload
  const [rows, setRows] = useState<StockRow[]>(() =>
    initialProp ? [...initial.rows.map((r) => ({ ...r, key: nextLineKey(), amountRev: 0 })), blankRow()] : [blankRow()]
  )
  const [narration, setNarration] = useState(initial.narration)
  const [saving, setSaving] = useState(false)
  const { saved, leave } = useLeaveAfterSave()

  const items = useStockItems()
  const details = useLineDetails()

  const formState: StockLinesFormState = useMemo(
    () => ({ ...initial, date, number, narration, rows: rows.map(({ key: _k, amountRev: _r, ...r }) => r) }),
    [initial, date, number, narration, rows]
  )
  const alterationDirty = useAlterationDirty(voucher, isEdit ? buildStockLinesPayload(formState, { voucherTypeId: typeId }) : null)
  useUnsavedGuard(!saved && (isEdit ? alterationDirty : rows.some((r) => r.itemId != null) || narration.trim() !== ''))

  const setRow = (i: number, patch: Partial<StockRow>, recompute = false): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => {
        if (j !== i) return r
        const row = { ...r, ...patch }
        return recompute ? { ...row, amount: recomputeStockLineAmount(row), amountRev: row.amountRev + 1 } : row
      })
      if (next[next.length - 1]!.itemId != null) next.push(blankRow())
      return next
    })
  }

  const totals = rows.reduce(
    (t, r) => (r.itemId == null ? t : r.direction === 'in' ? { ...t, in: t.in + (r.amount ?? 0) } : { ...t, out: t.out + (r.amount ?? 0) }),
    { in: 0, out: 0 }
  )

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    const built = buildStockLinesPayload(formState, { voucherTypeId: typeId })
    if (!built.ok) return void toast.push('error', built.error)
    setSaving(true)
    try {
      if (built.payload.number && (await api.vouchers.numberExists(typeId, built.payload.number, voucherId))) {
        const proceed = await confirmDialog({
          title: 'Duplicate number',
          message: `Voucher number ${built.payload.number} is already used by another voucher of this type. Save anyway with the same number?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const result = await api.vouchers.save(built.payload, voucherId)
      toast.push('success', isEdit ? `${result.number} altered` : `Stock journal ${result.number} saved`)
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (isEdit) leave()
      else {
        setRows([blankRow()])
        setNarration('')
        numberField.reset()
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, formState, typeId, toast, voucherId, isEdit, setWorkingDate, date, queryClient, leave, numberField])

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
    const proceed = await confirmDialog({
      title: 'Move to Bin',
      message: 'Move this voucher to the Bin? You can restore it from the bin for 30 days.',
      confirmLabel: 'Move to Bin',
      danger: true
    })
    if (!proceed) return
    try {
      await api.vouchers.remove(voucherId!)
      toast.push('success', 'Moved to Bin')
      await queryClient.invalidateQueries()
      leave()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="p-5">
      {fallbackReason && (
        <p
          data-testid="banner-stock-lines-fallback"
          className="mb-4 rounded-md border border-amber/40 bg-amberbar/10 px-3 py-2 text-body-sm text-ink"
          title={fallbackReason}
        >
          Shown as plain stock lines — this voucher can&apos;t be opened in the {formName} form ({fallbackReason}). Every line
          is kept exactly as saved unless you change it.
        </p>
      )}
      <div className="grid grid-cols-4 gap-3">
        <Field label="No." hint={isEdit || numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override'}>
          <TextInput
            value={isEdit ? alterNumber : numberField.value === NUMBER_LOADING ? '' : numberField.value}
            onChange={(e) => (isEdit ? setNumber(e.target.value) : numberField.onChange(e.target.value))}
            placeholder="Auto"
            className="num"
            data-testid="input-stock-lines-number"
          />
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <div className="col-span-2 flex items-end justify-end">
          <p className="num text-body-sm text-muted">
            In {formatPaise(totals.in)} · Out {formatPaise(totals.out)}
          </p>
        </div>
      </div>

      <table className="ledger-table mt-4">
        <thead>
          <tr>
            <th>Item</th>
            <th className="w-16">In / Out</th>
            <th className="r w-24">Qty</th>
            <th className="r w-28">Rate</th>
            <th className="r w-32">Amount</th>
            <th className="w-48">Godown · batch · serials</th>
            <th className="w-6"><span className="sr-only">Stock details</span></th>
          </tr>
        </thead>
        <tbody data-testid="rows-stock-lines">
          {rows.map((r, i) => {
            const item = r.itemId != null ? items.find((it) => it.id === r.itemId) : undefined
            const detailItem = item && r.isAbsolute ? { ...item, trackSerials: false } : item
            const detailOpen = details.isOpen(r.key, detailItem)
            return (
            <Fragment key={r.key}>
            <tr onKeyDown={details.onRowKeyDown(r.key)}>
              <td>
                <ItemPicker
                  value={r.itemId}
                  onPick={(id) => setRow(i, id === r.itemId ? { itemId: id } : { itemId: id, batchId: null, serials: undefined })}
                />
                {r.isAbsolute && <span className="ml-1 text-caption text-muted">counted closing qty</span>}
              </td>
              <td>
                <button
                  className={`num w-12 rounded-md border border-line px-2 py-1 text-body-sm font-medium ${r.direction === 'in' ? 'text-dr' : 'text-cr'}`}
                  onClick={() => setRow(i, { direction: r.direction === 'in' ? 'out' : 'in' })}
                  title="Toggle in / out"
                >
                  {r.direction === 'in' ? 'In' : 'Out'}
                </button>
              </td>
              <td className="r">
                <input
                  className={`${inputCls} num text-right`}
                  data-testid="input-stock-line-qty"
                  value={r.qtyText}
                  inputMode="decimal"
                  placeholder="0"
                  onChange={(e) => setRow(i, { qtyText: e.target.value }, true)}
                />
              </td>
              <td className="r">
                <AmountInput paise={r.rate} onPaise={(p) => setRow(i, { rate: p }, true)} testId="input-stock-line-rate" />
              </td>
              <td className="r">
                <AmountInput key={r.amountRev} paise={r.amount} onPaise={(p) => setRow(i, { amount: p })} testId="input-stock-line-amount" />
              </td>
              <td>{!detailOpen && <LineStockSummary fields={r} />}</td>
              <td>
                <LineDetailToggle open={detailOpen} onToggle={() => details.toggle(r.key)} fields={r} disabled={!item} />
              </td>
            </tr>
            {detailOpen && detailItem && (
              <tr data-testid="row-line-detail">
                <td colSpan={7} className="!pt-0">
                  <LineStockDetail
                    item={detailItem}
                    direction={r.direction}
                    qtyMilli={Math.round(parseFloat(r.qtyText || '0') * 1000) || 0}
                    fields={r}
                    onChange={(patch) => setRow(i, patch)}
                    voucherId={voucherId}
                  />
                </td>
              </tr>
            )}
            </Fragment>
            )
          })}
        </tbody>
      </table>

      {initial.ledgerLines.length > 0 && (
        <p className="mt-3 text-small text-muted">
          This voucher also carries {initial.ledgerLines.length} ledger line{initial.ledgerLines.length > 1 ? 's' : ''}; they are kept as-is when you save.
        </p>
      )}

      <div className="mt-4">
        <Field label="Narration">
          <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} />
        </Field>
      </div>

      <div className="mt-5 flex justify-between">
        <div>{isEdit && <Button variant="danger" onClick={() => void remove()}>Delete voucher</Button>}</div>
        <div className="flex gap-2">
          {isEdit && <Button onClick={() => nav.back()}>Cancel</Button>}
          <Button variant="primary" data-testid="btn-save-stock-lines" disabled={saving} onClick={() => void save()}>
            {isEdit ? 'Save changes' : 'Save'} ⌘↵
          </Button>
        </div>
      </div>
    </Panel>
  )
}
