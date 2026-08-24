/**
 * A UPI payment intent, as a link a phone can open and a QR can carry.
 *
 * An invoice that tells a customer what they owe and then leaves them to type an account number
 * into a banking app is an invoice that gets paid late. A UPI QR on the face of it turns "I'll
 * transfer it" into a five-second act, and this market pays by UPI more than by anything else.
 *
 * The format is the NPCI deep-link spec: `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…`. Every UPI app
 * on the phone understands it, which is why this is a plain link rather than an integration —
 * there is no API to call, no gateway to sign up for, and no fee.
 */

/**
 * A UPI virtual payment address: `name@handle`.
 *
 * Deliberately strict about the shape and deliberately silent about which handles exist. A typo
 * in a VPA does not bounce — the money goes somewhere, or nowhere, and the sender's app says it
 * succeeded either way. Rejecting an obviously malformed one at entry is the only check that can
 * be made locally; validating the handle against a list would go stale and start rejecting real
 * addresses.
 */
const VPA_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.]{1,63}$/

export function isValidVpa(vpa: string): boolean {
  return VPA_RE.test(vpa.trim())
}

export interface UpiIntent {
  /** The VPA money goes to. */
  vpa: string
  /** Payee name shown in the payer's app before they confirm. */
  payeeName: string
  /** Amount in paise. Omit (or pass null) for an open-amount QR the payer fills in. */
  amountPaise?: number | null
  /** Transaction note — the invoice number, so a payment can be tied back to it. */
  note?: string | null
}

/** Rupees, to two decimals, from integer paise — the `am` parameter's required form. */
function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * Build the intent URL, or null when it cannot be built honestly.
 *
 * Null rather than a partial link: a UPI QR that opens an app with the wrong payee, or with no
 * amount when one was meant, is worse than no QR at all — the customer believes they have paid.
 *
 * A zero or negative amount produces an open-amount intent rather than an `am=0.00` one, because
 * some apps reject a zero amount outright and others send zero rupees.
 */
export function upiIntentUrl(intent: UpiIntent): string | null {
  const vpa = intent.vpa.trim()
  const payeeName = intent.payeeName.trim()
  if (!isValidVpa(vpa) || !payeeName) return null

  const params: [string, string][] = [
    ['pa', vpa],
    ['pn', payeeName]
  ]
  if (intent.amountPaise != null && intent.amountPaise > 0) {
    params.push(['am', rupees(intent.amountPaise)])
  }
  params.push(['cu', 'INR'])
  if (intent.note?.trim()) {
    // The note surfaces in the payer's statement, so it is trimmed to something a bank field
    // will actually keep rather than truncate mid-word at an arbitrary point.
    params.push(['tn', intent.note.trim().slice(0, 50)])
  }

  return `upi://pay?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}
