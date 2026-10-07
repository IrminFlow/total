// Voucher ⇄ save-payload plumbing shared by every voucher-entry mode (WP 1.4).
//
// Each entry mode (invoice / accounting / manufacture / physical stock / generic stock lines)
// has a pure "state from voucher" and "payload from state" pair in this directory. The editor
// decides which mode may open a saved voucher by running that pair and comparing the rebuilt
// payload with `voucherToPayload(voucher)` — the payload that would re-save the voucher exactly
// as stored. Pure TypeScript: no React, no DB.

import type { InventoryLine, Voucher, VoucherKind } from '../domain'
import type { VoucherInputParsed } from '../schemas'

export type VoucherPayload = VoucherInputParsed
export type LinePayload = VoucherPayload['lines'][number]
export type InventoryPayload = VoucherPayload['inventory'][number]

export const TRADING_KINDS: VoucherKind[] = ['sales', 'purchase', 'credit_note', 'debit_note']

/** Header fields a mode does not show (or shows only for some kinds) but must post back
 *  unchanged when altering a saved voucher. New vouchers start from `EMPTY_PASSTHROUGH`. */
export interface HeaderPassthrough {
  partyLedgerId: number | null
  reference: string | null
  instrumentNo: string | null
  instrumentDate: string | null
  transporterId: string | null
  vehicleNo: string | null
  transportDistanceKm: number | null
  posOverride: string | null
  currencyCode: string | null
  exchangeRate: number | null
}

export const EMPTY_PASSTHROUGH: HeaderPassthrough = {
  partyLedgerId: null,
  reference: null,
  instrumentNo: null,
  instrumentDate: null,
  transporterId: null,
  vehicleNo: null,
  transportDistanceKm: null,
  posOverride: null,
  currencyCode: null,
  exchangeRate: null
}

export function passthroughOf(v: Voucher): HeaderPassthrough {
  return {
    partyLedgerId: v.partyLedgerId,
    reference: v.reference,
    instrumentNo: v.instrumentNo,
    instrumentDate: v.instrumentDate,
    transporterId: v.transporterId,
    vehicleNo: v.vehicleNo,
    transportDistanceKm: v.transportDistanceKm,
    posOverride: v.posOverride,
    currencyCode: v.currencyCode,
    exchangeRate: v.exchangeRate
  }
}

/** Every stored inventory-line field, verbatim — never drop batch/discount/godown/absolute/serials. */
export function inventoryToPayload(l: InventoryLine): InventoryPayload {
  return {
    ...(l.serials && l.serials.length > 0 ? { serials: [...l.serials] } : {}),
    stockItemId: l.stockItemId,
    godownId: l.godownId,
    batchId: l.batchId,
    qtyMilli: l.qtyMilli,
    ratePaise: l.ratePaise,
    discountPaise: l.discountPaise,
    amount: l.amount,
    direction: l.direction,
    isAbsolute: l.isAbsolute
  }
}

/** The payload that re-saves `v` exactly as stored (ids aside). Bank-reconciliation dates are
 *  not part of the input — saveVoucher carries them over line-by-line itself. */
export function voucherToPayload(v: Voucher): VoucherPayload {
  return {
    voucherTypeId: v.voucherTypeId,
    date: v.date,
    number: v.number,
    ...passthroughOf(v),
    narration: v.narration,
    postDated: v.postDated,
    isOptional: v.isOptional,
    lines: v.lines.map((l) => ({
      ledgerId: l.ledgerId,
      drCr: l.drCr,
      amount: l.amount,
      costAllocations: l.costAllocations.map((a) => ({ costCentreId: a.costCentreId, amount: a.amount }))
    })),
    inventory: v.inventory.map(inventoryToPayload),
    billRefs: v.billRefs.map((r) => ({ kind: r.kind, name: r.name, amount: r.amount, dueDate: r.dueDate })),
    tds: v.tds
      ? { sectionId: v.tds.sectionId, baseAmount: v.tds.baseAmount, tdsAmount: v.tds.tdsAmount, isManual: !!v.tds.isManual, autoPayable: false }
      : null,
    tcs: v.tcs
      ? { sectionId: v.tcs.sectionId, baseAmount: v.tcs.baseAmount, tcsAmount: v.tcs.tcsAmount, isManual: !!v.tcs.isManual, autoPayable: false }
      : null
  }
}

/** Display text for a qtyMilli in an editable quantity box ("2.5"), parse-stable with
 *  Math.round(parseFloat(text) * 1000). */
export function qtyText(qtyMilli: number): string {
  return String(qtyMilli / 1000)
}

const trimOrNull = (s: string | null | undefined): string | null => {
  if (s == null) return null
  const t = s.trim()
  return t === '' ? null : t
}

/** Canonical comparison form — applies the same defaults/trimming voucherInputSchema would,
 *  so two payloads that would store identically compare equal. `postDated`/`isOptional`
 *  absent means "keep the stored value" server-side, so they're only compared when both
 *  sides state them. */
function canonical(p: VoucherPayload): Record<string, unknown> {
  return {
    voucherTypeId: p.voucherTypeId,
    date: p.date,
    number: trimOrNull(p.number),
    partyLedgerId: p.partyLedgerId ?? null,
    narration: trimOrNull(p.narration),
    reference: trimOrNull(p.reference),
    instrumentNo: trimOrNull(p.instrumentNo),
    instrumentDate: p.instrumentDate ?? null,
    transporterId: trimOrNull(p.transporterId),
    vehicleNo: trimOrNull(p.vehicleNo),
    transportDistanceKm: p.transportDistanceKm ?? null,
    posOverride: p.posOverride ?? null,
    currencyCode: p.currencyCode ? p.currencyCode.trim().toUpperCase() : null,
    exchangeRate: p.exchangeRate ?? null,
    lines: p.lines.map((l) => ({
      ledgerId: l.ledgerId,
      drCr: l.drCr,
      amount: l.amount,
      costAllocations: (l.costAllocations ?? []).map((a) => ({ costCentreId: a.costCentreId, amount: a.amount }))
    })),
    inventory: (p.inventory ?? []).map((l) => ({
      stockItemId: l.stockItemId,
      godownId: l.godownId ?? null,
      batchId: l.batchId ?? null,
      qtyMilli: l.qtyMilli,
      ratePaise: l.ratePaise,
      discountPaise: l.discountPaise ?? 0,
      amount: l.amount,
      direction: l.direction,
      isAbsolute: l.isAbsolute ?? false,
      // Serial order is significant (stored as given); absent and [] store the same.
      serials: [...(l.serials ?? [])]
    })),
    billRefs: (p.billRefs ?? []).map((r) => ({ kind: r.kind, name: r.name.trim(), amount: r.amount, dueDate: r.dueDate ?? null })),
    // autoPayable isn't compared on its own: a payload that leaves the payable credit to the
    // server already differs from the stored voucher in its lines.
    tds: p.tds ? { sectionId: p.tds.sectionId, baseAmount: p.tds.baseAmount, tdsAmount: p.tds.tdsAmount, isManual: !!p.tds.isManual } : null,
    tcs: p.tcs ? { sectionId: p.tcs.sectionId, baseAmount: p.tcs.baseAmount, tcsAmount: p.tcs.tcsAmount, isManual: !!p.tcs.isManual } : null
  }
}

function diffValues(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}.length`)
      return
    }
    a.forEach((x, i) => diffValues(x, b[i], `${path}[${i}]`, out))
    return
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) {
      diffValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out)
    }
    return
  }
  if (a !== b) out.push(path)
}

/** Field paths at which two payloads would store differently (empty = identical). Line,
 *  inventory, bill-ref and cost-allocation ORDER is significant: saveVoucher stores it. */
export function diffPayloads(a: VoucherPayload, b: VoucherPayload): string[] {
  const out: string[] = []
  diffValues(canonical(a), canonical(b), '', out)
  for (const k of ['postDated', 'isOptional'] as const) {
    if (a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]) out.push(k)
  }
  return out
}

export type Representation<S> = { ok: true; state: S } | { ok: false; reason: string }

/** Shared tail of every mode's representability check: rebuild, then compare. */
export function confirmRoundTrip<S>(
  v: Voucher,
  state: S,
  rebuilt: { ok: true; payload: VoucherPayload } | { ok: false; error: string }
): Representation<S> {
  if (!rebuilt.ok) return { ok: false, reason: rebuilt.error }
  const diffs = diffPayloads(rebuilt.payload, voucherToPayload(v))
  if (diffs.length > 0) return { ok: false, reason: `would change ${diffs.slice(0, 4).join(', ')}` }
  return { ok: true, state }
}

export type BuildResult = { ok: true; payload: VoucherPayload } | { ok: false; error: string }
