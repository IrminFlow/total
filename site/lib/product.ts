/**
 * The one place a price or a plan is written down.
 *
 * The pricing page, the buy page, the CA page and the checkout API all read from here, so a
 * price can never be right in one place and stale in another. Amounts are integer paise, the
 * same rule the app itself follows: floats never touch money.
 */

export type PlanId = 'annual' | 'perpetual' | 'ca'

export interface Plan {
  id: PlanId
  name: string
  /** Integer paise. Zero means the plan is issued by hand rather than sold. */
  paise: number
  unit: string
  lines: string[]
  /** Companies the licence covers. 0 is unlimited, which is what the CA edition carries. */
  companies: number
  /** Which licence kind the issued key carries. */
  kind: 'annual' | 'perpetual'
  featured?: boolean
}

export const PLANS: Plan[] = [
  {
    id: 'annual',
    name: 'Yearly',
    paise: 499_900,
    unit: 'per business, per year',
    companies: 0,
    kind: 'annual',
    lines: [
      'Every feature, no per-user seats',
      'Updates and new versions while it runs',
      'Unlimited companies on your machine'
    ]
  },
  {
    id: 'perpetual',
    name: 'Own it',
    paise: 1_499_900,
    unit: 'once, yours permanently',
    companies: 0,
    kind: 'perpetual',
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
    lines: [
      'Unlimited client companies',
      'Consolidated reports across clients',
      'Renewed each year on request'
    ]
  }
]

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
