import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatPaise } from '@shared/money'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Button, DateInput, Field, Money, Panel, TextInput, inputCls } from '../../components/ui'
import { ItemPicker, useStockItems } from '../../components/pickers'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { useVoucherNumber } from './hooks'

// ---------- manufacture mode (stock journal via BOM) ----------

export function ManufactureEntry({ typeId }: { typeId: number }): React.JSX.Element {
  const { workingDate, setWorkingDate, to } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const [date, setDate] = useState(workingDate)
  const [producedId, setProducedId] = useState<number | null>(null)
  const [qtyText, setQtyText] = useState('1')
  const [extraPctText, setExtraPctText] = useState('0')
  const [saving, setSaving] = useState(false)
  const number = useVoucherNumber(typeId, date)

  // Same content-based dirtiness as the sibling entry modes (InvoiceEntry/PhysicalStockEntry):
  // anything the user typed beyond the pristine defaults registers the unsaved-entry guard.
  useUnsavedGuard(producedId != null || qtyText !== '1' || extraPctText !== '0')

  const { data: bom } = useQuery({
    queryKey: ['bom', producedId],
    queryFn: () => api.bom.get(producedId!),
    enabled: !!producedId
  })
  const { data: stock } = useQuery({
    queryKey: ['stockSummary', to],
    queryFn: () => api.reports.stockSummary(to)
  })

  const qty = Number(qtyText) || 0
  const extraPct = Number(extraPctText) || 0
  const avgCost = (itemId: number): number => {
    const row = stock?.find((s) => s.stockItemId === itemId)
    if (!row || row.closingQtyMilli <= 0) return 0
    return Math.round((row.closingValue * 1000) / row.closingQtyMilli) // paise per whole unit
  }

  const consumption = (bom ?? []).map((line) => {
    const useMilli = Math.round(line.qtyMilliPerUnit * qty)
    const rate = avgCost(line.componentId)
    return { ...line, useMilli, rate, amount: Math.round((useMilli * rate) / 1000) }
  })
  const consumedTotal = consumption.reduce((s, c) => s + c.amount, 0)
  const producedValue = Math.round(consumedTotal * (1 + extraPct / 100))

  const save = async (): Promise<void> => {
    if (saving) return
    if (!producedId) return void toast.push('error', 'Pick the item to produce')
    if (!bom?.length) return void toast.push('error', 'This item has no bill of materials — set it in Masters → Stock items')
    if (qty <= 0) return void toast.push('error', 'Quantity must be positive')
    setSaving(true)
    try {
      const qtyMilli = Math.round(qty * 1000)
      const saved = await api.vouchers.save({
        voucherTypeId: typeId,
        date,
        partyLedgerId: null,
        narration: `Manufactured ${qty} × ${items.find((i) => i.id === producedId)?.name ?? ''}`.trim(),
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        posOverride: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [],
        inventory: [
          ...consumption.map((c) => ({
            stockItemId: c.componentId,
            godownId: null,
            qtyMilli: c.useMilli,
            ratePaise: c.rate,
            amount: c.amount,
            direction: 'out' as const
          })),
          {
            stockItemId: producedId,
            godownId: null,
            qtyMilli,
            ratePaise: Math.round((producedValue * 1000) / qtyMilli),
            amount: producedValue,
            direction: 'in' as const
          }
        ],
        billRefs: [],
        tds: null
      })
      toast.push('success', `Manufacture ${saved.number} saved — ${formatPaise(producedValue, { symbol: true })} into stock`)
      setWorkingDate(date)
      setProducedId(null)
      setQtyText('1')
      setExtraPctText('0') // back to pristine so the unsaved guard releases after save
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
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
            <TextInput value={qtyText} onChange={(e) => setQtyText(e.target.value)} className="num text-right" />
          </Field>
          <Field label="Overhead %">
            <TextInput value={extraPctText} onChange={(e) => setExtraPctText(e.target.value)} className="num text-right" />
          </Field>
        </div>
      </div>

      {producedId && !bom?.length && (
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
              <th className="r w-32">Avg cost</th>
              <th className="r w-36">Amount</th>
            </tr>
          </thead>
          <tbody>
            {consumption.map((c) => (
              <tr key={c.componentId} className={c.rate === 0 ? 'text-cr' : ''}>
                <td>
                  {c.componentName}
                  {c.rate === 0 && <span className="ml-2 text-caption">no stock cost — purchase it first</span>}
                </td>
                <td className="r num">{c.useMilli / 1000} {c.unitSymbol}</td>
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

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={() => nav.back()}>Cancel</Button>
        <Button variant="primary" data-testid="btn-save-manufacture" disabled={saving} onClick={() => void save()}>
          Save manufacture
        </Button>
      </div>
    </Panel>
  )
}
