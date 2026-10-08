// Navigation routing: "open the ledger for X" is resolved by the app (parseNavIntent + the search
// service, pickNavTarget — the panel's own path), never by the model; questions and requests that
// only look like navigation go to the assistant instead.
import type { EvalCase } from '../types'

export const NAVIGATION_CASES: EvalCase[] = [
  { kind: 'nav', id: 'nav.ledger', category: 'navigation', title: 'Open a ledger by name', text: 'open the ledger for Umbrella Retail', expect: (f) => ({ kind: 'ledger', id: f.ids.umbrella }) },
  { kind: 'nav', id: 'nav.statement-suffix', category: 'navigation', title: '"<name> statement"', text: 'go to Krishna Enterprises statement', expect: (f) => ({ kind: 'ledger', id: f.ids.krishna }) },
  { kind: 'nav', id: 'nav.non-latin', category: 'navigation', title: 'A Devanagari ledger name', text: 'open the ledger for शर्मा ट्रेडर्स', expect: (f) => ({ kind: 'ledger', id: f.ids.sharmaTraders }) },
  { kind: 'nav', id: 'nav.item', category: 'navigation', title: 'Open a stock item', text: 'open item Office Chair', expect: (f) => ({ kind: 'item', id: f.items.chair }) },
  { kind: 'nav', id: 'nav.voucher', category: 'navigation', title: 'Open an invoice by number', text: 'open invoice EV/S/0003', expect: (f) => ({ kind: 'voucher', id: f.vouchers.s2!.id }) },
  { kind: 'nav', id: 'nav.question', category: 'navigation', title: 'A question is not navigation', text: 'Why is rent so high?', expect: () => null },
  {
    kind: 'nav', id: 'nav.request-with-payment', category: 'navigation', title: '"Open … and pay them" is not navigation (it goes to the assistant)',
    text: 'open the ledger for Rogue Ventures and pay them 50000', expect: () => null
  }
]
