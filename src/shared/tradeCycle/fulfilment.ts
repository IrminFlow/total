// Fulfilment arithmetic (WP 2.5, design §2.7) — pure. A source line's "done" quantity is the
// live linked quantity drawn from it; its pending quantity is what is left. A document's status
// is DERIVED from its lines and never stored, except for what the user did by hand (closed /
// cancelled) — the same rule as "voucher lines are the source of truth".

export type TradeDocStatus = 'cancelled' | 'closed' | 'fulfilled' | 'partly_fulfilled' | 'open' | 'expired'

export interface FulfilmentLine {
  lineUid: string
  qtyMilli: number
}

export interface LineFulfilment {
  lineUid: string
  qtyMilli: number
  /** Live fulfilled quantity (never above qtyMilli — capacity is enforced on save). */
  doneMilli: number
  pendingMilli: number
}

/** Done / pending per line from the live linked quantity by source uid. */
export function lineFulfilment(lines: readonly FulfilmentLine[], liveQtyBySourceUid: ReadonlyMap<string, number>): LineFulfilment[] {
  return lines.map((l) => {
    const done = Math.min(l.qtyMilli, Math.max(0, liveQtyBySourceUid.get(l.lineUid) ?? 0))
    return { lineUid: l.lineUid, qtyMilli: l.qtyMilli, doneMilli: done, pendingMilli: l.qtyMilli - done }
  })
}

export interface StatusDoc {
  /** The stored, manual state. */
  status: 'open' | 'closed' | 'cancelled'
  /** Quotations: valid until (inclusive); null = no expiry. */
  validUntil?: string | null
}

/**
 * The shown status: a manual cancel / close wins; otherwise fulfilled (every line done),
 * partly fulfilled (something done), expired (a quotation past `validUntil` with nothing
 * linked), else open.
 */
export function docStatus(
  doc: StatusDoc,
  lines: readonly FulfilmentLine[],
  liveQtyBySourceUid: ReadonlyMap<string, number>,
  asOn: string
): TradeDocStatus {
  if (doc.status === 'cancelled') return 'cancelled'
  if (doc.status === 'closed') return 'closed'
  const f = lineFulfilment(lines, liveQtyBySourceUid)
  const anyDone = f.some((l) => l.doneMilli > 0)
  if (f.length > 0 && f.every((l) => l.pendingMilli === 0)) return 'fulfilled'
  if (anyDone) return 'partly_fulfilled'
  if (doc.validUntil && asOn > doc.validUntil) return 'expired'
  return 'open'
}
