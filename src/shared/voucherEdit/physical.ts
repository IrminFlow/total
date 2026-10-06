// Physical stock mode: each line is the COUNTED closing quantity of an item (is_absolute = 1),
// never a movement; rate/amount are 0 by design (the valuation engine prices the adjustment).

import type { Voucher } from '../domain'
import {
  confirmRoundTrip, EMPTY_PASSTHROUGH, passthroughOf, qtyText,
  type BuildResult, type HeaderPassthrough, type Representation
} from './payload'

export interface CountRowState {
  itemId: number | null
  qtyText: string
  /** Carried from a saved line (no picker in this form yet). */
  godownId: number | null
  batchId: number | null
}

export interface PhysicalFormState {
  date: string
  /** '' = auto-assign. */
  number: string
  rows: CountRowState[]
  narration: string
  passthrough: HeaderPassthrough
  isOptional: boolean | undefined
}

export const blankCountRow = (): CountRowState => ({ itemId: null, qtyText: '', godownId: null, batchId: null })

export function emptyPhysicalState(date: string): PhysicalFormState {
  return { date, number: '', rows: [blankCountRow()], narration: '', passthrough: EMPTY_PASSTHROUGH, isOptional: undefined }
}

/** Counted qtyMilli for a row, or null while the row isn't complete/parseable (0 is a count). */
export function countedMilli(r: CountRowState): number | null {
  if (r.itemId == null || r.qtyText.trim() === '') return null
  const n = Number(r.qtyText)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1000)
}

export function buildPhysicalPayload(
  state: PhysicalFormState,
  opts: { voucherTypeId: number; itemName: (itemId: number) => string }
): BuildResult {
  const complete = state.rows
    .map((r) => ({ r, qtyMilli: countedMilli(r) }))
    .filter((x): x is { r: CountRowState & { itemId: number }; qtyMilli: number } => x.qtyMilli != null)
  if (complete.length === 0) return { ok: false, error: 'Count at least one item' }
  const seen = new Set<number>()
  for (const { r } of complete) {
    if (seen.has(r.itemId)) return { ok: false, error: `${opts.itemName(r.itemId) || 'An item'} is counted twice` }
    seen.add(r.itemId)
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
      inventory: complete.map(({ r, qtyMilli }) => ({
        stockItemId: r.itemId,
        godownId: r.godownId,
        batchId: r.batchId,
        qtyMilli,
        ratePaise: 0,
        amount: 0,
        direction: 'in' as const,
        isAbsolute: true
      })),
      billRefs: [],
      tds: null
    }
  }
}

export function physicalRepresentation(
  v: Voucher,
  opts: { itemName: (itemId: number) => string }
): Representation<PhysicalFormState> {
  if (v.lines.length > 0 || v.billRefs.length > 0 || v.tds || v.partyLedgerId != null) {
    return { ok: false, reason: 'it carries ledger lines' }
  }
  const state: PhysicalFormState = {
    date: v.date,
    number: v.number,
    rows: v.inventory.map((l) => ({ itemId: l.stockItemId, qtyText: qtyText(l.qtyMilli), godownId: l.godownId, batchId: l.batchId })),
    narration: v.narration ?? '',
    passthrough: passthroughOf(v),
    isOptional: v.isOptional
  }
  return confirmRoundTrip(v, state, buildPhysicalPayload(state, { voucherTypeId: v.voucherTypeId, itemName: opts.itemName }))
}
