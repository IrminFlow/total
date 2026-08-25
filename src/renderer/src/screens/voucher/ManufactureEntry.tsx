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

  const qty = Number(qtyText) || 0
  // Quantities are integer thousandths, and the explosion is done in main on integers — the
  // renderer's job is to turn the typed number into one and never to do the arithmetic itself.
  const qtyMilli = Math.round(qty * 1000)
  const { data: bom } = useQuery({
    queryKey: ['bom', producedId, 'detail'],
    queryFn: () => api.bom.detail(producedId!),
    enabled: !!producedId
  })
  // Keyed on the quantity the user is typing, so a stale key is a different key, never a wrong
  // answer. Sub-assemblies are exploded down to raw materials here (#126).
  const { data: requirement, error: explodeError } = useQuery({
    queryKey: ['bom', producedId, 'explode', qtyMilli],
    queryFn: () => api.bom.explode(producedId!, qtyMilli),
    enabled: !!producedId && qtyMilli > 0,
    retry: false
  })
  const { data: stock } = useQuery({
    queryKey: ['stockSummary', to],
    queryFn: () => api.reports.stockSummary(to)
  })

  const extraPct = Number(extraPctText) || 0
  const avgCost = (itemId: number): number => {
    const row = stock?.find((s) => s.stockItemId === itemId)
    if (!row || row.closingQtyMilli <= 0) return 0
    return Math.round((row.closingValue * 1000) / row.closingQtyMilli) // paise per whole unit
  }

  // What is actually issued from stock: the leaves. A sub-assembly is a thing this voucher makes
  // on the way past, not a thing it buys, so consuming it would double-count its own materials.
  const consumption = (requirement?.raw ?? []).map((line) => {
    const rate = avgCost(line.componentId)
    return { ...line, useMilli: line.qtyMilli, rate, amount: Math.round((line.qtyMilli * rate) / 1000) }
  })
  const consumedTotal = consumption.reduce((s, c) => s + c.amount, 0)
  const producedValue = Math.round(consumedTotal * (1 + extraPct / 100))

  const save = async (): Promise<void> => {
    if (saving) return
    if (!producedId) return void toast.push('error', 'Pick the item to produce')
    if (!bom?.lines.length) return void toast.push('error', 'This item has no bill of materials — set it in Masters → Stock items')
    if (qty <= 0) return void toast.push('error', 'Quantity must be positive')
    if (explodeError) return void toast.push('error', (explodeError as Error).message)
    if (!consumption.length) return void toast.push('error', 'Nothing to consume — the bill of materials explodes to nothing')
    setSaving(true)
    try {
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
        gstRegistrationId: null,
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

      {producedId && !bom?.lines.length && (
        <p className="mt-3 text-body-sm text-accent">
          No bill of materials on this item yet — add components in Masters → Stock items → Edit.
        </p>
      )}

      {explodeError && (
        <p className="mt-3 text-body-sm text-cr">{(explodeError as Error).message}</p>
      )}

      {/* The structure, before the costing: a sub-assembly is shown with what it is made of
          indented under it, because a parts list that hides a level is a parts list nobody can
          check against the shop floor. */}
      {(requirement?.rows.length ?? 0) > 0 &&
        requirement!.rows.some((r) => r.depth > 1 || r.scrapBp > 0 || r.parentYieldBp !== 10000) && (
        <table className="ledger-table mt-4">
          <thead>
            <tr>
              <th scope="col">Structure for {qty} {items.find((i) => i.id === producedId)?.name ?? ''}</th>
              <th scope="col" className="r w-32">Qty</th>
              <th scope="col" className="r w-24">Scrap</th>
              <th scope="col" className="r w-24">Yield</th>
            </tr>
          </thead>
          <tbody>
            {requirement!.rows.map((r, i) => (
              <tr key={`${r.componentId}-${i}`}>
                <td>
                  <span style={{ paddingLeft: `${(r.depth - 1) * 16}px` }}>
                    {r.componentName}
                    {r.isSubAssembly && (
                      <span className="ml-2 rounded-md bg-accentbar px-1.5 py-0.5 text-caption text-onaccent">
                        sub-assembly
                      </span>
                    )}
                  </span>
                </td>
                <td className="r num">{r.qtyMilli / 1000} {r.unitSymbol}</td>
                <td className="r num text-muted">{r.scrapBp ? `${r.scrapBp / 100}%` : '–'}</td>
                <td className="r num text-muted">{r.parentYieldBp === 10000 ? '–' : `${r.parentYieldBp / 100}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {consumption.length > 0 && (
        <table className="ledger-table mt-4">
          <thead>
            <tr>
              <th scope="col">Consumes (raw materials)</th>
              <th scope="col" className="r w-32">Qty</th>
              <th scope="col" className="r w-32">Avg cost</th>
              <th scope="col" className="r w-36">Amount</th>
            </tr>
          </thead>
          <tbody>
            {consumption.map((c) => (
              <tr key={c.componentId}>
                <td>
                  {c.componentName}
                  {c.rate === 0 && <span className="ml-2 text-caption text-muted">no stock cost — purchase it first</span>}
                </td>
                <td className="r num">{c.useMilli / 1000} {c.unitSymbol}</td>
                {/* The cost is the cell that is wrong, so the cost is the cell that is marked —
                    the component's name and quantity are both perfectly correct. */}
                <td className={`r ${c.rate === 0 ? 'text-cr font-semibold' : ''}`}><Money paise={c.rate} /></td>
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
