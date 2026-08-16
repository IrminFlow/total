import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Button, DateInput, Field, Panel, TextInput, inputCls } from '../../components/ui'
import { ItemPicker, useStockItems } from '../../components/pickers'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { nextLineKey, NUMBER_LOADING, useVoucherNumberField } from './hooks'

// ---------- physical stock mode (counted closing quantities, is_absolute lines) ----------

interface CountRow {
  /** Stable React key (see nextLineKey). */
  key: number
  itemId: number | null
  qtyText: string
}

const blankCountRow = (): CountRow => ({ key: nextLineKey(), itemId: null, qtyText: '' })

/**
 * Physical Stock voucher: each line is the COUNTED closing quantity of an item as on the
 * voucher date (inventory_lines.is_absolute = 1), not a movement — the engine turns the
 * difference from book stock into an adjustment valued at the running average cost
 * (src/shared/valuation.ts). No ledger lines; a count of 0 is a legitimate entry.
 */
export function PhysicalStockEntry({ typeId }: { typeId: number }): React.JSX.Element {
  const { workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const [date, setDate] = useState(workingDate)
  const [rows, setRows] = useState<CountRow[]>(() => [blankCountRow()])
  const [narration, setNarration] = useState('')
  const [saving, setSaving] = useState(false)
  const numberField = useVoucherNumberField(typeId, date)

  // Book stock as on the count date, for the counted-vs-book readout per line.
  const { data: stock } = useQuery({
    queryKey: ['stockSummary', date],
    queryFn: () => api.reports.stockSummary(date)
  })
  const bookOf = useMemo(() => new Map((stock ?? []).map((s) => [s.stockItemId, s])), [stock])
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  useUnsavedGuard(rows.some((r) => r.itemId != null) || narration.trim() !== '')

  const setRow = (i: number, patch: Partial<CountRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      if (next[next.length - 1]!.itemId != null) next.push(blankCountRow())
      return next
    })
  }

  /** Counted qtyMilli for a row, or null while the row isn't complete/parseable. */
  const countedMilli = (r: CountRow): number | null => {
    if (r.itemId == null || r.qtyText.trim() === '') return null
    const n = Number(r.qtyText)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.round(n * 1000)
  }

  const completeRows = rows
    .map((r) => ({ r, qtyMilli: countedMilli(r) }))
    .filter((x): x is { r: CountRow & { itemId: number }; qtyMilli: number } => x.qtyMilli != null)

  const save = async (): Promise<void> => {
    if (saving) return
    if (completeRows.length === 0) return void toast.push('error', 'Count at least one item')
    const seen = new Set<number>()
    for (const { r } of completeRows) {
      if (seen.has(r.itemId)) {
        return void toast.push('error', `${itemMap.get(r.itemId)?.name ?? 'An item'} is counted twice`)
      }
      seen.add(r.itemId)
    }
    setSaving(true)
    try {
      const saved = await api.vouchers.save({
        voucherTypeId: typeId,
        date,
        number: numberField.forPayload || undefined,
        partyLedgerId: null,
        narration: narration.trim() || null,
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
        // rate/amount are 0 by design: the valuation engine prices the adjustment at the
        // running average cost, never off this line.
        inventory: completeRows.map(({ r, qtyMilli }) => ({
          stockItemId: r.itemId,
          godownId: null,
          qtyMilli,
          ratePaise: 0,
          amount: 0,
          direction: 'in' as const,
          isAbsolute: true
        })),
        billRefs: [],
        tds: null
      })
      toast.push('success', `Physical stock ${saved.number} saved — ${completeRows.length} item${completeRows.length > 1 ? 's' : ''} counted`)
      setWorkingDate(date)
      setRows([blankCountRow()])
      setNarration('')
      numberField.reset()
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
        <Field label="No." hint={numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override'}>
          <TextInput
            value={numberField.value === NUMBER_LOADING ? '' : numberField.value}
            onChange={(e) => numberField.onChange(e.target.value)}
            placeholder="Auto"
            className="num"
          />
        </Field>
        <Field label="Date of count">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <div className="col-span-2 flex items-end">
          <p className="text-[11.5px] text-muted">
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
                  <ItemPicker value={r.itemId} onPick={(id) => setRow(i, { itemId: id })} />
                </td>
                <td className="r">
                  {book != null && <span className="num text-[12.5px] text-muted">{book / 1000} {unit}</span>}
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
                    <span className={`num text-[12.5px] ${diff === 0 ? 'text-muted' : diff > 0 ? 'text-dr' : 'text-cr'}`}>
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

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={() => nav.back()}>Cancel</Button>
        <Button variant="primary" data-testid="btn-save-physical" disabled={saving} onClick={() => void save()}>
          Save count
        </Button>
      </div>
    </Panel>
  )
}
