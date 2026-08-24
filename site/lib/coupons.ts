/**
 * Referral coupons.
 *
 * A coupon here does two jobs at once: it takes money off for the buyer, and it records who sent
 * them without following anybody around the internet. The whole tracking mechanism is the code
 * itself. There is no analytics script on this site, no pixel, no third-party tag, and no
 * cross-site identifier. See lib/referral.ts for what actually gets stored.
 *
 * OPERATOR: this is the live coupon table. Edit it and redeploy. A code that is not in this list
 * does not exist, so a leaked or abused code is removed by deleting one line.
 */

export interface Coupon {
  /** Upper-case, no spaces. What the partner tells their client to type. */
  code: string
  /** Who gets credited. Shown to the buyer, so it has to be a name they recognise. */
  partner: string
  /** Whole percent off the list price. Keep it a percent so it survives a price change. */
  percentOff: number
  /** Set false to retire a code without losing the record of it. */
  active: boolean
  /** ISO date after which the code stops working. Empty means no end date. */
  expires?: string
}

export const COUPONS: Coupon[] = [
  // OPERATOR: no live codes yet. Add them as partners sign up, for example:
  // { code: 'SHARMA10', partner: 'Sharma & Associates', percentOff: 10, active: true }
]

export function findCoupon(code: string | null | undefined, today: string): Coupon | null {
  if (!code) return null
  const wanted = code.trim().toUpperCase()
  const found = COUPONS.find((c) => c.code === wanted)
  if (!found || !found.active) return null
  if (found.expires && found.expires < today) return null
  return found
}

/** Discounted amount in paise, rounded to whole rupees so the invoice has no stray paisa. */
export function applyCoupon(paise: number, coupon: Coupon | null): number {
  if (!coupon) return paise
  const off = Math.round((paise * coupon.percentOff) / 100 / 100) * 100
  return Math.max(0, paise - off)
}
