import { screenDef, SIMPLE_ENTRIES } from '../../lib/screens'
import { nextDraftId, type Screen } from '../../state/stores'

/**
 * WP 9.3 — "Record a payment" on a supplier's bill: wherever the registry's Money out entry goes.
 * While Money out is still the accountant payment editor (WP 9.4 replaces it), that editor opens
 * pre-filled with the supplier and what is still due on the bill (from cash — change it there);
 * once Money out is a simple screen, it opens that screen. (WP 9.2's recordPayment.ts is the same
 * rule for customers.)
 */
export function recordSupplierPaymentScreen(bill: { partyId: number | null; due: number }, cashId: number | null = null): Screen {
  const entry = SIMPLE_ENTRIES.find((e) => e.id === 'money-out') // i18n-technical: registry id
  const target = entry?.screen
  if (target && screenDef(target.name)?.modes.includes('simple')) return target
  if (bill.partyId == null) return { name: 'voucher-entry', kindHint: 'payment' } // i18n-technical
  return {
    name: 'voucher-entry', // i18n-technical
    kindHint: 'payment', // i18n-technical
    draftId: nextDraftId(),
    draft: {
      partyLedgerId: bill.partyId,
      lines:
        bill.due > 0
          ? [{ ledgerId: bill.partyId, drCr: 'dr' as const, amount: bill.due }, ...(cashId != null ? [{ ledgerId: cashId, drCr: 'cr' as const, amount: bill.due }] : [])] // i18n-technical
          : []
    }
  }
}
