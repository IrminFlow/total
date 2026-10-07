import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Voucher } from '@shared/domain'
import { formatPaise } from '@shared/money'
import { buildManufacturePayload, computeManufacture, emptyManufactureState, type ManufactureFormState } from '@shared/voucherEdit'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Button, DateInput, Field, isAnyModalOpen, Money, Panel, TextInput, inputCls } from '../../components/ui'
import { ItemPicker, useStockItems } from '../../components/pickers'
import { confirmDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { useAlterationDirty, useLeaveAfterSave, useVoucherNumber } from './hooks'

// ---------- manufacture mode (stock journal via BOM) ----------
// State → payload lives in @shared/voucherEdit/manufacture. An alteration (`initial`, from
// planVoucherEdit) keeps the saved component rates, godowns/batches and narration.

export function ManufactureEntry({
  typeId,
  voucherId,
  voucher,
  initial
}: {
  typeId: number
  voucherId?: number
  voucher?: Voucher
  initial?: ManufactureFormState
}): React.JSX.Element {
  const isEdit = voucherId != null
  const { workingDate, setWorkingDate, to } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const [base] = useState(() => initial ?? emptyManufactureState(workingDate))
  const [date, setDate] = useState(base.date)
  const [producedId, setProducedId] = useState<number | null>(base.producedId)
  const [qtyText, setQtyText] = useState(base.qtyText)
  const [extraPctText, setExtraPctText] = useState(base.extraPctText)
  const [saving, setSaving] = useState(false)
  const suggestedNumber = useVoucherNumber(typeId, date, voucherId)
  const number = isEdit ? base.number : suggestedNumber
  const { saved, leave } = useLeaveAfterSave()

  const { data: bom } = useQuery({
    queryKey: ['bom', producedId],
    queryFn: () => api.bom.get(producedId!),
    enabled: !!producedId
  })
  const { data: stock } = useQuery({
    queryKey: ['stockSummary', to],
    queryFn: () => api.stock.summary(to)
  })

  const avgCost = useCallback(
    (itemId: number): number => {
      const row = stock?.find((s) => s.stockItemId === itemId)
      if (!row || row.closingQtyMilli <= 0) return 0
      return Math.round((row.closingValue * 1000) / row.closingQtyMilli) // paise per whole unit
    },
    [stock]
  )
  const itemName = useCallback((id: number): string => items.find((i) => i.id === id)?.name ?? '', [items])

  const formState: ManufactureFormState = useMemo(
    () => ({
      ...base,
      date,
      number: isEdit ? base.number : '',
      producedId,
      qtyText,
      extraPctText,
      // A custom narration on a loaded journal stays; the automatic one follows item/qty edits.
      autoNarration: base.autoNarration
    }),
    [base, date, isEdit, producedId, qtyText, extraPctText]
  )

  const { extraPct, consumption, producedValue } = computeManufacture(formState, bom ?? [], avgCost)
  const bomLine = new Map((bom ?? []).map((b) => [b.componentId, b]))

  const rebuilt = bom === undefined && producedId != null
    ? null
    : buildManufacturePayload(formState, { voucherTypeId: typeId, bom: bom ?? [], avgCost, itemName })

  // Same content-based dirtiness as the sibling entry modes for a new journal; an alteration is
  // dirty once what it would post differs from the saved voucher (null while the BOM loads).
  const alterationDirty = useAlterationDirty(voucher, isEdit ? rebuilt : null)
  useUnsavedGuard(!saved && (isEdit ? alterationDirty : producedId != null || qtyText !== '1' || extraPctText !== '0'))

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    if (!producedId) return void toast.push('error', 'Pick the item to produce')
    if (!bom?.length) return void toast.push('error', 'This item has no bill of materials — set it in Masters → Stock items')
    const built = buildManufacturePayload(formState, { voucherTypeId: typeId, bom, avgCost, itemName })
    if (!built.ok) return void toast.push('error', built.error)
    setSaving(true)
    try {
      const result = await api.vouchers.save(built.payload, voucherId)
      toast.push(
        'success',
        `Manufacture ${result.number} ${isEdit ? 'altered' : 'saved'} — ${formatPaise(producedValue, { symbol: true })} into stock`
      )
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (isEdit) return leave()
      setProducedId(null)
      setQtyText('1')
      setExtraPctText('0') // back to pristine so the unsaved guard releases after save
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, producedId, bom, formState, typeId, avgCost, itemName, voucherId, toast, isEdit, producedValue, setWorkingDate, date, queryClient, leave])

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
        <Field label="No.">
          <div className={`${inputCls} num bg-panel text-muted`}>{number}</div>
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <Field label="Produce (needs a BOM)">
          <ItemPicker value={producedId} onPick={setProducedId} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Qty">
            <TextInput value={qtyText} onChange={(e) => setQtyText(e.target.value)} className="num text-right" data-testid="input-manufacture-qty" />
          </Field>
          <Field label="Overhead %">
            <TextInput value={extraPctText} onChange={(e) => setExtraPctText(e.target.value)} className="num text-right" />
          </Field>
        </div>
      </div>

      {producedId && bom && !bom.length && (
        <p className="mt-3 text-body-sm text-amber">
          No bill of materials on this item yet — add components in Masters → Stock items → Edit.
        </p>
      )}

      {consumption.length > 0 && (
        <table className="ledger-table mt-4">
          <thead>
            <tr>
              <th>Consumes</th>
              <th className="r w-32">Qty</th>
              <th className="r w-32">{isEdit ? 'Cost' : 'Avg cost'}</th>
              <th className="r w-36">Amount</th>
            </tr>
          </thead>
          <tbody data-testid="rows-manufacture-lines">
            {consumption.map((c) => (
              <tr key={c.componentId} className={c.rate === 0 ? 'text-cr' : ''}>
                <td>
                  {bomLine.get(c.componentId)?.componentName}
                  {c.rate === 0 && <span className="ml-2 text-caption">no stock cost — purchase it first</span>}
                </td>
                <td className="r num">{c.useMilli / 1000} {bomLine.get(c.componentId)?.unitSymbol}</td>
                <td className="r"><Money paise={c.rate} /></td>
                <td className="r"><Money paise={c.amount} /></td>
              </tr>
            ))}
            <tr className="total-row">
              <td colSpan={3}>Into stock (incl. {extraPct}% overhead)</td>
              <td className="r"><Money paise={producedValue} /></td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="mt-5 flex justify-between">
        <div>{isEdit && <Button variant="danger" onClick={() => void remove()}>Delete voucher</Button>}</div>
        <div className="flex gap-2">
          <Button onClick={() => nav.back()}>Cancel</Button>
          <Button variant="primary" data-testid="btn-save-manufacture" disabled={saving} onClick={() => void save()}>
            {isEdit ? 'Save changes' : 'Save manufacture'} ⌘↵
          </Button>
        </div>
      </div>
    </Panel>
  )
}
