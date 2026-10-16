// "Convert to invoice / bill" from the challan / GRN lists (WP 2.5b lists). Pure: which open
// source lines a conversion draws on, which notes can be converted together, and the list's status
// words. The conversion itself is the editor's own "Add from…" pick (voucherEdit/addFrom.ts
// rowsFromSourcePicks) of every pending line — the invoice / bill form then saves through
// voucher:save, whose line links are written by the TARGET's save (services/tradeLinks.ts, I1–I7).

import type { TradePurpose } from '../domain'
import type { SourcePick } from '../voucherEdit/addFrom'
import type { NoteListStatus, OpenSourceLine, StockNoteListRow } from './types'

export type NoteStage = 'delivery_note' | 'receipt_note'

/** Challan purposes that are supplies awaiting an invoice (GDNI). */
export const GDNI_PURPOSES = ['supply', 'approval'] as const
/** GRN purposes awaiting a bill (GRNI). */
export const GRNI_PURPOSES = ['purchase'] as const

/** The purposes a note of this stage is invoiced / billed for (the GDNI / GRNI purposes). */
export function convertiblePurpose(stage: NoteStage, purpose: TradePurpose): boolean {
  const list: readonly string[] = stage === 'delivery_note' ? GDNI_PURPOSES : GRNI_PURPOSES
  return list.includes(purpose)
}

/** The voucher kind a note converts into. */
export const CONVERT_TARGET: Record<NoteStage, 'sales' | 'purchase'> = { delivery_note: 'sales', receipt_note: 'purchase' }

/** What a conversion draws on: one order (WP 2.5c) or one or more challans / GRNs. */
export interface ConvertSource {
  tradeDocId?: number | null
  voucherIds?: readonly number[] | null
}

/** Every pending line of the given sources, at its full pending quantity, in the open lines'
 *  order (date, document, line) — exactly the picks "Add from…" makes when every line of those
 *  documents is ticked. */
export function convertPicks(lines: readonly OpenSourceLine[], src: ConvertSource): SourcePick[] {
  const vids = new Set(src.voucherIds ?? [])
  return lines
    .filter((l) => l.pendingMilli > 0)
    .filter((l) => (src.tradeDocId != null && l.tradeDocId === src.tradeDocId) || (l.voucherId != null && vids.has(l.voucherId)))
    .map((line) => ({ line, qtyMilli: line.pendingMilli }))
}

/** Rows that can go on ONE invoice / bill: all convertible and of one party. `null` = they can;
 *  otherwise the reason. */
export function convertTogetherProblem(rows: readonly Pick<StockNoteListRow, 'convertible' | 'partyLedgerId'>[]): string | null {
  if (rows.length === 0) return 'Pick the notes to convert'
  if (rows.some((r) => !r.convertible)) return 'Only notes with something pending can be converted'
  const party = rows[0]!.partyLedgerId
  if (party == null || rows.some((r) => r.partyLedgerId !== party)) return 'Pick notes of one party'
  return null
}

/** The list's status words. */
export function noteStatusLabel(stage: NoteStage, status: NoteListStatus, onlyReturned = false): string {
  const done = stage === 'delivery_note' ? 'Invoiced' : 'Billed'
  switch (status) {
    case 'pending': return stage === 'delivery_note' ? 'Not invoiced' : 'Not billed'
    case 'partly': return stage === 'delivery_note' ? 'Partly invoiced' : 'Partly billed'
    case 'done': return onlyReturned ? 'Returned' : done
    case 'closed': return 'Short-closed'
  }
}
