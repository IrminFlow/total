import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Voucher } from '@shared/domain'
import { formatPaise } from '@shared/money'
import {
  blankStockLineRow, buildStockLinesPayload, recomputeStockLineAmount,
  type StockLineRowState, type StockLinesFormState
} from '@shared/voucherEdit'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, isAnyModalOpen, Panel, TextInput, inputCls } from '../../components/ui'
import { ItemPicker } from '../../components/pickers'
import { confirmDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { nextLineKey, useAlterationDirty, useLeaveAfterSave } from './hooks'

// ---------- generic stock lines (lossless fallback for stock journals / physical stock) ----------
// One row per inventory line: item, in/out, qty, rate, amount, godown, batch. Used when a saved
// stock voucher can't be shown by the manufacture or physical-count form (transfers, imported
// Tally journals, hand-made lines). Godown and batch are shown, not picked (pickers land with the
// stock-visibility work); hidden per-line fields (discount, physical-count flag) and any ledger
// lines ride along untouched. State → payload: @shared/voucherEdit/stockLines.

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
  initial,
  fallbackReason,
  legacy = false,
  formName
}: {
  typeId: number
  voucherId: number
  voucher: Voucher
  initial: StockLinesFormState
  fallbackReason: string | null
  /** A stock journal saved before the Manufacture screen (no manufacture_details row):
   *  `fallbackReason` is then the banner text itself. */
  legacy?: boolean
  /** The specialised form this voucher couldn't open in ('manufacture', 'physical-count'). */
  formName: string
}): React.JSX.Element {
  const { workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [date, setDate] = useState(initial.date)
  const [number, setNumber] = useState(initial.number)
  const [rows, setRows] = useState<StockRow[]>(() => [...initial.rows.map((r) => ({ ...r, key: nextLineKey(), amountRev: 0 })), blankRow()])
  const [narration, setNarration] = useState(initial.narration)
  const [saving, setSaving] = useState(false)
  const { saved, leave } = useLeaveAfterSave()

  const { data: godowns } = useQuery({ queryKey: ['godowns'], queryFn: api.godowns.list })
  const { data: batches } = useQuery({ queryKey: ['batches', 'all'], queryFn: () => api.batches.list() })
  const godownName = (id: number | null): string => (id == null ? '—' : (godowns?.find((g) => g.id === id)?.name ?? `#${id}`))
  const batchName = (id: number | null): string => (id == null ? '—' : (batches?.find((b) => b.id === id)?.name ?? `#${id}`))

  const formState: StockLinesFormState = useMemo(
    () => ({ ...initial, date, number, narration, rows: rows.map(({ key: _k, amountRev: _r, ...r }) => r) }),
    [initial, date, number, narration, rows]
  )
  const alterationDirty = useAlterationDirty(voucher, buildStockLinesPayload(formState, { voucherTypeId: typeId }))
  useUnsavedGuard(!saved && alterationDirty)

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
      toast.push('success', `${result.number} altered`)
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      leave()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, formState, typeId, toast, voucherId, setWorkingDate, date, queryClient, leave])

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
      {fallbackReason && legacy && (
        <p
          data-testid="banner-stock-lines-legacy"
          className="mb-4 rounded-md border border-line bg-panel2 px-3 py-2 text-body-sm text-ink"
        >
          {fallbackReason}. Every line is kept exactly as saved unless you change it.
        </p>
      )}
      {fallbackReason && !legacy && (
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
        <Field label="No.">
          <TextInput value={number} onChange={(e) => setNumber(e.target.value)} className="num" />
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
            <th className="w-24">Godown</th>
            <th className="w-20">Batch</th>
          </tr>
        </thead>
        <tbody data-testid="rows-stock-lines">
          {rows.map((r, i) => (
            <tr key={r.key}>
              <td>
                <ItemPicker
                  value={r.itemId}
                  onPick={(id) => setRow(i, id === r.itemId ? { itemId: id } : { itemId: id, batchId: null })}
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
              <td className="text-small text-muted">{r.itemId != null ? godownName(r.godownId) : ''}</td>
              <td className="text-small text-muted">{r.itemId != null ? batchName(r.batchId) : ''}</td>
            </tr>
          ))}
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
        <Button variant="danger" onClick={() => void remove()}>Delete voucher</Button>
        <div className="flex gap-2">
          <Button onClick={() => nav.back()}>Cancel</Button>
          <Button variant="primary" data-testid="btn-save-stock-lines" disabled={saving} onClick={() => void save()}>
            Save changes ⌘↵
          </Button>
        </div>
      </div>
    </Panel>
  )
}
