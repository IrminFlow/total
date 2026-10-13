import { screenDef, SIMPLE_ENTRIES } from '../../lib/screens'
import { nextDraftId, type Screen } from '../../state/stores'

/**
 * WP 9.2 — "Record a payment" on a bill: wherever the registry's Money in entry goes. While Money
 * in is still the accountant receipt editor (WP 9.4 replaces it), that editor opens pre-filled
 * with the customer and what is still due on the bill (into cash — change it there); once
 * Money in is a simple screen, it opens that screen.
 */
export function recordPaymentScreen(bill: { partyId: number | null; due: number }, cashId: number | null = null): Screen {
  const entry = SIMPLE_ENTRIES.find((e) => e.id === 'money-in') // i18n-technical: registry id
  const target = entry?.screen
  if (target && screenDef(target.name)?.modes.includes('simple')) return target
  if (bill.partyId == null) return { name: 'voucher-entry', kindHint: 'receipt' } // i18n-technical
  return {
    name: 'voucher-entry', // i18n-technical
    kindHint: 'receipt', // i18n-technical
    draftId: nextDraftId(),
    draft: {
      partyLedgerId: bill.partyId,
      lines:
        bill.due > 0
          ? [...(cashId != null ? [{ ledgerId: cashId, drCr: 'dr' as const, amount: bill.due }] : []), { ledgerId: bill.partyId, drCr: 'cr' as const, amount: bill.due }] // i18n-technical
          : []
    }
  }
}
