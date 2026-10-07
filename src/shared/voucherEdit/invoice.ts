// Invoice mode (sales / purchase / credit note / debit note): form state ⇄ save payload.
// The React form (renderer screens/voucher/InvoiceEntry.tsx) owns the inputs; everything that
// turns those inputs into ledger + inventory lines lives here so it can be unit-tested and used
// to decide whether a saved trading voucher can be shown as an invoice at all.

import type { Voucher, VoucherBillRef, VoucherKind } from '../domain'
import { computeGst, supplyTypeFor, addBreakups, type GstBreakup, type SupplyType } from '../gst/calc'
import { roundToRupee } from '../money'
import {
  confirmRoundTrip, passthroughOf, qtyText,
  type BuildResult, type LinePayload, type Representation
} from './payload'

export interface InvoiceRowState {
  itemId: number | null
  qtyText: string
  /** Paise per unit, in the invoice currency. */
  rate: number | null
  /** Per-line trade discount, paise in the invoice currency (display + gross only). */
  discount: number | null
  /** Picked per line in the stock-detail expander (WP 2.3). */
  godownId: number | null
  batchId: number | null
  /** Serial numbers (serial-tracked items) — one per unit. */
  serials?: string[]
}

export interface InvoiceFormState {
  date: string
  /** '' = auto-assign. */
  number: string
  partyId: number | null
  accountId: number | null
  rows: InvoiceRowState[]
  narration: string
  vehicleNo: string
  transporterId: string
  distanceKm: string
  currencyCode: string
  fxRateText: string
  posOverride: string | null
  optional: boolean
  billName: string
  billDueDate: string
  /** Notes only: true = post one 'new' bill (billName) instead of allocating against bills. */
  manualNewBillMode: boolean
  noteBillRefs: VoucherBillRef[]
  /** Fields this form never edits; posted back as loaded. */
  reference: string | null
  instrumentNo: string | null
  instrumentDate: string | null
}

export const blankInvoiceRow = (): InvoiceRowState => ({
  itemId: null, qtyText: '', rate: null, discount: null, godownId: null, batchId: null
})

export interface TaxLedgerIds {
  cgst: number | null
  sgst: number | null
  igst: number | null
  cess: number | null
  roundOff: number | null
}

/** Mirrors useTaxLedgers' lookups (first ledger with that taxType; first "Round Off" by name). */
export function taxLedgerIdsFrom(ledgers: readonly { id: number; name: string; taxType: string | null }[]): TaxLedgerIds {
  const byTax = (t: string): number | null => ledgers.find((l) => l.taxType === t)?.id ?? null
  return {
    cgst: byTax('cgst'),
    sgst: byTax('sgst'),
    igst: byTax('igst'),
    cess: byTax('cess'),
    roundOff: ledgers.find((l) => l.name.toLowerCase() === 'round off')?.id ?? null
  }
}

export interface InvoiceContext {
  kind: VoucherKind
  companyStateCode: string
  items: ReadonlyMap<number, { gstRate: number | null; cessRate: number | null }>
  ledgers: ReadonlyMap<number, { stateCode: string | null; gstRate: number | null }>
}

export interface InvoiceLineDetail {
  itemId: number
  qtyMilli: number
  ratePaise: number
  discountPaise: number
  amount: number
  rate: number
  cessRate: number
  godownId: number | null
  batchId: number | null
  serials?: string[]
}

export interface InvoiceComputed {
  supply: SupplyType
  fxActive: boolean
  fxRate: number | null
  detail: InvoiceLineDetail[]
  gst: GstBreakup
  rounded: number
  roundDiff: number
}

export const partyIsDebit = (kind: VoucherKind): boolean => kind === 'sales' || kind === 'debit_note'
export const goodsComeIn = (kind: VoucherKind): boolean => kind === 'purchase' || kind === 'credit_note'
export const isNoteKind = (kind: VoucherKind): boolean => kind === 'credit_note' || kind === 'debit_note'

export function computeInvoice(state: InvoiceFormState, ctx: InvoiceContext): InvoiceComputed {
  const party = state.partyId != null ? ctx.ledgers.get(state.partyId) : undefined
  const account = state.accountId != null ? ctx.ledgers.get(state.accountId) : undefined
  // Same precedence the GSTR builders use: explicit override → party state → company state.
  const supply = supplyTypeFor(ctx.companyStateCode, state.posOverride ?? party?.stateCode ?? ctx.companyStateCode)
  const fxRate = state.currencyCode && state.fxRateText.trim() ? Number(state.fxRateText) : null
  const fxActive = !!state.currencyCode && !!fxRate && Number.isFinite(fxRate) && fxRate > 0

  const detail: InvoiceLineDetail[] = []
  for (const r of state.rows) {
    const item = r.itemId != null ? ctx.items.get(r.itemId) : undefined
    const qtyMilli = Math.round(parseFloat(r.qtyText || '0') * 1000)
    if (!item || r.itemId == null || !Number.isFinite(qtyMilli) || qtyMilli <= 0 || r.rate == null) continue
    // Rates (and discounts) are typed in the invoice currency; books stay in ₹.
    const baseRate = fxActive ? Math.round(r.rate * fxRate!) : r.rate
    const gross = Math.round((qtyMilli * baseRate) / 1000)
    const discountPaise = Math.min(gross, fxActive ? Math.round((r.discount ?? 0) * fxRate!) : (r.discount ?? 0))
    // `amount` is the post-discount taxable value — GST buckets below stay correct by construction.
    detail.push({
      itemId: r.itemId,
      qtyMilli,
      ratePaise: baseRate,
      discountPaise,
      amount: gross - discountPaise,
      rate: item.gstRate ?? account?.gstRate ?? 0,
      cessRate: item.cessRate ?? 0,
      godownId: r.godownId,
      batchId: r.batchId,
      ...(r.serials && r.serials.length > 0 ? { serials: [...r.serials] } : {})
    })
  }

  const buckets = new Map<string, { rate: number; cessRate: number; taxable: number }>()
  for (const d of detail) {
    const key = `${d.rate}|${d.cessRate}`
    const b = buckets.get(key) ?? { rate: d.rate, cessRate: d.cessRate, taxable: 0 }
    b.taxable += d.amount
    buckets.set(key, b)
  }
  const gst = addBreakups([...buckets.values()].map((b) => computeGst(b.taxable, b.rate, supply, b.cessRate)))
  const rounded = roundToRupee(gst.total)
  return { supply, fxActive, fxRate: fxActive ? fxRate : null, detail, gst, rounded, roundDiff: rounded - gst.total }
}

/** Which tax / round-off ledgers a computed invoice posts to (the form ensures these exist). */
export function requiredTaxLedgers(c: InvoiceComputed): (keyof TaxLedgerIds)[] {
  const out: (keyof TaxLedgerIds)[] = []
  if (c.gst.cgst > 0) out.push('cgst')
  if (c.gst.sgst > 0) out.push('sgst')
  if (c.gst.igst > 0) out.push('igst')
  if (c.gst.cess > 0) out.push('cess')
  if (c.roundDiff !== 0) out.push('roundOff')
  return out
}

/** The exact payload the invoice form posts. `taxLedgers` must name every ledger in
 *  requiredTaxLedgers (the form creates missing ones first; the representability check
 *  only passes existing ids). */
export function buildInvoicePayload(
  state: InvoiceFormState,
  ctx: InvoiceContext,
  voucherTypeId: number,
  taxLedgers: TaxLedgerIds
): BuildResult {
  if (state.partyId == null) return { ok: false, error: 'Pick the party account first' }
  if (state.accountId == null) return { ok: false, error: 'Pick the sales / purchase ledger' }
  const c = computeInvoice(state, ctx)
  if (c.detail.length === 0) return { ok: false, error: 'Add at least one item line' }
  for (const k of requiredTaxLedgers(c)) {
    if (taxLedgers[k] == null) return { ok: false, error: `No ${k === 'roundOff' ? 'Round Off' : k.toUpperCase()} ledger` }
  }
  const { gst, rounded, roundDiff } = c
  const partyDr = partyIsDebit(ctx.kind)
  const partySide = partyDr ? 'dr' : 'cr'
  const counter = partyDr ? 'cr' : 'dr'
  const lines: LinePayload[] = [
    { ledgerId: state.partyId, drCr: partySide, amount: rounded, costAllocations: [] },
    { ledgerId: state.accountId, drCr: counter, amount: gst.taxable, costAllocations: [] }
  ]
  if (gst.cgst > 0) lines.push({ ledgerId: taxLedgers.cgst!, drCr: counter, amount: gst.cgst, costAllocations: [] })
  if (gst.sgst > 0) lines.push({ ledgerId: taxLedgers.sgst!, drCr: counter, amount: gst.sgst, costAllocations: [] })
  if (gst.igst > 0) lines.push({ ledgerId: taxLedgers.igst!, drCr: counter, amount: gst.igst, costAllocations: [] })
  if (gst.cess > 0) lines.push({ ledgerId: taxLedgers.cess!, drCr: counter, amount: gst.cess, costAllocations: [] })
  // A round-up posts Round Off on the counter side; a round-down leaves the counter side
  // heavier, so Round Off balances on the party side.
  if (roundDiff !== 0) {
    lines.push({ ledgerId: taxLedgers.roundOff!, drCr: roundDiff > 0 ? counter : partySide, amount: Math.abs(roundDiff), costAllocations: [] })
  }
  const billName = state.billName.trim()
  return {
    ok: true,
    payload: {
      voucherTypeId,
      date: state.date,
      number: state.number.trim() || undefined,
      partyLedgerId: state.partyId,
      narration: state.narration.trim() || null,
      reference: state.reference,
      instrumentNo: state.instrumentNo,
      instrumentDate: state.instrumentDate,
      transporterId: state.transporterId.trim() || null,
      vehicleNo: state.vehicleNo.trim().toUpperCase() || null,
      transportDistanceKm: state.distanceKm.trim() ? Number(state.distanceKm) : null,
      posOverride: state.posOverride,
      currencyCode: c.fxActive ? state.currencyCode : null,
      exchangeRate: c.fxActive ? c.fxRate : null,
      isOptional: state.optional,
      lines,
      inventory: c.detail.map((d) => ({
        stockItemId: d.itemId,
        godownId: d.godownId,
        batchId: d.batchId,
        qtyMilli: d.qtyMilli,
        ratePaise: d.ratePaise,
        discountPaise: d.discountPaise,
        amount: d.amount,
        direction: goodsComeIn(ctx.kind) ? ('in' as const) : ('out' as const),
        ...(d.serials ? { serials: d.serials } : {})
      })),
      billRefs:
        isNoteKind(ctx.kind) && !state.manualNewBillMode
          ? state.noteBillRefs
          : billName
            ? [{ kind: 'new' as const, name: billName, amount: rounded, dueDate: state.billDueDate || null }]
            : [],
      tds: null
    }
  }
}

/** Blank invoice for a new entry. */
export function emptyInvoiceState(date: string): InvoiceFormState {
  return {
    date, number: '', partyId: null, accountId: null, rows: [blankInvoiceRow()], narration: '',
    vehicleNo: '', transporterId: '', distanceKm: '', currencyCode: '', fxRateText: '', posOverride: null,
    optional: false, billName: '', billDueDate: date, manualNewBillMode: false, noteBillRefs: [],
    reference: null, instrumentNo: null, instrumentDate: null
  }
}

/** Reconstruct the form from a saved voucher, or explain why the invoice form can't hold it.
 *  This is only the structural half — `invoiceRepresentation` also rebuilds and compares. */
export function invoiceStateFromVoucher(
  v: Voucher,
  kind: VoucherKind,
  taxLedgers: TaxLedgerIds
): { ok: true; state: InvoiceFormState } | { ok: false; reason: string } {
  if (v.partyLedgerId == null) return { ok: false, reason: 'no party ledger' }
  if (v.tds) return { ok: false, reason: 'it carries a TDS deduction' }
  if (v.lines.some((l) => l.costAllocations.length > 0)) return { ok: false, reason: 'it has cost-centre allocations' }
  if (v.inventory.length === 0) return { ok: false, reason: 'it has no item lines' }
  if (v.inventory.some((l) => l.isAbsolute)) return { ok: false, reason: 'it has physical-count lines' }

  const counter = partyIsDebit(kind) ? 'cr' : 'dr'
  const taxIds = new Set(Object.values(taxLedgers).filter((x): x is number => x != null))
  const accountIds = [...new Set(
    v.lines.filter((l) => l.ledgerId !== v.partyLedgerId && l.drCr === counter && !taxIds.has(l.ledgerId)).map((l) => l.ledgerId)
  )]
  if (accountIds.length !== 1) return { ok: false, reason: 'it does not post to exactly one sales / purchase ledger' }

  const fx = v.currencyCode && v.exchangeRate && v.exchangeRate > 0 ? v.exchangeRate : null
  const toInvoiceCurrency = (paise: number): number => (fx ? Math.round(paise / fx) : paise)
  const rows: InvoiceRowState[] = v.inventory.map((l) => ({
    itemId: l.stockItemId,
    qtyText: qtyText(l.qtyMilli),
    rate: toInvoiceCurrency(l.ratePaise),
    discount: l.discountPaise ? toInvoiceCurrency(l.discountPaise) : null,
    godownId: l.godownId,
    batchId: l.batchId,
    ...(l.serials && l.serials.length > 0 ? { serials: [...l.serials] } : {})
  }))

  let billName = ''
  // '' = a saved bill without a due date; with no bill at all the field is unused, so it just
  // defaults to the voucher date like a fresh form.
  let billDueDate = v.date
  let manualNewBillMode = false
  let noteBillRefs: VoucherBillRef[] = []
  const refs = v.billRefs
  const singleNew = refs.length === 1 && refs[0]!.kind === 'new' ? refs[0]! : null
  if (isNoteKind(kind)) {
    if (singleNew) {
      manualNewBillMode = true
      billName = singleNew.name
      billDueDate = singleNew.dueDate ?? ''
    } else if (refs.every((r) => r.kind === 'against')) {
      noteBillRefs = refs.map((r) => ({ ...r }))
    } else {
      return { ok: false, reason: 'its bill references mix new and against' }
    }
  } else if (singleNew) {
    billName = singleNew.name
    billDueDate = singleNew.dueDate ?? ''
  } else if (refs.length > 0) {
    return { ok: false, reason: 'it allocates against existing bills' }
  }

  const p = passthroughOf(v)
  return {
    ok: true,
    state: {
      date: v.date,
      number: v.number,
      partyId: v.partyLedgerId,
      accountId: accountIds[0]!,
      rows,
      narration: v.narration ?? '',
      vehicleNo: v.vehicleNo ?? '',
      transporterId: v.transporterId ?? '',
      distanceKm: v.transportDistanceKm != null ? String(v.transportDistanceKm) : '',
      currencyCode: v.currencyCode ?? '',
      fxRateText: v.exchangeRate != null ? String(v.exchangeRate) : '',
      posOverride: v.posOverride,
      optional: v.isOptional,
      billName,
      billDueDate,
      manualNewBillMode,
      noteBillRefs,
      reference: p.reference,
      instrumentNo: p.instrumentNo,
      instrumentDate: p.instrumentDate
    }
  }
}

/** Can the invoice form show `v` and save it back byte-for-byte? Reconstruct → rebuild →
 *  compare with the stored voucher. Fails (with a reason) on anything the form would change:
 *  a since-edited item GST rate, a non-standard tax ledger, unrounded totals, extra lines… */
export function invoiceRepresentation(
  v: Voucher,
  ctx: InvoiceContext,
  taxLedgers: TaxLedgerIds
): Representation<InvoiceFormState> {
  const loaded = invoiceStateFromVoucher(v, ctx.kind, taxLedgers)
  if (!loaded.ok) return loaded
  return confirmRoundTrip(v, loaded.state, buildInvoicePayload(loaded.state, ctx, v.voucherTypeId, taxLedgers))
}
