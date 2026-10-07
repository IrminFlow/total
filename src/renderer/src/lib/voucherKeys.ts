import type { VoucherKind } from '@shared/domain'

/** Tally's voucher F-keys — shared by voucher entry (switch type) and the Gateway (start one). */
export const VOUCHER_FKEYS: Record<string, VoucherKind> = {
  F4: 'contra', F5: 'payment', F6: 'receipt', F7: 'journal', F8: 'sales', F9: 'purchase'
}

/** Alt+F7 (or Ctrl+F7) — Tally's stock-journal key — opens the Manufacture screen (WP 2.2). */
export function isManufactureKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey'>): boolean {
  return e.key === 'F7' && (e.ctrlKey || e.altKey)
}

/**
 * The voucher kind an F-key press asks for. Tally-style (design §5.3 / §9 Q10 — the Tally key
 * map is from memory, UNVERIFIED): Ctrl+F8 credit note, Alt+F8 delivery note (challan), Ctrl+F9
 * debit note, Alt+F9 receipt note (GRN). Before WP 2.5b Alt and Ctrl both meant the note; the
 * stock notes only answer when `stockNotes` is on (the challan / GRN screens are available),
 * otherwise Alt keeps its old meaning. Null when the key isn't a voucher key (Ctrl/Alt+F7 is
 * Manufacture, see above).
 */
export function kindForVoucherKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey'>,
  opts: { stockNotes?: boolean } = {}
): VoucherKind | null {
  const kind = VOUCHER_FKEYS[e.key]
  if (!kind || isManufactureKey(e)) return null
  if (opts.stockNotes && e.altKey && !e.ctrlKey) {
    if (kind === 'sales') return 'delivery_note'
    if (kind === 'purchase') return 'receipt_note'
  }
  const withCtrl = e.ctrlKey || e.altKey
  return withCtrl && kind === 'sales' ? 'credit_note' : withCtrl && kind === 'purchase' ? 'debit_note' : kind
}
