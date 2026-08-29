/**
 * Word-of-mouth tracking that does not track people.
 *
 * The whole mechanism: a partner hands out a link like /r/SHARMA10. That route writes one
 * first-party cookie holding the code and nothing else, and the buy page reads it to prefill the
 * coupon box. When an order is placed the code is recorded against the order, so the partner can
 * be paid.
 *
 * What is deliberately absent: no analytics script, no pixel, no fingerprint, no IP address kept,
 * no device or browser identifier, no third-party domain involved at any point, and no way to
 * follow a visitor who never buys. If someone visits with a code and never comes back, we learn
 * nothing and have nothing. That is the trade, and it is the right one for a product whose whole
 * claim is that it does not phone home.
 */

export const REF_COOKIE = 'total_ref'

/** Ninety days. Long enough for a CA to recommend it and the client to get round to buying. */
export const REF_MAX_AGE = 60 * 60 * 24 * 90

/** Codes are short and upper-case; anything else is not one of ours and is dropped. */
export function normaliseCode(raw: string): string | null {
  const code = raw.trim().toUpperCase()
  return /^[A-Z0-9]{3,24}$/.test(code) ? code : null
}
