import { NextResponse } from 'next/server'
import { applyCoupon, findCoupon } from '@/lib/coupons'
import { createOrder, paymentsConfigured, publicKeyId } from '@/lib/payments'
import { planById, priceState, rupees } from '@/lib/product'

export const runtime = 'nodejs'

/** Order creation. Nothing is charged here; this reserves an amount for the checkout widget. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!paymentsConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Payment is not switched on for this site yet.' },
      { status: 503 }
    )
  }

  let body: { plan?: string; name?: string; email?: string; coupon?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const plan = planById(String(body.plan ?? ''))
  if (!plan || !plan.sellable) {
    return NextResponse.json({ ok: false, error: 'Choose a plan that is sold online.' }, { status: 400 })
  }
  // An unannounced price must never become an order for zero rupees. Prices come from the
  // environment (see lib/product.ts), so this is the state the site is in before an owner has
  // set TOTAL_PRICE_*_INR, and a checkout that charges nothing is worse than one that is closed.
  if (priceState(plan) !== 'priced') {
    return NextResponse.json(
      { ok: false, error: 'The price for that plan has not been published yet. Write to us and we will send a payment link.' },
      { status: 503 }
    )
  }

  const name = String(body.name ?? '').trim()
  const email = String(body.email ?? '').trim()
  if (name.length < 2) {
    return NextResponse.json({ ok: false, error: 'The licence needs a name on it.' }, { status: 400 })
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: 'That email address does not look right.' }, { status: 400 })
  }

  const today = new Date().toISOString().slice(0, 10)
  const coupon = findCoupon(body.coupon, today)
  const amountPaise = applyCoupon(plan.paise, coupon)

  try {
    const order = await createOrder({
      amountPaise,
      // Razorpay caps the receipt at 40 characters, so this is short by necessity.
      receipt: `${plan.id}-${Date.now().toString(36)}`,
      notes: {
        plan: plan.id,
        name,
        email,
        coupon: coupon?.code ?? '',
        partner: coupon?.partner ?? ''
      }
    })
    return NextResponse.json({
      ok: true,
      orderId: order.orderId,
      keyId: publicKeyId(),
      amountPaise: order.amountPaise,
      label: `Total, ${plan.name}, ₹${rupees(amountPaise)}`
    })
  } catch {
    return NextResponse.json(
      { ok: false, error: 'The payment provider did not accept the order. Nothing has been charged.' },
      { status: 502 }
    )
  }
}
