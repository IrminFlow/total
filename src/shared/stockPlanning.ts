/**
 * Stock planning maths (WP 2.3) — pure. Reorder planning, expiry windows and the barcode label
 * sheet. Quantities are integer thousandths, money integer paise.
 */
import { code128Svg } from './code128'
import type { SerialStatus } from './serials'

// ---------- report row shapes (main → renderer) ----------

/** One line of the item movement register (stock:movements). */
export interface StockMovementRow {
  lineId: number
  voucherId: number
  date: string
  number: string
  voucherType: string
  kind: string
  /** Party ledger name, else the narration. */
  particulars: string
  partyLedgerId: number | null
  narration: string | null
  godownId: number | null
  godownName: string | null
  batchId: number | null
  batchName: string | null
  expiryDate: string | null
  /** Physical-count line: the in/out figures are the booked adjustment. */
  isAbsolute: boolean
  inwardQtyMilli: number
  outwardQtyMilli: number
  /** Stored rate on the line (paise per unit). */
  ratePaise: number
  /** Engine value of the movement: inward value booked, or outward cost charged (≥ 0 normally). */
  value: number
  runningQtyMilli: number
  runningValue: number
  serials: string[]
}

export interface StockMovementRegister {
  item: { id: number; name: string; unitSymbol: string; decimals: number; valuationMethod: 'weighted_avg' | 'fifo' }
  from: string
  to: string
  godownId: number | null
  opening: { qtyMilli: number; value: number }
  rows: StockMovementRow[]
  totals: { inwardQtyMilli: number; inwardValue: number; outwardQtyMilli: number; outwardValue: number }
  closing: { qtyMilli: number; value: number }
}

/** Reorder planning row (stock:reorder). */
export interface ReorderRow {
  stockItemId: number
  name: string
  unitSymbol: string
  decimals: number
  reorderLevelMilli: number
  closingQtyMilli: number
  /** Outward quantity over the window (valuation pass). */
  consumedMilli: number
  avgMonthlyMilli: number
  monthsOfCover: number | null
  below: boolean
  /** max(0, reorder × 2 − closing) for rows below the level; 0 otherwise. */
  suggestedMilli: number
}

/** Expiry report row (stock:expiryReport). */
export interface ExpiryReportRow {
  batchId: number
  batchName: string
  stockItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  mfgDate: string | null
  expiryDate: string
  closingQtyMilli: number
  daysToExpiry: number
}

/** Serial register row (serials:list). */
export interface SerialListRow {
  stockItemId: number
  itemName: string
  serial: string
  status: SerialStatus
  godownId: number | null
  godownName: string | null
  batchId: number | null
  batchName: string | null
  inwardVoucherId: number
  /** "Purchase 12 · 03-May-26"-style label parts of the voucher that brought it in. */
  inwardLabel: string
  outwardVoucherId: number | null
  outwardLabel: string | null
}

/** Days in [from, to], both inclusive (ISO dates, UTC). At least 1. */
export function daysInclusive(from: string, to: string): number {
  const d = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000) + 1
  return Math.max(1, d)
}

/**
 * Average monthly consumption over a window: outward quantity (from the valuation pass — every
 * outward movement in the window, physical-count write-downs included) scaled to a 30-day month:
 *
 *   avgMonthlyMilli = round(outwardMilli × 30 / days in window)
 */
export function averageMonthlyConsumption(outwardMilli: number, from: string, to: string): number {
  return Math.round((outwardMilli * 30) / daysInclusive(from, to))
}

/**
 * Suggested order quantity for an item at or below its reorder level — refill to twice the
 * reorder level:
 *
 *   suggested = max(0, reorder level × 2 − closing)
 *
 * (A negative closing is counted as is, so the suggestion also covers the overdraw.)
 */
export function suggestedOrderQty(reorderLevelMilli: number, closingMilli: number): number {
  return Math.max(0, reorderLevelMilli * 2 - closingMilli)
}

/** Below reorder: strictly less than the level (a level of 0 never triggers). */
export const isBelowReorder = (closingMilli: number, reorderLevelMilli: number | null): boolean =>
  reorderLevelMilli != null && reorderLevelMilli > 0 && closingMilli < reorderLevelMilli

/** Months of stock left at the average rate (null when nothing is consumed). One decimal. */
export function monthsOfCover(closingMilli: number, avgMonthlyMilli: number): number | null {
  if (avgMonthlyMilli <= 0) return null
  return Math.round((Math.max(0, closingMilli) * 10) / avgMonthlyMilli) / 10
}

/** Whole days from `asOn` to `expiry` (negative = already expired). */
export function daysToExpiry(expiry: string, asOn: string): number {
  return Math.round((Date.parse(expiry + 'T00:00:00Z') - Date.parse(asOn + 'T00:00:00Z')) / 86_400_000)
}

/** Expiry report filter: expired, or expiring within `days` of `asOn` (inclusive). */
export const expiresWithin = (expiry: string, asOn: string, days: number): boolean => daysToExpiry(expiry, asOn) <= days

// ---------- barcode labels ----------

export interface LabelItem {
  name: string
  barcode: string | null
  /** Pre-formatted price text ("₹ 1,250.00") or null for none. */
  priceText: string | null
  copies: number
}

export interface LabelSheetOptions {
  /** Shown small on each label (company name). */
  caption?: string
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Barcode text a label can actually encode (Code-128 B/C: ASCII 32–127), else null. */
export function encodableBarcode(barcode: string | null): string | null {
  if (!barcode) return null
  return /^[\x20-\x7f]+$/.test(barcode) ? barcode : null
}

/**
 * One printable HTML document: A4, 3 × 7 labels of 63.5 × 38.1 mm (the common 21-up sheet), each
 * with the item name, its Code-128 barcode (SVG, generated in-house) with the human-readable
 * text, and the price. Items repeat `copies` times; a missing/unencodable barcode prints the name
 * and price with a "no barcode" note.
 */
export function labelSheetHtml(items: readonly LabelItem[], opts: LabelSheetOptions = {}): string {
  const labels: string[] = []
  for (const it of items) {
    const code = encodableBarcode(it.barcode)
    const svg = code ? code128Svg(code, { moduleWidth: 2, height: 56, quietZone: 10 }) : null
    const cell =
      `<div class="label">` +
      `<div class="name">${esc(it.name)}</div>` +
      (svg
        ? `<div class="bars">${svg}</div><div class="code">${esc(code!)}</div>`
        : `<div class="nobars">no barcode set</div>`) +
      `<div class="foot"><span class="price">${it.priceText ? esc(it.priceText) : ''}</span>` +
      `<span class="cap">${opts.caption ? esc(opts.caption) : ''}</span></div>` +
      `</div>`
    for (let n = 0; n < Math.max(0, Math.floor(it.copies)); n++) labels.push(cell)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Barcode labels</title><style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Helvetica, Arial, sans-serif; color: #000; background: #fff; }
.sheet { display: grid; grid-template-columns: repeat(3, 63.5mm); grid-auto-rows: 38.1mm;
  column-gap: 2.5mm; padding: 15.15mm 7.25mm; }
.label { padding: 2mm 3mm; overflow: hidden; display: flex; flex-direction: column; break-inside: avoid; }
.name { font-size: 9pt; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bars { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
.bars svg { max-width: 100%; height: 14mm; }
.code { font-family: Menlo, Consolas, monospace; font-size: 7pt; text-align: center; letter-spacing: 0.5pt; }
.nobars { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 7pt; color: #666; }
.foot { display: flex; justify-content: space-between; align-items: baseline; margin-top: 0.5mm; }
.price { font-size: 10pt; font-weight: 700; }
.cap { font-size: 6pt; color: #555; }
</style></head><body><div class="sheet">${labels.join('')}</div></body></html>`
}
