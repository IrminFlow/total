// Trade-cycle report arithmetic (WP 2.5d) — pure, shared by the services and their tests.

import type { OrderBookRow, OrderBookSummaryRow } from './types'

/** Whole days from `from` to `to` (ISO dates). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** part ÷ whole as a percentage to one decimal; null when whole is 0. */
export function pct(part: number, whole: number): number | null {
  if (whole === 0) return null
  return Math.round((part * 1000) / whole) / 10
}

/**
 * Columns for a chain of documents: every node's level is the longest path to it from a node
 * with no incoming link, so each link goes left to right (quotation → order → challan → invoice →
 * credit note). Links can't form a cycle in practice (a target is always saved after its source),
 * but a pathological pair is cut off after `keys.length` rounds.
 */
export function chainLevels(keys: readonly string[], edges: readonly { from: string; to: string }[]): Map<string, number> {
  const level = new Map(keys.map((k) => [k, 0]))
  for (let round = 0; round < keys.length; round++) {
    let changed = false
    for (const e of edges) {
      const f = level.get(e.from)
      const t = level.get(e.to)
      if (f === undefined || t === undefined) continue
      if (t < f + 1) {
        level.set(e.to, f + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  // Compact: no empty columns.
  const used = [...new Set(level.values())].sort((a, b) => a - b)
  const rank = new Map(used.map((v, i) => [v, i]))
  return new Map([...level].map(([k, v]) => [k, rank.get(v)!]))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'YYYY-MM' → 'Apr 2026'. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${MONTHS[(m ?? 1) - 1]} ${y}`
}

/** The order book rolled up by party or by month (cancelled orders never reach here). */
export function summariseOrderBook(rows: readonly OrderBookRow[], by: 'party' | 'month'): OrderBookSummaryRow[] {
  const groups = new Map<string, OrderBookSummaryRow>()
  for (const r of rows) {
    const key = by === 'party' ? `p${r.partyLedgerId}` : r.month
    let g = groups.get(key)
    if (!g) {
      g = {
        key, label: by === 'party' ? r.partyName : monthLabel(r.month), partyLedgerId: by === 'party' ? r.partyLedgerId : null,
        month: by === 'month' ? r.month : null, orders: 0, orderedValue: 0, fulfilledValue: 0, pendingValue: 0, shortClosedValue: 0,
        fulfilledPct: null
      }
      groups.set(key, g)
    }
    g.orders += 1
    g.orderedValue += r.orderedValue
    g.fulfilledValue += r.fulfilledValue
    g.pendingValue += r.pendingValue
    g.shortClosedValue += r.shortClosedValue
  }
  const out = [...groups.values()].map((g) => ({ ...g, fulfilledPct: pct(g.fulfilledValue, g.orderedValue) }))
  return by === 'month'
    ? out.sort((a, b) => a.key.localeCompare(b.key))
    : out.sort((a, b) => b.orderedValue - a.orderedValue || a.label.localeCompare(b.label))
}

export interface DeliveryEvent {
  lineUid: string
  date: string
  qtyMilli: number
}

/**
 * The day an order was fully delivered: per line, the date its cumulative delivered quantity
 * (events in date order) reached the line quantity; the order's is the latest of those. Null while
 * any line is short.
 */
export function fullDeliveryDate(lines: readonly { lineUid: string; qtyMilli: number }[], events: readonly DeliveryEvent[]): string | null {
  let latest: string | null = null
  for (const l of lines) {
    const mine = events.filter((e) => e.lineUid === l.lineUid).sort((a, b) => a.date.localeCompare(b.date))
    let cum = 0
    let at: string | null = null
    for (const e of mine) {
      cum += e.qtyMilli
      if (cum >= l.qtyMilli) {
        at = e.date
        break
      }
    }
    if (!at) return null
    if (!latest || at > latest) latest = at
  }
  return latest
}
