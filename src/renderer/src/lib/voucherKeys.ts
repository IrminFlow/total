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
 * map is from memory, UNVERIFIED), split in WP 2.5d:
 *   Ctrl+F8 credit note · Ctrl+F9 debit note
 *   Alt+F8 delivery note (challan) · Alt+F9 receipt note (GRN)
 * Before WP 2.5b Alt and Ctrl both meant the note. Alt now only ever means the stock note: with
 * `stockNotes` off (Orders & challans not on) Alt+F8 / Alt+F9 do nothing rather than open a
 * credit / debit note. Ctrl+Alt counts as Ctrl. Null when the key isn't a voucher key
 * (Ctrl/Alt+F7 is Manufacture, see above).
 */
export function kindForVoucherKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey'>,
  opts: { stockNotes?: boolean } = {}
): VoucherKind | null {
  const kind = VOUCHER_FKEYS[e.key]
  if (!kind || isManufactureKey(e)) return null
  if (e.ctrlKey) return kind === 'sales' ? 'credit_note' : kind === 'purchase' ? 'debit_note' : kind
  if (e.altKey && (kind === 'sales' || kind === 'purchase')) {
    if (!opts.stockNotes) return null
    return kind === 'sales' ? 'delivery_note' : 'receipt_note'
  }
  return kind
}
