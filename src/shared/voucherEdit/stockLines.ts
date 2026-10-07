// Generic stock-lines editor: the lossless fallback for stock journals (and physical-stock
// vouchers) that the manufacture / physical-count forms can't express — transfers, imported
// Tally journals, arbitrary in/out lines. One row per inventory line; every stored field rides
// along, and any ledger lines / header fields are posted back untouched.

import type { Voucher } from '../domain'
import {
  EMPTY_PASSTHROUGH, inventoryToPayload, passthroughOf, qtyText, voucherToPayload,
  type BuildResult, type HeaderPassthrough, type VoucherPayload
} from './payload'

export interface StockLineRowState {
  itemId: number | null
  direction: 'in' | 'out'
  qtyText: string
  /** Paise per unit. */
  rate: number | null
  /** Paise; recomputed from qty × rate − discount when either changes, else as stored. */
  amount: number | null
  godownId: number | null
  batchId: number | null
  discountPaise: number
  isAbsolute: boolean
  /** Serial numbers (serial-tracked items, WP 2.3). */
  serials?: string[]
}

export interface StockLinesFormState {
  date: string
  number: string
  rows: StockLineRowState[]
  narration: string
  passthrough: HeaderPassthrough
  isOptional: boolean | undefined
  /** Ledger lines / bills / TDS of the saved voucher — not editable here, kept verbatim. */
  ledgerLines: VoucherPayload['lines']
  billRefs: VoucherPayload['billRefs']
  tds: VoucherPayload['tds']
}

export const blankStockLineRow = (direction: 'in' | 'out' = 'out'): StockLineRowState => ({
  itemId: null, direction, qtyText: '', rate: null, amount: null, godownId: null, batchId: null, discountPaise: 0, isAbsolute: false
})

export function emptyStockLinesState(date: string): StockLinesFormState {
  return {
    date, number: '', rows: [blankStockLineRow()], narration: '', passthrough: EMPTY_PASSTHROUGH, isOptional: undefined,
    ledgerLines: [], billRefs: [], tds: null
  }
}

/** Row patch for a qty/rate edit: amount follows qty × rate − discount (never below 0). */
export function recomputeStockLineAmount(r: StockLineRowState): number | null {
  const qtyMilli = Math.round(parseFloat(r.qtyText || '0') * 1000)
  if (!Number.isFinite(qtyMilli) || r.rate == null) return r.amount
  return Math.max(0, Math.round((qtyMilli * r.rate) / 1000) - r.discountPaise)
}

export function buildStockLinesPayload(state: StockLinesFormState, opts: { voucherTypeId: number }): BuildResult {
  const inventory: VoucherPayload['inventory'] = []
  for (const r of state.rows) {
    if (r.itemId == null) continue
    const qtyMilli = Math.round(parseFloat(r.qtyText || '0') * 1000)
    if (!Number.isFinite(qtyMilli) || qtyMilli < 0 || (!r.isAbsolute && qtyMilli === 0)) {
      return { ok: false, error: 'Every stock line needs a positive quantity' }
    }
    inventory.push({
      stockItemId: r.itemId,
      godownId: r.godownId,
      batchId: r.batchId,
      qtyMilli,
      ratePaise: r.rate ?? 0,
      discountPaise: r.discountPaise,
      amount: r.amount ?? 0,
      direction: r.direction,
      isAbsolute: r.isAbsolute,
      ...(r.serials && r.serials.length > 0 ? { serials: [...r.serials] } : {})
    })
  }
  if (inventory.length === 0) return { ok: false, error: 'Add at least one stock line' }
  return {
    ok: true,
    payload: {
      voucherTypeId: opts.voucherTypeId,
      date: state.date,
      number: state.number.trim() || undefined,
      ...state.passthrough,
      narration: state.narration.trim() || null,
      ...(state.isOptional !== undefined ? { isOptional: state.isOptional } : {}),
      lines: state.ledgerLines.map((l) => ({ ...l, costAllocations: (l.costAllocations ?? []).map((a) => ({ ...a })) })),
      inventory,
      billRefs: state.billRefs.map((r) => ({ ...r })),
      tds: state.tds ? { ...state.tds } : null
    }
  }
}

export function stockLinesStateFromVoucher(v: Voucher): StockLinesFormState {
  const p = voucherToPayload(v)
  return {
    date: v.date,
    number: v.number,
    rows: v.inventory.map((l) => {
      const x = inventoryToPayload(l)
      return {
        itemId: x.stockItemId,
        direction: x.direction,
        qtyText: qtyText(x.qtyMilli),
        rate: x.ratePaise,
        amount: x.amount,
        godownId: x.godownId,
        batchId: x.batchId ?? null,
        discountPaise: x.discountPaise ?? 0,
        isAbsolute: x.isAbsolute ?? false,
        ...(x.serials ? { serials: [...x.serials] } : {})
      }
    }),
    narration: v.narration ?? '',
    passthrough: passthroughOf(v),
    isOptional: v.isOptional,
    ledgerLines: p.lines,
    billRefs: p.billRefs,
    tds: p.tds
  }
}
