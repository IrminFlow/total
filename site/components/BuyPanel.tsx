'use client'

import { useState } from 'react'

/**
 * The checkout form.
 *
 * Two things it deliberately does not do. It does not pretend to work when no payment key is
 * configured: `enabled` comes from the server and switches the whole panel to a plain message
 * with an email address, because a button that fails after a buyer has committed is the worst
 * failure a purchase flow has. And it does not show a spinner and hope: every path ends in a
 * sentence saying what happened and what to do next.
 */

interface RazorpayHandlerResponse {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}

interface RazorpayOptions {
  key: string
  amount: number
  currency: string
  name: string
  description: string
  order_id: string
  prefill: { name: string; email: string; contact: string }
  notes: Record<string, string>
  theme: { color: string }
  handler: (response: RazorpayHandlerResponse) => void
  modal: { ondismiss: () => void }
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => { open: () => void }
  }
}

function loadCheckout(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  if (window.Razorpay) return Promise.resolve(true)
  return new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload = () => resolve(Boolean(window.Razorpay))
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })
}

type Stage = 'form' | 'working' | 'paid' | 'failed'

export default function BuyPanel(props: {
  enabled: boolean
  plans: { id: string; name: string; price: string; unit: string }[]
  initialPlan: string
  initialCoupon: string
  salesEmail: string
  /** A Razorpay Payment Page or UPI link, used when there is a price but no checkout keys. */
  paymentLink?: string
}): React.JSX.Element {
  const [plan, setPlan] = useState(props.initialPlan)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [coupon, setCoupon] = useState(props.initialCoupon)
  const [stage, setStage] = useState<Stage>('form')
  const [message, setMessage] = useState('')
  const [licenceKey, setLicenceKey] = useState('')

  // No plan carries an announced price yet, which is the state the site ships in: the figures
  // come from the environment (TOTAL_PRICE_*_INR) and nobody has set one. Say that, rather than
  // offer a form that would submit a purchase for an amount nobody has decided.
  if (props.plans.length === 0) {
    return (
      <div className="callout warn buy-card">
        <p>
          <b>The price has not been published yet.</b>
        </p>
        <p>
          Everything else here works: the trial is the whole product for thirty days, and it asks
          for no card and no account. Write to{' '}
          <a href={`mailto:${props.salesEmail}`}>{props.salesEmail}</a> and you will get the figure
          and a payment link the same day, before it goes on the site.
        </p>
      </div>
    )
  }

  if (!props.enabled) {
    // A price exists but the checkout keys do not. A payment link is a complete way to sell —
    // Razorpay's own hosted page takes UPI, cards and net banking — so use it if there is one.
    if (props.paymentLink) {
      return (
        <div className="buy-card">
          <h3>Pay by UPI or card</h3>
          <p className="buy-help">
            The payment page is hosted by the payment provider and takes UPI, cards and net
            banking. Put the name the licence should carry and the email to send the key to in the
            fields it shows you.
          </p>
          <ul className="plain-list" style={{ marginTop: 0 }}>
            {props.plans.map((p) => (
              <li key={p.id}>
                <b>{p.name}</b>, {p.price} {p.unit}
              </li>
            ))}
          </ul>
          <a className="btn" href={props.paymentLink}>
            Go to the payment page
          </a>
          <p className="buy-help">
            Keys are issued by hand at this stage, so allow a few hours rather than a few seconds.
            If one is slow, write to <a href={`mailto:${props.salesEmail}`}>{props.salesEmail}</a>{' '}
            and quote the payment reference.
          </p>
        </div>
      )
    }

    return (
      <div className="callout warn buy-card">
        <p>
          <b>Card and UPI payment is not switched on yet.</b>
        </p>
        <p>
          Write to <a href={`mailto:${props.salesEmail}`}>{props.salesEmail}</a> with the plan you
          want and the name the licence should carry. You will get a payment link and the key by
          email and WhatsApp the same day.
        </p>
      </div>
    )
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setStage('working')
    setMessage('')

    const ready = await loadCheckout()
    if (!ready) {
      setStage('failed')
      setMessage('The payment window could not load. Check the connection and try again.')
      return
    }

    const orderRes = await fetch('/api/checkout/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, name, email, phone, coupon })
    })
    const order = (await orderRes.json()) as {
      ok: boolean
      error?: string
      orderId?: string
      keyId?: string
      amountPaise?: number
      label?: string
    }
    if (!order.ok || !order.orderId || !order.keyId) {
      setStage('failed')
      setMessage(order.error ?? 'The order could not be created. Nothing has been charged.')
      return
    }

    const checkout = new window.Razorpay!({
      key: order.keyId,
      amount: order.amountPaise ?? 0,
      currency: 'INR',
      name: 'Total',
      description: order.label ?? 'Total licence',
      order_id: order.orderId,
      prefill: { name, email, contact: phone },
      notes: { plan, coupon },
      // The checkout widget's accent. Kept in step with --accent in globals.css and the app's
      // --t-accent-bar; it was still the pre-indigo amber until this was noticed.
      theme: { color: '#4338ca' },
      modal: {
        ondismiss: () => {
          setStage('form')
          setMessage('Payment window closed. Nothing has been charged.')
        }
      },
      handler: (response) => {
        void (async () => {
          setStage('working')
          const verifyRes = await fetch('/api/checkout/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...response, plan, name, email, phone, coupon })
          })
          const verified = (await verifyRes.json()) as {
            ok: boolean
            error?: string
            licenceKey?: string
            message?: string
          }
          if (!verified.ok) {
            setStage('failed')
            setMessage(
              verified.error ??
                `The payment went through but the key could not be issued automatically. Write to ${props.salesEmail} and it will be sent by hand.`
            )
            return
          }
          setStage('paid')
          setLicenceKey(verified.licenceKey ?? '')
          setMessage(verified.message ?? '')
        })()
      }
    })
    checkout.open()
  }

  if (stage === 'paid') {
    return (
      <div className="buy-card">
        <h3>Paid. Thank you.</h3>
        {licenceKey ? (
          <>
            <p className="buy-help">
              This is your licence key. Open Total, go to Settings, then Licence, and paste it in.
              A copy is on its way to {email}.
            </p>
            <pre className="licence-key">{licenceKey}</pre>
          </>
        ) : (
          <p className="buy-help">{message}</p>
        )}
      </div>
    )
  }

  return (
    <form className="buy-card" onSubmit={submit}>
      <div className="field">
        <label htmlFor="plan">Plan</label>
        <select id="plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
          {props.plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}, {p.price} {p.unit}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="name">Name on the licence</label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoComplete="organization"
        />
        <p className="field-help">Your business name. It is shown in Settings, so a shared key is obvious.</p>
      </div>

      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <p className="field-help">Where the key is sent. Used for the key and the receipt, nothing else.</p>
      </div>

      <div className="field">
        <label htmlFor="phone">WhatsApp number, if you want the key there too</label>
        <input
          id="phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          autoComplete="tel"
          placeholder="919876543210"
        />
        <p className="field-help">Optional. Country code and number, no spaces. Leave it blank for email only.</p>
      </div>

      <div className="field">
        <label htmlFor="coupon">Referral or partner code</label>
        <input id="coupon" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
        <p className="field-help">If your accountant gave you a code, it goes here and takes the discount off.</p>
      </div>

      <button className="btn" type="submit" disabled={stage === 'working'}>
        {stage === 'working' ? 'Opening payment' : 'Pay by UPI or card'}
      </button>

      {message ? (
        <p className={stage === 'failed' ? 'field-error' : 'field-help'} role="status">
          {message}
        </p>
      ) : null}
    </form>
  )
}
