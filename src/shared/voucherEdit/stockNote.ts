// Stock-note mode (WP 2.5b): the delivery challan (`delivery_note`, goods out) and the goods
// receipt note (`receipt_note`, goods in) — a party, item lines in one direction, a purpose, the
// transport fields, and NO ledger lines. The React form (screens/voucher/StockNoteEntry.tsx)
// shares the invoice's item grid; everything that turns its inputs into a save payload lives
// here so a saved note can be proved to round-trip before the form opens it.
//
// Values: the line rate is the taxable value per unit in ₹ (rule 55(1) CGST Rules wants the
// taxable value on a challan; design §9 Q13: the order / price-list rate, never the cost). GST is
// computed for display (and the e-way bill) only — a note posts nothing.

import type { TradePurpose, Voucher, VoucherKind } from '../domain'
import { computeGst, supplyTypeFor, addBreakups, type GstBreakup, type SupplyType } from '../gst/calc'
import type { InvoiceRowState } from './invoice'
import {
  confirmRoundTrip, passthroughOf, qtyText,
  type BuildResult, type HeaderPassthrough, type Representation
} from './payload'

export type StockNoteKind = 'delivery_note' | 'receipt_note'

export const isStockNoteKind = (k: VoucherKind): k is StockNoteKind => k === 'delivery_note' || k === 'receipt_note'

/** The purposes each note offers (trade_voucher_details.purpose CHECK, migration 025), in the
 *  order the form shows them. GRN `return` = goods coming back (a rejection / sales return);
 *  `job_work` on a GRN = goods received back from (or for) job work. */
export const STOCK_NOTE_PURPOSES: Record<StockNoteKind, readonly { value: TradePurpose; label: string }[]> = {
  delivery_note: [
    { value: 'supply', label: 'Supply' },
    { value: 'job_work', label: 'Job work' },
    { value: 'approval', label: 'On approval' },
    { value: 'liquid_gas', label: 'Liquid gas' },
    // Exhibition, own use, sending for repair… — anything that is not a supply.
    { value: 'non_supply', label: 'Other (not a supply)' }
  ],
  receipt_note: [
    { value: 'purchase', label: 'Purchase' },
    { value: 'job_work', label: 'Job work' },
    { value: 'return', label: 'Return / rejection' }
  ]
}

export const DEFAULT_PURPOSE: Record<StockNoteKind, TradePurpose> = { delivery_note: 'supply', receipt_note: 'purchase' }

export const purposeLabel = (p: TradePurpose): string =>
  [...STOCK_NOTE_PURPOSES.delivery_note, ...STOCK_NOTE_PURPOSES.receipt_note].find((x) => x.value === p)?.label ?? p

/** Does the challan carry tax? Rule 55(1)(vii): tax rate and amount "where the transportation is
 *  for supply to the consignee" — supply and supply on approval. Other purposes show the taxable
 *  value only. (Approval read as a supply: UNVERIFIED — confirm with your CA.) */
export const purposeIsTaxed = (p: TradePurpose): boolean => p === 'supply' || p === 'approval' || p === 'purchase'

export interface StockNoteFormState {
  date: string
  /** '' = auto-assign. */
  number: string
  partyId: number | null
  purpose: TradePurpose
  rows: InvoiceRowState[]
  narration: string
  /** Customer's PO no. / supplier's challan no. */
  reference: string
  vehicleNo: string
  transporterId: string
  distanceKm: string
  posOverride: string | null
  /** Header fields the form never edits (instrument, currency), posted back as loaded. */
  passthrough: Pick<HeaderPassthrough, 'instrumentNo' | 'instrumentDate'>
  /** Absent on a new note; an alteration keeps the stored flag. */
  isOptional?: boolean
}

export function emptyStockNoteState(kind: StockNoteKind, date: string): StockNoteFormState {
  return {
    date, number: '', partyId: null, purpose: DEFAULT_PURPOSE[kind], rows: [], narration: '', reference: '',
    vehicleNo: '', transporterId: '', distanceKm: '', posOverride: null,
    passthrough: { instrumentNo: null, instrumentDate: null }
  }
}

export interface StockNoteContext {
  kind: StockNoteKind
  companyStateCode: string
  items: ReadonlyMap<number, { gstRate: number | null; cessRate: number | null }>
  ledgers: ReadonlyMap<number, { stateCode: string | null }>
}

export interface StockNoteLine {
  itemId: number
  qtyMilli: number
  ratePaise: number
  discountPaise: number
  /** Taxable value (post-discount). */
  amount: number
  gstRate: number
  cessRate: number
  godownId: number | null
  batchId: number | null
  serials?: string[]
  lineUid?: string
  source?: InvoiceRowState['source']
}

export interface StockNoteComputed {
  supply: SupplyType
  lines: StockNoteLine[]
  /** Display only (never posted): the tax the value would carry — zero when the purpose isn't taxed. */
  gst: GstBreakup
}

/** Lines with an item and a positive quantity; an empty rate is a zero value. */
export function computeStockNote(state: StockNoteFormState, ctx: StockNoteContext): StockNoteComputed {
  const party = state.partyId != null ? ctx.ledgers.get(state.partyId) : undefined
  const supply = supplyTypeFor(ctx.companyStateCode, state.posOverride ?? party?.stateCode ?? ctx.companyStateCode)
  const lines: StockNoteLine[] = []
  for (const r of state.rows) {
    const item = r.itemId != null ? ctx.items.get(r.itemId) : undefined
    const qtyMilli = Math.round(parseFloat(r.qtyText || '0') * 1000)
    if (!item || r.itemId == null || !Number.isFinite(qtyMilli) || qtyMilli <= 0) continue
    const ratePaise = r.rate ?? 0
    const gross = Math.round((qtyMilli * ratePaise) / 1000)
    const discountPaise = Math.min(gross, r.discount ?? 0)
    lines.push({
      itemId: r.itemId, qtyMilli, ratePaise, discountPaise, amount: gross - discountPaise,
      gstRate: item.gstRate ?? 0, cessRate: item.cessRate ?? 0, godownId: r.godownId, batchId: r.batchId,
      ...(r.serials && r.serials.length > 0 ? { serials: [...r.serials] } : {}),
      ...(r.lineUid ? { lineUid: r.lineUid } : {}),
      ...(r.source ? { source: { ...r.source } } : {})
    })
  }
  const taxed = purposeIsTaxed(state.purpose)
  const gst = addBreakups(
    lines.map((l) => (taxed ? computeGst(l.amount, l.gstRate, supply, l.cessRate) : computeGst(l.amount, 0, supply, 0)))
  )
  return { supply, lines, gst }
}

/** The exact payload the note form posts. */
export function buildStockNotePayload(state: StockNoteFormState, ctx: StockNoteContext, voucherTypeId: number): BuildResult {
  if (state.partyId == null) return { ok: false, error: 'Pick the party first' }
  const c = computeStockNote(state, ctx)
  if (c.lines.length === 0) return { ok: false, error: 'Add at least one item line with a quantity' }
  const direction = ctx.kind === 'delivery_note' ? ('out' as const) : ('in' as const)
  const distance = state.distanceKm.trim()
  return {
    ok: true,
    payload: {
      voucherTypeId,
      date: state.date,
      number: state.number.trim() || undefined,
      partyLedgerId: state.partyId,
      narration: state.narration.trim() || null,
      reference: state.reference.trim() || null,
      instrumentNo: state.passthrough.instrumentNo,
      instrumentDate: state.passthrough.instrumentDate,
      transporterId: state.transporterId.trim().toUpperCase() || null,
      vehicleNo: state.vehicleNo.trim().toUpperCase() || null,
      transportDistanceKm: distance && Number.isFinite(Number(distance)) ? Math.round(Number(distance)) : null,
      posOverride: state.posOverride,
      currencyCode: null,
      exchangeRate: null,
      ...(state.isOptional !== undefined ? { isOptional: state.isOptional } : {}),
      trade: { purpose: state.purpose },
      lines: [],
      inventory: c.lines.map((l) => ({
        stockItemId: l.itemId,
        godownId: l.godownId,
        batchId: l.batchId,
        qtyMilli: l.qtyMilli,
        ratePaise: l.ratePaise,
        discountPaise: l.discountPaise,
        amount: l.amount,
        direction,
        ...(l.serials ? { serials: l.serials } : {}),
        ...(l.lineUid ? { lineUid: l.lineUid } : {}),
        ...(l.source ? { source: l.source } : {})
      })),
      billRefs: [],
      tds: null
    }
  }
}

/** Reconstruct the form from a saved note (structural half; stockNoteRepresentation compares). */
export function stockNoteStateFromVoucher(v: Voucher, kind: StockNoteKind): { ok: true; state: StockNoteFormState } | { ok: false; reason: string } {
  if (v.partyLedgerId == null) return { ok: false, reason: 'no party ledger' }
  if (v.lines.length > 0) return { ok: false, reason: 'it carries ledger lines' }
  if (v.inventory.length === 0) return { ok: false, reason: 'it has no item lines' }
  const want = kind === 'delivery_note' ? 'out' : 'in'
  if (v.inventory.some((l) => l.isAbsolute || l.direction !== want)) return { ok: false, reason: `it has lines that don't go ${want}` }
  if (v.currencyCode || v.exchangeRate != null) return { ok: false, reason: 'it carries a foreign currency' }
  const p = passthroughOf(v)
  return {
    ok: true,
    state: {
      date: v.date,
      number: v.number,
      partyId: v.partyLedgerId,
      purpose: v.trade?.purpose ?? DEFAULT_PURPOSE[kind],
      rows: v.inventory.map((l) => ({
        itemId: l.stockItemId,
        qtyText: qtyText(l.qtyMilli),
        rate: l.ratePaise,
        discount: l.discountPaise ? l.discountPaise : null,
        godownId: l.godownId,
        batchId: l.batchId,
        ...(l.serials && l.serials.length > 0 ? { serials: [...l.serials] } : {}),
        ...(l.lineUid ? { lineUid: l.lineUid } : {}),
        ...(l.source ? { source: { lineUid: l.source.lineUid, linkType: l.source.linkType } } : {})
      })),
      narration: v.narration ?? '',
      reference: v.reference ?? '',
      vehicleNo: v.vehicleNo ?? '',
      transporterId: v.transporterId ?? '',
      distanceKm: v.transportDistanceKm != null ? String(v.transportDistanceKm) : '',
      posOverride: v.posOverride,
      passthrough: { instrumentNo: p.instrumentNo, instrumentDate: p.instrumentDate },
      isOptional: v.isOptional
    }
  }
}

/** Can the note form show `v` and save it back byte-for-byte? (A note imported from Tally with
 *  an amount that isn't qty × rate − discount can't — it opens in the stock-lines editor.) */
export function stockNoteRepresentation(v: Voucher, ctx: StockNoteContext): Representation<StockNoteFormState> {
  const loaded = stockNoteStateFromVoucher(v, ctx.kind)
  if (!loaded.ok) return loaded
  return confirmRoundTrip(v, loaded.state, buildStockNotePayload(loaded.state, ctx, v.voucherTypeId))
}

/** Rule 55(1)(i) CGST Rules: a challan number may not exceed sixteen characters (and rule 46(b)
 *  says the same of a tax invoice). Null when within the limit. */
export function documentNumberWarning(number: string): string | null {
  const n = number.trim()
  if (n.length <= 16) return null
  return `${n.length} characters — GST documents allow at most 16 (rule 55 / rule 46, CGST Rules 2017)`
}
