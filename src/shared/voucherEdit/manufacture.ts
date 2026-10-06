// Manufacture mode (stock journal built from a bill of materials): "produce item X qty N,
// consuming BOM components at cost, plus an overhead %". Form state ⇄ save payload.

import type { Voucher } from '../domain'
import {
  confirmRoundTrip, EMPTY_PASSTHROUGH, passthroughOf, qtyText,
  type BuildResult, type HeaderPassthrough, type Representation
} from './payload'

export interface BomComponent {
  componentId: number
  qtyMilliPerUnit: number
}

export interface LineMeta {
  godownId: number | null
  batchId: number | null
}

export interface ManufactureFormState {
  date: string
  /** '' = auto-assign. */
  number: string
  producedId: number | null
  qtyText: string
  extraPctText: string
  /** true = the automatic "Manufactured N × Item" narration (tracks item/qty edits). */
  autoNarration: boolean
  /** Used when autoNarration is false (an alteration of a voucher with its own narration). */
  narration: string | null
  /** Alteration only: the saved component rates (paise per unit), so re-saving doesn't revalue
   *  consumption at today's average cost. Components without one use the live average. */
  frozenRates: Record<number, number>
  /** Alteration only: godown/batch of saved component lines (by component id) and of the
   *  produced line (applied only while the produced item is unchanged). */
  componentMeta: Record<number, LineMeta>
  producedMeta: LineMeta & { itemId: number | null }
  passthrough: HeaderPassthrough
  isOptional: boolean | undefined
}

export function emptyManufactureState(date: string): ManufactureFormState {
  return {
    date, number: '', producedId: null, qtyText: '1', extraPctText: '0', autoNarration: true, narration: null,
    frozenRates: {}, componentMeta: {}, producedMeta: { itemId: null, godownId: null, batchId: null },
    passthrough: EMPTY_PASSTHROUGH, isOptional: undefined
  }
}

export const autoManufactureNarration = (qty: number, itemName: string): string => `Manufactured ${qty} × ${itemName}`.trim()

export interface ConsumptionLine {
  componentId: number
  useMilli: number
  rate: number
  amount: number
}

export function computeManufacture(
  state: ManufactureFormState,
  bom: readonly BomComponent[],
  avgCost: (itemId: number) => number
): { qty: number; extraPct: number; consumption: ConsumptionLine[]; consumedTotal: number; producedValue: number } {
  const qty = Number(state.qtyText) || 0
  const extraPct = Number(state.extraPctText) || 0
  const consumption = bom.map((line) => {
    const useMilli = Math.round(line.qtyMilliPerUnit * qty)
    const rate = state.frozenRates[line.componentId] ?? avgCost(line.componentId)
    return { componentId: line.componentId, useMilli, rate, amount: Math.round((useMilli * rate) / 1000) }
  })
  const consumedTotal = consumption.reduce((s, c) => s + c.amount, 0)
  return { qty, extraPct, consumption, consumedTotal, producedValue: Math.round(consumedTotal * (1 + extraPct / 100)) }
}

export function buildManufacturePayload(
  state: ManufactureFormState,
  opts: {
    voucherTypeId: number
    bom: readonly BomComponent[]
    avgCost: (itemId: number) => number
    itemName: (itemId: number) => string
  }
): BuildResult {
  if (state.producedId == null) return { ok: false, error: 'Pick the item to produce' }
  if (opts.bom.length === 0) return { ok: false, error: 'This item has no bill of materials — set it in Masters → Stock items' }
  const c = computeManufacture(state, opts.bom, opts.avgCost)
  if (c.qty <= 0) return { ok: false, error: 'Quantity must be positive' }
  const qtyMilli = Math.round(c.qty * 1000)
  const produced = state.producedMeta.itemId === state.producedId ? state.producedMeta : { godownId: null, batchId: null }
  const p = state.passthrough
  return {
    ok: true,
    payload: {
      voucherTypeId: opts.voucherTypeId,
      date: state.date,
      number: state.number.trim() || undefined,
      ...p,
      partyLedgerId: null,
      narration: state.autoNarration ? autoManufactureNarration(c.qty, opts.itemName(state.producedId)) : state.narration,
      ...(state.isOptional !== undefined ? { isOptional: state.isOptional } : {}),
      lines: [],
      inventory: [
        ...c.consumption.map((x) => ({
          stockItemId: x.componentId,
          godownId: state.componentMeta[x.componentId]?.godownId ?? null,
          batchId: state.componentMeta[x.componentId]?.batchId ?? null,
          qtyMilli: x.useMilli,
          ratePaise: x.rate,
          amount: x.amount,
          direction: 'out' as const
        })),
        {
          stockItemId: state.producedId,
          godownId: produced.godownId,
          batchId: produced.batchId,
          qtyMilli,
          ratePaise: Math.round((c.producedValue * 1000) / qtyMilli),
          amount: c.producedValue,
          direction: 'in' as const
        }
      ],
      billRefs: [],
      tds: null
    }
  }
}

/** Shortest overhead-% text that reproduces `producedValue` from `consumedTotal`. */
function overheadText(consumedTotal: number, producedValue: number): string | null {
  if (consumedTotal === 0) return producedValue === 0 ? '0' : null
  const pct = (producedValue / consumedTotal - 1) * 100
  for (let d = 0; d <= 8; d++) {
    const text = String(Number(pct.toFixed(d)))
    if (Math.round(consumedTotal * (1 + Number(text) / 100)) === producedValue) return text
  }
  return null
}

/** Reconstruct the manufacture form from a saved stock journal — needs the produced item's
 *  current BOM (`bomFor`) — then rebuild and compare. Anything else (transfers, imported or
 *  hand-made journals, a since-changed BOM) is not representable and falls back to the
 *  generic stock-lines editor. */
export function manufactureRepresentation(
  v: Voucher,
  opts: {
    bomFor: (itemId: number) => readonly BomComponent[] | undefined
    itemName: (itemId: number) => string
  }
): Representation<ManufactureFormState> {
  if (v.lines.length > 0 || v.billRefs.length > 0 || v.tds || v.partyLedgerId != null) {
    return { ok: false, reason: 'it carries ledger lines' }
  }
  const inv = v.inventory
  const produced = inv[inv.length - 1]
  if (!produced || produced.direction !== 'in' || inv.length < 2) return { ok: false, reason: 'it is not a single produced item' }
  const outs = inv.slice(0, -1)
  if (outs.some((l) => l.direction !== 'out') || inv.some((l) => l.isAbsolute || l.discountPaise !== 0)) {
    return { ok: false, reason: 'its lines are not consumption + one produced item' }
  }
  const bom = opts.bomFor(produced.stockItemId)
  if (!bom || bom.length === 0) return { ok: false, reason: 'the produced item has no bill of materials' }

  const frozenRates: Record<number, number> = {}
  const componentMeta: Record<number, LineMeta> = {}
  for (const l of outs) {
    if (l.stockItemId in frozenRates) return { ok: false, reason: 'a component appears twice' }
    frozenRates[l.stockItemId] = l.ratePaise
    componentMeta[l.stockItemId] = { godownId: l.godownId, batchId: l.batchId }
  }
  const consumedTotal = outs.reduce((s, l) => s + l.amount, 0)
  const extraPctText = overheadText(consumedTotal, produced.amount)
  if (extraPctText == null) return { ok: false, reason: 'its produced value is not consumption plus an overhead %' }

  const qty = Number(qtyText(produced.qtyMilli))
  const auto = autoManufactureNarration(qty, opts.itemName(produced.stockItemId))
  const state: ManufactureFormState = {
    date: v.date,
    number: v.number,
    producedId: produced.stockItemId,
    qtyText: qtyText(produced.qtyMilli),
    extraPctText,
    autoNarration: v.narration === auto,
    narration: v.narration,
    frozenRates,
    componentMeta,
    producedMeta: { itemId: produced.stockItemId, godownId: produced.godownId, batchId: produced.batchId },
    passthrough: passthroughOf(v),
    isOptional: v.isOptional
  }
  return confirmRoundTrip(
    v,
    state,
    buildManufacturePayload(state, { voucherTypeId: v.voucherTypeId, bom, avgCost: () => 0, itemName: opts.itemName })
  )
}
