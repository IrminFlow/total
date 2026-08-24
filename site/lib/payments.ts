/**
 * Razorpay, UPI first.
 *
 * Razorpay rather than Cashfree for one reason: it settles UPI, and UPI is how this market
 * actually pays for something priced at a few thousand rupees. Cards and net banking come along
 * with it at no extra work, so nothing is lost by starting here.
 *
 * There is no SDK dependency. Order creation is one authenticated POST and signature checking is
 * one HMAC, both of which are stable, documented, and easier to read than a wrapper.
 *
 * NOTHING BELOW WORKS WITHOUT REAL KEYS, and there are none in this repo. Every entry point
 * checks `paymentsConfigured()` first and the buy page says plainly when it is switched off,
 * because a checkout button that fails after the buyer has committed is the worst possible
 * failure in a purchase flow.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const KEY_ID = process.env.RAZORPAY_KEY_ID
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET

export function paymentsConfigured(): boolean {
  return Boolean(KEY_ID && KEY_SECRET)
}

/** The publishable half, safe in the browser. Empty when checkout is switched off. */
export function publicKeyId(): string {
  return KEY_ID ?? ''
}

export interface CreatedOrder {
  orderId: string
  amountPaise: number
  currency: 'INR'
  keyId: string
}

export async function createOrder(input: {
  amountPaise: number
  receipt: string
  notes: Record<string, string>
}): Promise<CreatedOrder> {
  if (!KEY_ID || !KEY_SECRET) throw new Error('payments-not-configured')
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store',
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt,
      notes: input.notes,
      // UPI collect and intent both work under this; the checkout widget offers cards and net
      // banking alongside without any further configuration.
      payment_capture: 1
    })
  })
  if (!res.ok) throw new Error(`razorpay-order-failed-${res.status}`)
  const data = (await res.json()) as { id: string; amount: number }
  return { orderId: data.id, amountPaise: data.amount, currency: 'INR', keyId: KEY_ID }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** The check Razorpay documents for a checkout callback: HMAC of "order_id|payment_id". */
export function verifyPaymentSignature(input: {
  orderId: string
  paymentId: string
  signature: string
}): boolean {
  if (!KEY_SECRET) return false
  const expected = createHmac('sha256', KEY_SECRET)
    .update(`${input.orderId}|${input.paymentId}`)
    .digest('hex')
  return safeEqual(expected, input.signature)
}

/** The check for a server-to-server webhook: HMAC of the raw body, with its own secret. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return false
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')
  return safeEqual(expected, signature)
}
