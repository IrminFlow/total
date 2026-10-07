// Manufacture mode (WP 2.2): the Manufacture screen's form state ⇄ the manufacture:save input,
// and reconstruction of that form from a saved stock journal + its manufacture_details row.
// A stock journal WITHOUT a details row is a legacy (pre-0.6.0) journal: it is never
// representable here and opens in the generic stock-lines editor (route.ts).

import type { Voucher } from '../domain'
import {
  autoManufactureNarration, buildManufactureVoucher, manufactureTotals, validateManufacture, RAW_ROWS_VISIBLE,
  type ManufactureDetails, type ManufactureInput, type ManufactureIssue
} from '../manufacture'
import { confirmRoundTrip, qtyText, type Representation, type VoucherPayload } from './payload'

export interface ManufactureRowState {
  itemId: number | null
  qtyText: string
  /** The saved line's own godown when it differs from the header godown; null = header. */
  godownId: number | null
}

export interface ManufactureFormState {
  date: string
  /** '' = auto-assign. */
  number: string
  /** Header godown (finished item + default for raw rows). */
  godownId: number | null
  /** '' = the automatic "Manufactured N × Item". */
  narration: string
  finishedItemId: number | null
  qtyText: string
  /** Average (sale) price per unit, paise. */
  saleRatePaise: number | null
  labourPaise: number | null
  /** false = "Labour already booked" — capitalised without ledger lines. */
  labourPosted: boolean
  /** null = Wages Payable. */
  labourCreditLedgerId: number | null
  rows: ManufactureRowState[]
}

export const blankManufactureRow = (): ManufactureRowState => ({ itemId: null, qtyText: '', godownId: null })

/** Pad to the ten rows the screen always shows. */
export function padManufactureRows(rows: ManufactureRowState[]): ManufactureRowState[] {
  const out = [...rows]
  while (out.length < RAW_ROWS_VISIBLE) out.push(blankManufactureRow())
  return out
}

export function emptyManufactureState(date: string): ManufactureFormState {
  return {
    date, number: '', godownId: null, narration: '', finishedItemId: null, qtyText: '', saleRatePaise: null,
    labourPaise: null, labourPosted: true, labourCreditLedgerId: null, rows: padManufactureRows([])
  }
}

/** "2.5" → 2500 thousandths; null for blank or unparseable text. */
export function parseQtyMilli(text: string): number | null {
  const t = text.trim()
  if (t === '') return null
  if (!/^\d*\.?\d*$/.test(t) || t === '.') return null
  const n = Math.round(parseFloat(t) * 1000)
  return Number.isFinite(n) ? n : null
}

const rowIsBlank = (r: ManufactureRowState): boolean => r.itemId == null && r.qtyText.trim() === ''

export interface ManufactureFormEval {
  /** What manufacture:save would receive (profit from `materialPaise`). */
  input: ManufactureInput
  /** input.raw[i] came from form row rowIndex[i]. */
  rowIndex: number[]
  totals: ReturnType<typeof manufactureTotals>
  /** Rule violations, row indices in FORM rows. Empty = savable. */
  issues: ManufactureIssue[]
}

/**
 * Evaluate the form: build the save input and run the shared rules. `materialPaise` is the
 * engine cost of the raw rows from manufacture:costPreview (undefined while it loads — the
 * profit check is then skipped and `pending` should keep Save disabled).
 */
export function evaluateManufactureForm(
  state: ManufactureFormState,
  opts: { voucherTypeId?: number; materialPaise: number | undefined; itemName?: (id: number) => string; confirmLoss?: boolean }
): ManufactureFormEval {
  const rowIndex: number[] = []
  const raw: ManufactureInput['raw'] = []
  state.rows.forEach((r, i) => {
    if (rowIsBlank(r)) return
    rowIndex.push(i)
    raw.push({ stockItemId: r.itemId ?? 0, qtyMilli: parseQtyMilli(r.qtyText) ?? 0, ...(r.godownId != null ? { godownId: r.godownId } : {}) })
  })
  const qtyMilli = parseQtyMilli(state.qtyText) ?? 0
  const labourPaise = state.labourPaise ?? 0
  const saleRatePaise = state.saleRatePaise ?? 0
  const totals = manufactureTotals({ qtyMilli, saleRatePaise, materialPaise: opts.materialPaise ?? 0, labourPaise })
  const input: ManufactureInput = {
    ...(opts.voucherTypeId ? { voucherTypeId: opts.voucherTypeId } : {}),
    date: state.date,
    ...(state.number.trim() ? { number: state.number.trim() } : {}),
    narration: state.narration.trim() || null,
    godownId: state.godownId,
    finishedItemId: state.finishedItemId ?? 0,
    qtyMilli,
    saleRatePaise,
    raw,
    labourPaise,
    labourPosted: state.labourPosted,
    labourCreditLedgerId: state.labourPosted ? state.labourCreditLedgerId : null,
    profitPaise: totals.profit,
    ...(opts.confirmLoss ? { confirmLoss: true } : {})
  }
  const issues = validateManufacture(input, opts.materialPaise, opts.itemName, (i) => rowIndex[i]! + 1).map((x) =>
    x.row !== undefined ? { ...x, row: rowIndex[x.row]! } : x
  )
  return { input, rowIndex, totals, issues }
}

/** Canonical text of what the form would save (profit aside — it follows the live costs). Two
 *  states with the same key save identically; used for the unsaved-changes guard. */
export function manufactureFormKey(state: ManufactureFormState): string {
  const { input } = evaluateManufactureForm(state, { materialPaise: undefined })
  const { profitPaise: _p, ...rest } = input
  return JSON.stringify(rest)
}

/**
 * Reconstruct the form from a saved manufacture (voucher + details row), then rebuild its
 * stock journal from that form (at the saved line costs) and compare with the voucher — only a
 * faithful reconstruction opens in the Manufacture screen.
 */
export function manufactureRepresentation(
  v: Voucher,
  details: ManufactureDetails | null | undefined,
  opts: { itemName: (itemId: number) => string }
): Representation<ManufactureFormState> {
  if (!details) return { ok: false, reason: 'it has no manufacture details' }
  const inv = v.inventory
  const finished = inv[inv.length - 1]
  if (!finished || finished.direction !== 'in' || finished.stockItemId !== details.finishedItemId || inv.length < 2) {
    return { ok: false, reason: 'its last line is not the manufactured item' }
  }
  const outs = inv.slice(0, -1)
  if (outs.some((l) => l.direction !== 'out' || l.isAbsolute || l.batchId != null || l.discountPaise !== 0)) {
    return { ok: false, reason: 'its lines are not raw materials + one finished item' }
  }
  const header = finished.godownId
  const auto = autoManufactureNarration(finished.qtyMilli, opts.itemName(finished.stockItemId))
  const state: ManufactureFormState = {
    date: v.date,
    number: v.number,
    godownId: header,
    narration: v.narration === auto ? '' : (v.narration ?? ''),
    finishedItemId: details.finishedItemId,
    qtyText: qtyText(finished.qtyMilli),
    saleRatePaise: details.saleRatePaise,
    labourPaise: details.labourPaise,
    labourPosted: details.labourPosted,
    labourCreditLedgerId: details.labourCreditLedgerId,
    rows: padManufactureRows(
      outs.map((l) => ({ itemId: l.stockItemId, qtyText: qtyText(l.qtyMilli), godownId: l.godownId === header ? null : l.godownId }))
    )
  }
  const { input, issues } = evaluateManufactureForm(state, { voucherTypeId: v.voucherTypeId, materialPaise: undefined, itemName: opts.itemName })
  if (issues.length > 0) return { ok: false, reason: issues[0]!.message }
  let rebuilt: { ok: true; payload: VoucherPayload } | { ok: false; error: string }
  try {
    rebuilt = {
      ok: true,
      payload: buildManufactureVoucher(input, {
        voucherTypeId: v.voucherTypeId,
        rawCosts: outs.map((l) => l.amount),
        finishedName: opts.itemName(details.finishedItemId),
        labourExpenseLedgerId: details.labourExpenseLedgerId,
        labourCreditLedgerId: details.labourCreditLedgerId
      }) as unknown as VoucherPayload
    }
  } catch (err) {
    rebuilt = { ok: false, error: (err as Error).message }
  }
  return confirmRoundTrip(v, state, rebuilt)
}
