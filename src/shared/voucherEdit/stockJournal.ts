// Stock journal — godown transfer mode (WP 2.3): rows of item · from godown · to godown · qty ·
// batch (· serials). Each row posts a PAIR of inventory lines on the same item — out of the
// source godown, then into the destination — with the inward line valued at exactly the engine
// cost of the outward line (priced via stock:costAsOf as of the voucher's position), so the
// transfer conserves the item's value. The free-form adjustment mode reuses the generic
// stock-lines builder (./stockLines). Kept in its own file so it never collides with the
// manufacture mode (./manufacture).

import type { Voucher } from '../domain'
import {
  confirmRoundTrip, EMPTY_PASSTHROUGH, passthroughOf, qtyText,
  type BuildResult, type HeaderPassthrough, type Representation, type VoucherPayload
} from './payload'

/**
 * The shape the engine's 'transfer' costing rule (WP 2.4) applies to: no ledger lines, and the
 * inventory lines are (out of godown A, into godown B) pairs of the same item, quantity, batch
 * and amount, A ≠ B, both godowns set — exactly what the transfer form saves. saveVoucher marks
 * a stock journal of this shape in `stock_transfers`.
 */
export function isGodownTransferShape(v: {
  lines: readonly unknown[]
  inventory: readonly {
    stockItemId: number; godownId: number | null; batchId?: number | null; qtyMilli: number; amount: number
    direction: 'in' | 'out'; isAbsolute?: boolean; discountPaise?: number
  }[]
}): boolean {
  const inv = v.inventory
  if (v.lines.length > 0 || inv.length === 0 || inv.length % 2 !== 0) return false
  for (let i = 0; i < inv.length; i += 2) {
    const out = inv[i]!
    const into = inv[i + 1]!
    const ok =
      out.direction === 'out' && into.direction === 'in' && !out.isAbsolute && !into.isAbsolute &&
      out.stockItemId === into.stockItemId && out.qtyMilli === into.qtyMilli && (out.batchId ?? null) === (into.batchId ?? null) &&
      out.amount === into.amount && (out.discountPaise ?? 0) === 0 && (into.discountPaise ?? 0) === 0 &&
      out.godownId != null && into.godownId != null && out.godownId !== into.godownId && out.qtyMilli > 0
    if (!ok) return false
  }
  return true
}

export interface TransferRowState {
  itemId: number | null
  fromGodownId: number | null
  toGodownId: number | null
  qtyText: string
  batchId: number | null
  serials?: string[]
  /** Alteration only: the saved transfer value (paise) and the item/qty it was priced for —
   *  re-used while those are unchanged so re-saving doesn't revalue the transfer. */
  frozen?: { itemId: number; qtyMilli: number; amount: number } | null
}

export interface TransferFormState {
  date: string
  /** '' = auto-assign. */
  number: string
  rows: TransferRowState[]
  narration: string
  passthrough: HeaderPassthrough
  isOptional: boolean | undefined
}

export const blankTransferRow = (): TransferRowState => ({
  itemId: null, fromGodownId: null, toGodownId: null, qtyText: '', batchId: null, frozen: null
})

export function emptyTransferState(date: string): TransferFormState {
  return { date, number: '', rows: [blankTransferRow()], narration: '', passthrough: EMPTY_PASSTHROUGH, isOptional: undefined }
}

export const transferQtyMilli = (r: TransferRowState): number => Math.round(parseFloat(r.qtyText || '0') * 1000)

/** Rows that will post (an item picked). */
export const transferRowsToPost = (state: TransferFormState): TransferRowState[] => state.rows.filter((r) => r.itemId != null)

/** The frozen value of a row when it still applies (same item and quantity), else null. */
export function frozenTransferCost(r: TransferRowState): number | null {
  const f = r.frozen
  return f && f.itemId === r.itemId && f.qtyMilli === transferQtyMilli(r) ? f.amount : null
}

/**
 * Outward lines to price, one per posting row in order (for stock:costAsOf `lines`) — the engine
 * consumes the same item sequentially, exactly as the saved voucher will.
 */
export function transferCostQuery(state: TransferFormState): { itemId: number; qtyMilli: number }[] {
  return transferRowsToPost(state).map((r) => ({ itemId: r.itemId!, qtyMilli: Math.max(0, transferQtyMilli(r)) }))
}

/**
 * Build the save payload. `costs[k]` is the engine cost (paise) of posting row k's outward line
 * (rows with a still-valid frozen value use that instead).
 */
export function buildTransferPayload(
  state: TransferFormState,
  opts: { voucherTypeId: number; costs: readonly number[]; itemName?: (id: number) => string }
): BuildResult {
  const rows = transferRowsToPost(state)
  if (rows.length === 0) return { ok: false, error: 'Add at least one item to transfer' }
  const inventory: VoucherPayload['inventory'] = []
  for (const [k, r] of rows.entries()) {
    const name = opts.itemName?.(r.itemId!) || 'An item'
    const qtyMilli = transferQtyMilli(r)
    if (!Number.isFinite(qtyMilli) || qtyMilli <= 0) return { ok: false, error: `${name}: enter a positive quantity` }
    if (r.fromGodownId == null || r.toGodownId == null) return { ok: false, error: `${name}: pick both godowns` }
    if (r.fromGodownId === r.toGodownId) return { ok: false, error: `${name}: the two godowns are the same` }
    const amount = frozenTransferCost(r) ?? opts.costs[k]
    if (amount == null || !Number.isFinite(amount)) return { ok: false, error: 'Waiting for the stock cost — try again' }
    const value = Math.max(0, Math.round(amount))
    const ratePaise = Math.round((value * 1000) / qtyMilli)
    const serials = r.serials && r.serials.length > 0 ? { serials: [...r.serials] } : {}
    const line = { stockItemId: r.itemId!, batchId: r.batchId, qtyMilli, ratePaise, discountPaise: 0, amount: value, isAbsolute: false, ...serials }
    inventory.push({ ...line, godownId: r.fromGodownId, direction: 'out' as const })
    inventory.push({ ...line, godownId: r.toGodownId, direction: 'in' as const })
  }
  return {
    ok: true,
    payload: {
      voucherTypeId: opts.voucherTypeId,
      date: state.date,
      number: state.number.trim() || undefined,
      ...state.passthrough,
      partyLedgerId: null,
      narration: state.narration.trim() || null,
      ...(state.isOptional !== undefined ? { isOptional: state.isOptional } : {}),
      lines: [],
      inventory,
      billRefs: [],
      tds: null
    }
  }
}

const sameSerials = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((s, i) => s === y[i])
}

/** Can the transfer form show this stock journal and save it back unchanged? Pairs of
 *  (out of godown A, into godown B) lines of one item, same qty / batch / value / serials, no
 *  ledger lines. Anything else falls back to the generic stock-lines editor. */
export function transferRepresentation(v: Voucher): Representation<TransferFormState> {
  if (v.lines.length > 0 || v.billRefs.length > 0 || v.tds || v.partyLedgerId != null) {
    return { ok: false, reason: 'it carries ledger lines' }
  }
  const inv = v.inventory
  if (inv.length === 0 || inv.length % 2 !== 0) return { ok: false, reason: 'its lines are not out/in pairs' }
  const rows: TransferRowState[] = []
  for (let i = 0; i < inv.length; i += 2) {
    const out = inv[i]!
    const into = inv[i + 1]!
    const paired =
      out.direction === 'out' && into.direction === 'in' && !out.isAbsolute && !into.isAbsolute &&
      out.stockItemId === into.stockItemId && out.qtyMilli === into.qtyMilli && out.batchId === into.batchId &&
      out.amount === into.amount && out.discountPaise === 0 && into.discountPaise === 0 &&
      out.godownId != null && into.godownId != null && out.godownId !== into.godownId && sameSerials(out.serials, into.serials)
    if (!paired) return { ok: false, reason: 'its lines are not same-item godown transfers' }
    rows.push({
      itemId: out.stockItemId,
      fromGodownId: out.godownId,
      toGodownId: into.godownId,
      qtyText: qtyText(out.qtyMilli),
      batchId: out.batchId,
      ...(out.serials && out.serials.length > 0 ? { serials: [...out.serials] } : {}),
      frozen: { itemId: out.stockItemId, qtyMilli: out.qtyMilli, amount: out.amount }
    })
  }
  const state: TransferFormState = {
    date: v.date,
    number: v.number,
    rows,
    narration: v.narration ?? '',
    passthrough: passthroughOf(v),
    isOptional: v.isOptional
  }
  return confirmRoundTrip(v, state, buildTransferPayload(state, { voucherTypeId: v.voucherTypeId, costs: [] }))
}
