/**
 * Serial-number rules (WP 2.3) — pure, no DB. Items flagged `track_serials` carry one serial per
 * whole unit on every (non-physical-count) inventory line; `serial_numbers` is a projection of
 * those line serials, rebuilt by walking the item's live lines in voucher order
 * (src/main/services/serials.ts). The line serials are the source of truth — exactly like
 * voucher lines are for balances — so binning a voucher (or restoring it) simply re-walks.
 *
 * Rules:
 *  1. Line count: a serial-tracked line moves whole units and names exactly one serial per unit
 *     (qtyMilli = 1000 × serials.length) — outward AND inward, so stock never enters unnamed.
 *     Physical-count lines name none (a count pins quantity, it doesn't move units).
 *     Items that don't track serials carry none (the server drops them).
 *  2. No serial twice in one voucher for the same item and direction.
 *  3. Lifecycle: a serial can be in stock once. Inward of a serial already in stock is refused;
 *     outward of a serial that isn't in stock (never came in, or already went out) is refused.
 *     Within one voucher the outward lines are walked before the inward lines, so a godown
 *     transfer (out of A, into B) of the same serial is fine.
 *  4. Status after the last movement: inward → 'in_stock'; outward on a sales voucher → 'sold';
 *     on a debit note (purchase return) → 'returned'; on a delivery challan → 'delivered' (then
 *     'sold' once a live invoice line drawn from that challan line names it); any other outward (stock journal /
 *     manufacture consumption, journals) → 'consumed'. Only 'in_stock' serials can go out.
 *  5. A binned (soft-deleted) or optional voucher's serials don't count: binning a sale releases
 *     its serials back into stock; restoring it re-applies them (and is refused if one was
 *     re-sold in the meantime). Post-dated vouchers do count — they reserve their serials.
 */

import type { VoucherKind } from './domain'

export type SerialStatus = 'in_stock' | 'sold' | 'consumed' | 'returned' | 'delivered'

export const SERIAL_MAX_LENGTH = 60

/** Split typed/pasted serials: one per line or comma-separated; trims; drops blanks. */
export function parseSerialText(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** The status a serial lands in after an outward line of this voucher kind. */
export function outwardSerialStatus(kind: VoucherKind): SerialStatus {
  if (kind === 'sales') return 'sold'
  if (kind === 'debit_note') return 'returned'
  // WP 2.5 (§9 Q7): out on a delivery challan; becomes 'sold' once invoiced (services/serials.ts).
  if (kind === 'delivery_note') return 'delivered'
  return 'consumed'
}

export interface SerialLine {
  stockItemId: number
  qtyMilli: number
  direction: 'in' | 'out'
  isAbsolute?: boolean
  serials?: readonly string[]
}

/** Rule 1 for one line of a serial-TRACKED item; null when the line is fine. */
export function lineSerialError(line: SerialLine, itemName: string): string | null {
  const serials = line.serials ?? []
  if (line.isAbsolute) {
    return serials.length > 0 ? `${itemName}: a physical count can't name serial numbers` : null
  }
  for (const s of serials) {
    if (s.trim() !== s || s === '') return `${itemName}: serial numbers can't be blank or padded with spaces`
    if (s.length > SERIAL_MAX_LENGTH) return `${itemName}: serial "${s.slice(0, 20)}…" is longer than ${SERIAL_MAX_LENGTH} characters`
  }
  if (line.qtyMilli % 1000 !== 0) return `${itemName} tracks serial numbers — move whole units only`
  const units = line.qtyMilli / 1000
  if (serials.length !== units) {
    return `${itemName} tracks serial numbers — ${units} unit${units === 1 ? '' : 's'} need${units === 1 ? 's' : ''} ${units} serial number${units === 1 ? '' : 's'} (got ${serials.length})`
  }
  return null
}

/** Rules 1–2 over a voucher's lines. `tracked` maps each serial-tracked item id to its name;
 *  lines of other items are ignored here (their serials are dropped on save). */
export function voucherSerialErrors(lines: readonly SerialLine[], tracked: ReadonlyMap<number, string>): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const l of lines) {
    const name = tracked.get(l.stockItemId)
    if (name === undefined) continue
    const e = lineSerialError(l, name)
    if (e) errors.push(e)
    for (const s of l.serials ?? []) {
      const key = `${l.stockItemId}|${l.direction}|${s}`
      if (seen.has(key)) errors.push(`${name}: serial ${s} appears twice on this voucher`)
      seen.add(key)
    }
  }
  return errors
}

/** One serial on one live line, in walk order (see walkSerials). */
export interface SerialEvent {
  stockItemId: number
  serial: string
  direction: 'in' | 'out'
  lineId: number
  voucherId: number
  /** "Sales 12 (03-05-2026)" — for error messages. */
  voucherLabel: string
  kind: VoucherKind
  godownId: number | null
  batchId: number | null
}

export interface SerialRecord {
  stockItemId: number
  serial: string
  status: SerialStatus
  /** Line that last brought it in. */
  inwardLineId: number
  /** Line that last took it out; null while in stock. */
  outwardLineId: number | null
  godownId: number | null
  batchId: number | null
}

export type SerialWalk = { ok: true; records: SerialRecord[] } | { ok: false; error: string }

/** Sort key helper for callers: events of one voucher go outward-first (rule 3). */
export const serialDirectionOrder = (d: 'in' | 'out'): number => (d === 'out' ? 0 : 1)

/**
 * Rule 3–4: walk the events (already in order: date, voucher id, outward before inward, line
 * order) and return each serial's final record, or the first conflict.
 */
export function walkSerials(events: readonly SerialEvent[], itemName: (id: number) => string = () => 'Item'): SerialWalk {
  const state = new Map<string, SerialRecord & { lastLabel: string }>()
  for (const e of events) {
    const key = `${e.stockItemId}|${e.serial}`
    const cur = state.get(key)
    if (e.direction === 'in') {
      if (cur && cur.status === 'in_stock') {
        return {
          ok: false,
          error: `${itemName(e.stockItemId)}: serial ${e.serial} is already in stock (from ${cur.lastLabel}) — ${e.voucherLabel} can't bring it in again`
        }
      }
      state.set(key, {
        stockItemId: e.stockItemId, serial: e.serial, status: 'in_stock', inwardLineId: e.lineId, outwardLineId: null,
        godownId: e.godownId, batchId: e.batchId, lastLabel: e.voucherLabel
      })
    } else {
      if (!cur || cur.status !== 'in_stock') {
        const why = cur ? `it already went out on ${cur.lastLabel}` : 'it never came in'
        return { ok: false, error: `${itemName(e.stockItemId)}: serial ${e.serial} is not in stock for ${e.voucherLabel} — ${why}` }
      }
      state.set(key, { ...cur, status: outwardSerialStatus(e.kind), outwardLineId: e.lineId, godownId: e.godownId ?? cur.godownId, lastLabel: e.voucherLabel })
    }
  }
  return {
    ok: true,
    records: [...state.values()].map(({ lastLabel: _l, ...r }) => r)
  }
}
