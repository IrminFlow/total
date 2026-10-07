// The item line grid (WP 2.5b, design §5.1): item picker, qty, rate, discount, GST %, amount and
// the per-line stock detail (godown / batch / serials). Extracted from InvoiceEntry unchanged —
// every testid, keyboard path (⌥D, the TypeAhead pickers) and the price-level autofill are the
// invoice's — so the delivery challan / GRN screen shares it. The parent owns the rows; this
// component only renders them and reports edits.
import { Fragment, useMemo, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { InvoiceRowState } from '@shared/voucherEdit'
import { api } from '../../lib/client'
import { AmountInput, LineTableScroller, Money, inputCls } from '../../components/ui'
import { ItemPicker, useStockItems } from '../../components/pickers'
import { useFeatures } from '../../lib/useFeatures'
import { nextLineKey } from './hooks'
import { LineDetailToggle, LineStockDetail, LineStockSummary, useLineDetails } from './LineStockDetail'

export interface ItemRow extends InvoiceRowState {
  /** Stable React key — survives the trailing-blank-row insertions (never an array index). */
  key: number
}

export const blankItemRow = (): ItemRow => ({
  key: nextLineKey(), itemId: null, qtyText: '', rate: null, discount: null, godownId: null, batchId: null
})

export interface ItemLineGridProps {
  rows: ItemRow[]
  setRow: (i: number, patch: Partial<ItemRow>) => void
  /** For the asynchronous price-level autofill (matched by row key, never by index). */
  setRows: Dispatch<SetStateAction<ItemRow[]>>
  /** Goods direction — the stock detail's batch create / serial picker follow it. */
  direction: 'in' | 'out'
  /** The party's price list: fills an empty Rate cell when an item is picked. */
  priceLevelId: number | null
  /** A foreign currency is active (price-list rates are ₹ — no autofill then). */
  fxActive: boolean
  date: string
  /** Altering: lets an outward line re-pick the serials it already took. */
  voucherId?: number
  /** GST % shown for an item without its own rate (the invoice's sales / purchase ledger). */
  fallbackGstRate?: number | null
  onCreateItem: (name: string, row: number) => void
  /**
   * WP 2.5b: a row drawn from a stock-moving source (a challan / GRN line) — its goods already
   * moved, so item, godown, batch and serials are read-only and the quantity can't exceed what
   * is still pending on the source. Null = an ordinary row.
   */
  lockedBySource?: (row: ItemRow) => { label: string; maxQtyMilli: number; lockDetail: boolean } | null
  /** Extra content under a row's item cell (the "from DC-12" chip). */
  rowNote?: (row: ItemRow, i: number) => ReactNode
  /** Remove a row (shown for rows drawn from a source, which have no blank-out path). */
  onRemoveRow?: (i: number) => void
  /** WP 2.5c: false hides the per-line stock detail (godown / batch / serials) — quotations and
   *  orders move no goods. Default: shown whenever inventory is on. */
  stockDetail?: boolean
}

export function ItemLineGrid({
  rows, setRow, setRows, direction, priceLevelId, fxActive, date, voucherId, fallbackGstRate, onCreateItem,
  lockedBySource, rowNote, onRemoveRow, stockDetail = true
}: ItemLineGridProps): React.JSX.Element {
  const features = useFeatures()
  const stockDetailOn = features.inventory && stockDetail
  const items = useStockItems()
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const details = useLineDetails()
  const unitOf = (itemId: number | null): string => {
    if (!itemId || !units) return ''
    const item = itemMap.get(itemId)
    return units.find((u) => u.id === item?.unitId)?.symbol ?? ''
  }

  return (
    // Long invoices scroll inside a capped container instead of pushing the totals
    // off-screen. Short ones stay unwrapped: any overflow container would clip the
    // absolutely-positioned TypeAhead dropdowns.
    <LineTableScroller active={rows.length > 8} className="mt-4">
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="r w-28">Qty</th>
            <th className="r w-32">Rate</th>
            <th className="r w-28">Disc.</th>
            <th className="r w-24">GST %</th>
            <th className="r w-36">Amount</th>
            {stockDetailOn && <th className="w-6"><span className="sr-only">Stock details</span></th>}
          </tr>
        </thead>
        <tbody data-testid="rows-invoice-lines">
          {rows.map((r, i) => {
            const item = r.itemId ? itemMap.get(r.itemId) : null
            const qty = parseFloat(r.qtyText || '0')
            const amount =
              item && qty > 0 && r.rate != null ? Math.max(0, Math.round(qty * r.rate) - (r.discount ?? 0)) : 0
            const locked = lockedBySource?.(r) ?? null
            const detailOpen = stockDetailOn && details.isOpen(r.key, item)
            return (
              <Fragment key={r.key}>
              <tr onKeyDown={stockDetailOn ? details.onRowKeyDown(r.key) : undefined} data-line-key={r.key}>
                <td>
                  {locked ? (
                    <div className="flex items-center gap-1.5">
                      <div className={`${inputCls} flex-1 bg-panel2 text-ink`} data-testid="line-item-locked" title={`Goods moved on ${locked.label}`}>
                        {item?.name ?? ''}
                      </div>
                      {onRemoveRow && (
                        <button
                          type="button"
                          className="shrink-0 px-1 text-caption text-muted hover:text-cr"
                          aria-label="Remove line"
                          data-testid="btn-line-remove"
                          onClick={() => onRemoveRow(i)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ) : (
                  <ItemPicker
                    value={r.itemId}
                    onPick={(id) => {
                      // A batch (and serials) belong to one item — a different item can't keep the old line's.
                      setRow(i, id === r.itemId ? { itemId: id } : { itemId: id, batchId: null, serials: undefined })
                      // Price-level autofill: the party's price list fills an empty Rate cell.
                      // Price-list rates are ₹, so skip while a foreign currency is active.
                      if (id != null && r.rate == null && !fxActive && priceLevelId != null) {
                        const rowKey = r.key
                        void api.priceLevels
                          .rateFor(priceLevelId, id, date)
                          .then((rate) => {
                            if (rate == null) return
                            setRows((rs) =>
                              rs.map((row) =>
                                row.key === rowKey && row.itemId === id && row.rate == null ? { ...row, rate } : row
                              )
                            )
                          })
                          .catch(() => {}) // a missing rate just leaves the cell for the user
                      }
                    }}
                    onCreateRequest={(name) => onCreateItem(name, i)}
                  />
                  )}
                  {rowNote?.(r, i)}
                </td>
                <td className="r">
                  <div className="flex items-center gap-1.5">
                    <input
                      className={`${inputCls} num text-right`}
                      data-testid="input-line-qty"
                      value={r.qtyText}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(e) => {
                        // A drawn-down row can't take more than the source still has pending.
                        const v = e.target.value
                        const q = Math.round(parseFloat(v || '0') * 1000)
                        setRow(i, { qtyText: locked && Number.isFinite(q) && q > locked.maxQtyMilli ? String(locked.maxQtyMilli / 1000) : v })
                      }}
                      title={locked ? `At most ${locked.maxQtyMilli / 1000} (pending on ${locked.label})` : undefined}
                    />
                    <span className="w-8 text-caption text-muted">{unitOf(r.itemId)}</span>
                  </div>
                </td>
                <td className="r">
                  <AmountInput paise={r.rate} onPaise={(p) => setRow(i, { rate: p })} testId="input-line-rate" />
                </td>
                <td className="r">
                  <AmountInput
                    paise={r.discount}
                    onPaise={(p) => setRow(i, { discount: p })}
                    placeholder="0"
                    testId="input-line-discount"
                  />
                </td>
                <td className="r">
                  <span className="num text-body-sm text-muted">{item ? `${item.gstRate ?? fallbackGstRate ?? 0}%` : ''}</span>
                </td>
                <td className="r">
                  <Money paise={amount} className="text-body" />
                  {(!detailOpen || locked?.lockDetail) && stockDetailOn && <div><LineStockSummary fields={r} /></div>}
                </td>
                {stockDetailOn && (
                  <td>
                    <LineDetailToggle open={detailOpen} onToggle={() => details.toggle(r.key)} fields={r} disabled={!item || !!locked?.lockDetail} />
                  </td>
                )}
              </tr>
              {detailOpen && item && !locked?.lockDetail && (
                <tr className="line-detail-row" data-testid="row-line-detail">
                  <td colSpan={7} className="!pt-0">
                    <LineStockDetail
                      item={item}
                      direction={direction}
                      qtyMilli={Math.round(qty * 1000) || 0}
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
    </LineTableScroller>
  )
}
