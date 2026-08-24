/**
 * Localised price display.
 *
 * Total is sold in rupees and charged in rupees. A visitor in Dubai or London still pays the
 * INR amount, and their card issuer does the conversion at a rate we do not control. So this
 * shows a second, clearly-marked indicative figure rather than pretending to quote a local
 * price we cannot honour.
 *
 * Rates are written down by hand and dated. No live FX call: a marketing page that changes its
 * number every hour is worse than one that admits its number is approximate. Update RATES and
 * RATES_REVIEWED together, and never more than one of them.
 */

import { headers } from 'next/headers'
import { rupees } from './product'

export interface LocalRate {
  code: string
  symbol: string
  /** Units of this currency per one rupee. */
  perRupee: number
  /** Round the converted figure to this many units, so the display reads as a price. */
  step: number
}

/** Reviewed by hand. If this date is more than a quarter old, the figures below need a look. */
export const RATES_REVIEWED = '2026-08-01'

const RATES: Record<string, LocalRate> = {
  USD: { code: 'USD', symbol: '$', perRupee: 0.0115, step: 5 },
  GBP: { code: 'GBP', symbol: '£', perRupee: 0.009, step: 5 },
  EUR: { code: 'EUR', symbol: '€', perRupee: 0.0105, step: 5 },
  AED: { code: 'AED', symbol: 'AED ', perRupee: 0.042, step: 25 },
  SGD: { code: 'SGD', symbol: 'S$', perRupee: 0.0153, step: 5 },
  AUD: { code: 'AUD', symbol: 'A$', perRupee: 0.0177, step: 5 },
  CAD: { code: 'CAD', symbol: 'C$', perRupee: 0.0159, step: 5 },
  MYR: { code: 'MYR', symbol: 'RM', perRupee: 0.049, step: 25 },
  ZAR: { code: 'ZAR', symbol: 'R', perRupee: 0.205, step: 50 },
  KES: { code: 'KES', symbol: 'KSh ', perRupee: 1.48, step: 500 }
}

const EURO_COUNTRIES = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' ')

const BY_COUNTRY: Record<string, string> = {
  AE: 'AED', SA: 'AED', QA: 'AED', OM: 'AED', BH: 'AED', KW: 'AED',
  GB: 'GBP',
  SG: 'SGD',
  AU: 'AUD', NZ: 'AUD',
  CA: 'CAD',
  MY: 'MYR',
  ZA: 'ZAR',
  KE: 'KES', TZ: 'KES', UG: 'KES',
  ...Object.fromEntries(EURO_COUNTRIES.map((c) => [c, 'EUR']))
}

/**
 * The visitor's country, from the edge header the platform already sets. Nothing is stored,
 * nothing is scripted into the page, and no third party is asked. If the header is missing we
 * assume India, which is who this is built for.
 */
export async function visitorCountry(): Promise<string> {
  const h = await headers()
  return (h.get('x-vercel-ip-country') ?? 'IN').toUpperCase()
}

export function rateFor(country: string): LocalRate | null {
  if (country === 'IN') return null
  const code = BY_COUNTRY[country] ?? 'USD'
  return RATES[code] ?? null
}

/** "about $175" for a paise amount, or null when the visitor is in India. */
export function approximately(paise: number, rate: LocalRate | null): string | null {
  if (!rate || paise === 0) return null
  const raw = (paise / 100) * rate.perRupee
  const rounded = Math.max(rate.step, Math.round(raw / rate.step) * rate.step)
  return `${rate.symbol}${rounded.toLocaleString('en-US')}`
}

/** "₹4,999" always, because that is what the card is actually charged. */
export function inr(paise: number): string {
  return `₹${rupees(paise)}`
}
