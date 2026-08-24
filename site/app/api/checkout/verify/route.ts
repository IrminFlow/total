import { NextResponse } from 'next/server'
import { findCoupon } from '@/lib/coupons'
import { canMint, deliverLicence, mintLicence } from '@/lib/licence'
import { verifyPaymentSignature } from '@/lib/payments'
import { planById, SALES_EMAIL } from '@/lib/product'
import { deliver } from '@/lib/store'

export const runtime = 'nodejs'

/**
 * The callback from the checkout widget, after the buyer has paid.
 *
 * The signature check is the only thing that makes this trustworthy: without it, anybody could
 * post an order id and be issued a key. The webhook route is the belt to this braces, for the
 * case where the buyer closes the tab between paying and this request arriving.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, string>
  try {
    body = (await request.json()) as Record<string, string>
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const orderId = String(body.razorpay_order_id ?? '')
  const paymentId = String(body.razorpay_payment_id ?? '')
  const signature = String(body.razorpay_signature ?? '')
  if (!verifyPaymentSignature({ orderId, paymentId, signature })) {
    return NextResponse.json({ ok: false, error: 'That payment could not be verified.' }, { status: 400 })
  }

  const plan = planById(String(body.plan ?? ''))
  const name = String(body.name ?? '').trim()
  const email = String(body.email ?? '').trim()
  const phone = String(body.phone ?? '').replace(/\D/g, '')
  const today = new Date().toISOString().slice(0, 10)
  const coupon = findCoupon(body.coupon, today)

  // Recorded whether or not a key can be minted here, because this is the record that somebody
  // paid. A payment with no trace of it is the one failure that cannot be repaired later.
  const record = await deliver({
    title: `Paid: ${name} (${plan?.name ?? 'unknown plan'})`,
    labels: ['order'],
    body: [
      `Payment: ${paymentId}`,
      `Order: ${orderId}`,
      `Plan: ${plan?.id ?? 'unknown'}`,
      `Name: ${name}`,
      `Email: ${email}`,
      `WhatsApp: ${phone || 'not given'}`,
      coupon ? `Coupon: ${coupon.code} (${coupon.partner}, ${coupon.percentOff}% off)` : 'Coupon: none',
      `Key issued automatically: ${canMint() ? 'yes' : 'no, mint and send by hand'}`
    ].join('\n')
  })

  if (!plan || !canMint()) {
    return NextResponse.json({
      ok: true,
      message: `Your payment went through. The key is issued by hand and will reach ${email} today. If it has not arrived by this evening, write to ${SALES_EMAIL} and quote payment ${paymentId}.`,
      recorded: record.stored || record.forwarded
    })
  }

  const key = mintLicence(
    { name, plan: plan.kind, years: 1, companies: plan.companies },
    today
  )
  if (!key) {
    return NextResponse.json({
      ok: true,
      message: `Your payment went through. The key will reach ${email} today. Quote payment ${paymentId} if you need to chase it.`
    })
  }

  const sent = await deliverLicence({ email, phone: phone || undefined, name, key })

  return NextResponse.json({
    ok: true,
    licenceKey: key,
    message:
      sent.email === 'sent'
        ? `A copy is on its way to ${email}.`
        : `Copy the key from this page. Sending it to ${email} did not work, so keep this open until it is pasted into Total.`
  })
}
