import { screenDef, SIMPLE_ENTRIES } from '../../lib/screens'
import { nextDraftId, type Screen } from '../../state/stores'
import { moneyInScreen } from '../money/moneyLinks'

/**
 * WP 9.2 — "Record a payment" on a bill: wherever the registry's Money in entry goes. WP 9.4: it
 * is the simple Money in, opened for the customer, what is still due and that bill (pre-ticked —
 * moneyLinks.ts); were Money in the accountant receipt editor again, that editor opens
 * pre-filled with the customer and what is still due (into cash — change it there).
 */
export function recordPaymentScreen(bill: { partyId: number | null; due: number; number?: string }, cashId: number | null = null): Screen {
  const entry = SIMPLE_ENTRIES.find((e) => e.id === 'money-in') // i18n-technical: registry id
  const target = entry?.screen
  if (target && screenDef(target.name)?.modes.includes('simple')) return moneyInScreen({ party: bill.partyId, amount: bill.due, bill: bill.number ?? null })
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
