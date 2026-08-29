import { NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/payments'
import { deliver } from '@/lib/store'

export const runtime = 'nodejs'

/**
 * The provider telling us a payment captured, independently of the buyer's browser.
 *
 * This exists because the browser callback is not reliable. Somebody pays by UPI on their phone,
 * the tab times out or gets closed, and the verify route never runs. The webhook still does, so
 * the order is on record and can be filled by hand.
 *
 * It deliberately does not mint a key. Two independent paths issuing keys for the same payment
 * would eventually issue two, and a duplicate licence is a support conversation nobody enjoys.
 * OPERATOR: set RAZORPAY_WEBHOOK_SECRET and point the payment.captured event here.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text()
  const signature = request.headers.get('x-razorpay-signature') ?? ''
  if (!verifyWebhookSignature(raw, signature)) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  let event: {
    event?: string
    payload?: { payment?: { entity?: { id?: string; amount?: number; notes?: Record<string, string> } } }
  }
  try {
    event = JSON.parse(raw) as typeof event
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  if (event.event !== 'payment.captured') return NextResponse.json({ ok: true })

  const payment = event.payload?.payment?.entity
  const notes = payment?.notes ?? {}
  await deliver({
    title: `Payment captured: ${notes.name ?? 'unknown buyer'}`,
    labels: ['order', 'webhook'],
    body: [
      `Payment: ${payment?.id ?? 'unknown'}`,
      `Amount: ${(payment?.amount ?? 0) / 100} rupees`,
      `Plan: ${notes.plan ?? 'unknown'}`,
      `Name: ${notes.name ?? ''}`,
      `Email: ${notes.email ?? ''}`,
      `Coupon: ${notes.coupon || 'none'}`,
      '',
      'Confirm a key went out for this payment before closing.'
    ].join('\n')
  })

  return NextResponse.json({ ok: true })
}
