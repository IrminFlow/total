import type { VoucherKind } from '@shared/domain'

/** Tally's voucher F-keys — shared by voucher entry (switch type) and the Gateway (start one). */
export const VOUCHER_FKEYS: Record<string, VoucherKind> = {
  F4: 'contra', F5: 'payment', F6: 'receipt', F7: 'journal', F8: 'sales', F9: 'purchase'
}

/** The voucher kind an F-key press asks for: Ctrl/Alt+F8 is a credit note, Ctrl/Alt+F9 a debit
 *  note; null when the key isn't a voucher key. */
export function kindForVoucherKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey'>): VoucherKind | null {
  const kind = VOUCHER_FKEYS[e.key]
  if (!kind) return null
  const withCtrl = e.ctrlKey || e.altKey
  return withCtrl && kind === 'sales' ? 'credit_note' : withCtrl && kind === 'purchase' ? 'debit_note' : kind
}
