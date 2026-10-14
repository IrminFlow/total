import type { Screen } from '../../state/stores'

/** What a "Record a payment" on a bill passes to Money in / Money out (WP 9.4): the customer or
 *  supplier, the amount (paise) and the bill's name (pre-ticked). Every field is optional. */
export interface MoneyLinkParams {
  party?: number | null
  amount?: number | null
  bill?: string | null
}

const clean = (p: MoneyLinkParams): { party?: number; amount?: number; bill?: string } => ({
  ...(p.party != null ? { party: p.party } : {}),
  ...(p.amount != null && p.amount > 0 ? { amount: p.amount } : {}),
  ...(p.bill ? { bill: p.bill } : {})
})

/**
 * WP 9.4 — the stable targets other simple flows point at: Sell's / Buy's "Record a payment"
 * opens Money in (a customer paid) / Money out (paying a supplier) for that party, amount and bill.
 * The registry entries are `money-in` / `money-out` (screens `simple-money-in` / `simple-money-out`).
 */
export const moneyInScreen = (p: MoneyLinkParams = {}): Screen => ({ name: 'simple-money-in', ...clean(p) }) // i18n-technical
export const moneyOutScreen = (p: MoneyLinkParams = {}): Screen => ({ name: 'simple-money-out', ...clean(p) }) // i18n-technical
