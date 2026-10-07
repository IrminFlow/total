// Accounting mode (payment / receipt / contra / journal, and the faithful fallback for any
// voucher the specialised modes can't show): form state ⇄ save payload. Inventory lines and
// every header field the form doesn't edit ride along untouched on alteration.

import type { Voucher, VoucherBillRef, VoucherKind } from '../domain'
import { inventoryToPayload, passthroughOf, type BuildResult, type HeaderPassthrough, type InventoryPayload } from './payload'

export interface AccountingRowState {
  drCr: 'dr' | 'cr'
  ledgerId: number | null
  amount: number | null
  costAllocations: { costCentreId: number; amount: number }[]
}

/** What an alteration must preserve beyond the editable fields. */
export interface AccountingOriginal extends HeaderPassthrough {
  /** Sorted distinct ledger ids posted by the saved voucher — while the rows still post exactly
   *  these, the stored party is kept as-is rather than re-derived. */
  ledgerIds: number[]
  inventory: InventoryPayload[]
}

export interface AccountingFormState {
  date: string
  /** '' = auto-assign. */
  number: string
  rows: AccountingRowState[]
  narration: string
  instrumentNo: string
  billRefs: VoucherBillRef[]
  advanceReceipt: boolean
  optional: boolean
  tds: AccountingTdsState | null
  /** null for a new voucher. */
  original: AccountingOriginal | null
}

/** The TDS entry as the accounting form holds it. `autoPayable` = the rows don't carry the
 *  payable credit (its ledger doesn't exist yet) — saveVoucher appends it (see tdsSchema). */
export interface AccountingTdsState {
  sectionId: number
  baseAmount: number
  tdsAmount: number
  isManual?: boolean
  autoPayable?: boolean
}

const distinctSorted = (ids: number[]): number[] => [...new Set(ids)].sort((a, b) => a - b)

function postedRows(rows: AccountingRowState[]): (AccountingRowState & { ledgerId: number; amount: number })[] {
  return rows.filter((r): r is AccountingRowState & { ledgerId: number; amount: number } =>
    r.ledgerId != null && r.amount != null && r.amount > 0)
}

/** The single posted ledger that is a party (Sundry Debtor/Creditor) or flagged for TDS, else
 *  `fallback` (e.g. a draft-supplied party) when the rows don't name one unambiguously. */
export function derivePartyId(
  rows: readonly AccountingRowState[],
  isPartyOrTds: (ledgerId: number) => boolean,
  fallback: number | null
): number | null {
  const candidates = new Set<number>()
  for (const r of rows) if (r.ledgerId != null && isPartyOrTds(r.ledgerId)) candidates.add(r.ledgerId)
  return candidates.size === 1 ? [...candidates][0]! : fallback
}

/** The voucher's party for bills/TDS: for a new voucher the one derived from the rows; on
 *  alteration the stored party while it's still posted (re-deriving could silently move a
 *  voucher's GST/B2B attribution just by opening and saving it). */
export function effectiveParty(state: AccountingFormState, derivedPartyId: number | null): number | null {
  const o = state.original
  if (!o) return derivedPartyId
  const ids = distinctSorted(postedRows(state.rows).map((r) => r.ledgerId))
  const sameLedgers = ids.length === o.ledgerIds.length && ids.every((x, i) => x === o.ledgerIds[i])
  if (sameLedgers) return o.partyLedgerId
  if (o.partyLedgerId != null && ids.includes(o.partyLedgerId)) return o.partyLedgerId
  return derivedPartyId ?? null
}

export function buildAccountingPayload(
  state: AccountingFormState,
  opts: { kind: VoucherKind; voucherTypeId: number; derivedPartyId: number | null }
): BuildResult {
  const lines = postedRows(state.rows).map((r) => ({
    ledgerId: r.ledgerId, drCr: r.drCr, amount: r.amount, costAllocations: r.costAllocations
  }))
  if (lines.length < 2) return { ok: false, error: 'Enter at least one debit and one credit' }
  const o = state.original
  const party = effectiveParty(state, opts.derivedPartyId)
  const refs = party != null ? [...state.billRefs] : []
  if (opts.kind === 'receipt' && state.advanceReceipt && party != null) {
    const partyLineTotal =
      opts.derivedPartyId != null ? lines.filter((l) => l.ledgerId === opts.derivedPartyId).reduce((s, l) => s + l.amount, 0) : 0
    const remainder = partyLineTotal - refs.reduce((s, r) => s + r.amount, 0)
    if (remainder > 0) refs.push({ kind: 'new', name: state.number.trim() || 'Advance', amount: remainder, dueDate: null })
  }
  const instrumentNo = state.instrumentNo.trim() || null
  // The cheque date defaults to the voucher date; an alteration that leaves the cheque number
  // alone keeps whatever date was stored with it.
  const instrumentDate = o && instrumentNo === o.instrumentNo ? o.instrumentDate : instrumentNo ? state.date : null
  return {
    ok: true,
    payload: {
      voucherTypeId: opts.voucherTypeId,
      date: state.date,
      number: state.number.trim() || undefined,
      partyLedgerId: party,
      narration: state.narration.trim() || null,
      reference: o?.reference ?? null,
      instrumentNo,
      instrumentDate,
      transporterId: o?.transporterId ?? null,
      vehicleNo: o?.vehicleNo ?? null,
      transportDistanceKm: o?.transportDistanceKm ?? null,
      posOverride: o?.posOverride ?? null,
      currencyCode: o?.currencyCode ?? null,
      exchangeRate: o?.exchangeRate ?? null,
      isOptional: state.optional,
      lines,
      // Every stored inventory field, verbatim (batch, discount, godown, physical-count flag).
      inventory: o ? o.inventory.map((l) => ({ ...l })) : [],
      billRefs: refs,
      tds:
        state.tds && party != null
          ? {
              sectionId: state.tds.sectionId, baseAmount: state.tds.baseAmount, tdsAmount: state.tds.tdsAmount,
              isManual: !!state.tds.isManual, autoPayable: !!state.tds.autoPayable
            }
          : null
    }
  }
}

export function accountingStateFromVoucher(v: Voucher): AccountingFormState {
  return {
    date: v.date,
    number: v.number,
    rows: v.lines.map((l) => ({
      drCr: l.drCr,
      ledgerId: l.ledgerId,
      amount: l.amount,
      costAllocations: l.costAllocations.map((a) => ({ ...a }))
    })),
    narration: v.narration ?? '',
    instrumentNo: v.instrumentNo ?? '',
    billRefs: v.billRefs.map((r) => ({ ...r })),
    advanceReceipt: false,
    optional: v.isOptional,
    tds: v.tds
      ? { sectionId: v.tds.sectionId, baseAmount: v.tds.baseAmount, tdsAmount: v.tds.tdsAmount, isManual: !!v.tds.isManual }
      : null,
    original: {
      ...passthroughOf(v),
      ledgerIds: distinctSorted(v.lines.map((l) => l.ledgerId)),
      inventory: v.inventory.map(inventoryToPayload)
    }
  }
}
