/**
 * The one place a price or a plan is written down — and the price itself is configuration.
 *
 * The pricing page, the buy page, the compare page and the checkout API all read from here, so a
 * price can never be right in one place and stale in another. Amounts are integer paise, the
 * same rule the app itself follows: floats never touch money.
 *
 * THE NUMBER IS NOT IN THIS FILE ON PURPOSE. What a business charges is the owner's decision,
 * and a number invented by whoever wrote the page is a number somebody eventually has to honour.
 * So the two sellable plans read their price from the environment:
 *
 *   TOTAL_PRICE_ANNUAL_INR       whole rupees, e.g. 4999
 *   TOTAL_PRICE_PERPETUAL_INR    whole rupees, e.g. 14999
 *   TOTAL_PAYMENT_LINK           a Razorpay Payment Page or UPI link, if there is no full checkout
 *
 * Unset, or set to something that is not a number, means **not yet announced** — and every page
 * that shows a price is written to render that state honestly rather than print ₹0, "₹NaN", or a
 * plausible-looking placeholder somebody screenshots. See `priceState`.
 *
 * These are read on the server only (no NEXT_PUBLIC_ prefix), because the price is rendered into
 * HTML by server components. Set them in Vercel → Settings → Environment Variables. A change
 * takes effect on the next deploy; every page that reads a price is already dynamic.
 */

export type PlanId = 'annual' | 'perpetual' | 'ca'

/** The environment variable that carries each sellable plan's price, in whole rupees. */
export const PRICE_ENV: Record<'annual' | 'perpetual', string> = {
  annual: 'TOTAL_PRICE_ANNUAL_INR',
  perpetual: 'TOTAL_PRICE_PERPETUAL_INR'
}

/** The environment variable that carries a payment link, for selling before a full checkout exists. */
export const PAYMENT_LINK_ENV = 'TOTAL_PAYMENT_LINK'

/**
 * Whole rupees from the environment, as integer paise. Anything that is not a positive whole
 * number of rupees reads as unannounced rather than as a price, because "0", "TBD" and a typo
 * must never reach a page as a figure. Commas, spaces and a rupee sign are tolerated: an owner
 * pasting "₹4,999" into a Vercel field has said exactly what they meant.
 */
function paiseFromEnv(name: string): number {
  const raw = (process.env[name] ?? '').replace(/[₹,\s]/g, '')
  if (!/^\d+$/.test(raw)) return 0
  const rupeesValue = Number(raw)
  if (!Number.isSafeInteger(rupeesValue) || rupeesValue <= 0) return 0
  return rupeesValue * 100
}

export interface Plan {
  id: PlanId
  name: string
  /**
   * Integer paise. Zero on a sellable plan means the price has not been announced; zero on a
   * plan with `sellable: false` means it is issued by hand and free. `priceState` tells them
   * apart, and nothing should compare this to zero directly.
   */
  paise: number
  unit: string
  lines: string[]
  /** Companies the licence covers. 0 is unlimited, which is what the CA edition carries. */
  companies: number
  /** Which licence kind the issued key carries. */
  kind: 'annual' | 'perpetual'
  /** False for the plans given away rather than sold, which is only the CA edition today. */
  sellable: boolean
  featured?: boolean
}

export const PLANS: Plan[] = [
  {
    id: 'annual',
    name: 'Yearly',
    paise: paiseFromEnv(PRICE_ENV.annual),
    unit: 'per business, per year',
    companies: 0,
    kind: 'annual',
    sellable: true,
    lines: [
      'Every feature, no per-user seats',
      'Updates and new versions while it runs',
      'Unlimited companies on your machine'
    ]
  },
  {
    id: 'perpetual',
    name: 'Own it',
    paise: paiseFromEnv(PRICE_ENV.perpetual),
    unit: 'once, yours permanently',
    companies: 0,
    kind: 'perpetual',
    sellable: true,
    featured: true,
    lines: [
      'The version you buy keeps working forever',
      'One year of updates included',
      'Renew for updates only if you want them'
    ]
  },
  {
    id: 'ca',
    name: 'Chartered accountants',
    paise: 0,
    unit: 'free, with a membership number',
    companies: 0,
    kind: 'annual',
    sellable: false,
    lines: [
      'Unlimited client companies',
      'Consolidated reports across clients',
      'Renewed each year on request'
    ]
  }
]

/**
 * What a page should print where the price goes.
 *
 *  'priced'      — a real figure exists, show it and let people buy.
 *  'free'        — given away, not sold. The CA edition.
 *  'unannounced' — nobody has decided yet. Say so; do not print a number.
 */
export type PriceState = 'priced' | 'free' | 'unannounced'

export function priceState(plan: Plan): PriceState {
  if (!plan.sellable) return 'free'
  return plan.paise > 0 ? 'priced' : 'unannounced'
}

/** The plans that can actually be bought right now: sellable, and with an announced price. */
export function pricedPlans(): Plan[] {
  return PLANS.filter((p) => priceState(p) === 'priced')
}

/** True once at least one price has been set. Pages branch on this, not on a magic zero. */
export function pricingAnnounced(): boolean {
  return pricedPlans().length > 0
}

/**
 * A Razorpay Payment Page or UPI link, for the stretch where a price exists but the full
 * checkout keys do not. Empty string when unset; every caller checks before rendering a button,
 * because a dead payment button is worse than a visible email address.
 */
export function paymentLink(): string {
  const raw = (process.env[PAYMENT_LINK_ENV] ?? '').trim()
  return /^https?:\/\/|^upi:\/\//.test(raw) ? raw : ''
}

export function planById(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id)
}

/** Paise to a plain rupee string with Indian digit grouping. No symbol. */
export function rupees(paise: number): string {
  const whole = Math.round(paise / 100)
  const s = String(whole)
  if (s.length <= 3) return s
  const last3 = s.slice(-3)
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')
  return `${rest},${last3}`
}

export const SALES_EMAIL = 'total@irminflow.com'

/**
 * The support WhatsApp number, from the environment.
 *
 * Deliberately unset by default rather than carrying a plausible-looking placeholder. A fake
 * number on a public page is worse than no number: somebody messages it, reaches a stranger, and
 * concludes the business is not real — and the operator never finds out, because the message went
 * somewhere else. `+91 98220 00000` shipped on four pages before this.
 *
 * Set `NEXT_PUBLIC_WHATSAPP_NUMBER` to the number in international digits, no plus, no spaces
 * (e.g. `919876543210`). Until then `hasWhatsApp` is false and every caller falls back to email.
 */
export const WHATSAPP_NUMBER = (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '').replace(/\D/g, '')

export const hasWhatsApp = WHATSAPP_NUMBER.length >= 10

/** '+91 98765 43210' — for display only; never build a wa.me link from this. */
export const WHATSAPP_DISPLAY = hasWhatsApp
  ? `+${WHATSAPP_NUMBER.slice(0, 2)} ${WHATSAPP_NUMBER.slice(2, 7)} ${WHATSAPP_NUMBER.slice(7)}`
  : ''
