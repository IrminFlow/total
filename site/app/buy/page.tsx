import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import Link from 'next/link'
import BuyPanel from '@/components/BuyPanel'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import { findCoupon } from '@/lib/coupons'
import { canMint } from '@/lib/licence'
import { paymentsConfigured } from '@/lib/payments'
import {
  SALES_EMAIL,
  WHATSAPP_DISPLAY,
  WHATSAPP_NUMBER,
  hasWhatsApp,
  paymentLink,
  pricedPlans
} from '@/lib/product'
import { approximately, inr, rateFor, visitorCountry } from '@/lib/pricing'
import { REF_COOKIE } from '@/lib/referral'

export const metadata: Metadata = {
  title: 'Buy a licence — Total',
  description: 'Pay by UPI or card. The key arrives by email and WhatsApp and is checked offline on your own machine.'
}

export default async function BuyPage(): Promise<React.JSX.Element> {
  const jar = await cookies()
  const referral = jar.get(REF_COOKIE)?.value ?? ''
  const today = new Date().toISOString().slice(0, 10)
  const coupon = findCoupon(referral, today)
  const country = await visitorCountry()
  const rate = rateFor(country)
  // Only plans with an announced price, which is a runtime question: the figures come from
  // TOTAL_PRICE_*_INR in the environment. With none set this list is empty and the panel says so.
  const sellable = pricedPlans()
  const link = paymentLink()

  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">Buy a licence</h1>
          <p className="sub">
            UPI, card or net banking. The key is a signed piece of text you paste into Settings, checked
            on your own machine with no activation call.
          </p>

          <div className="buy-grid">
            <BuyPanel
              enabled={paymentsConfigured()}
              plans={sellable.map((p) => ({
                id: p.id,
                name: p.name,
                price: inr(p.paise),
                unit: p.unit.replace('per business, ', '')
              }))}
              initialPlan={sellable[0]?.id ?? 'annual'}
              initialCoupon={coupon?.code ?? ''}
              salesEmail={SALES_EMAIL}
              paymentLink={link}
            />

            <div>
              <h3>What you are buying</h3>
              <ul className="plain-list">
                {sellable.length === 0 ? (
                  <li>
                    A licence for the whole app on one machine, with unlimited companies and no
                    per-user seats. The price is being set and is not on the site yet.
                  </li>
                ) : null}
                {sellable.map((plan) => (
                  <li key={plan.id}>
                    <b>{plan.name}</b>, {inr(plan.paise)} {plan.unit}
                    {rate ? ` (about ${approximately(plan.paise, rate)}, charged in rupees)` : ''}. {plan.lines[0]}.
                  </li>
                ))}
                <li>
                  Every plan covers unlimited companies on your machine and has no per-user seats.
                </li>
                <li>
                  If a licence lapses, Total keeps opening every company, reading, printing, exporting and
                  backing up. Only posting new entries pauses.
                </li>
              </ul>

              {coupon ? (
                <div className="callout" style={{ marginTop: 22 }}>
                  <p>
                    <b>{coupon.partner} sent you.</b> The code {coupon.code} is applied and takes{' '}
                    {coupon.percentOff}% off. Nothing else about your visit is recorded.
                  </p>
                </div>
              ) : null}

              <h3 style={{ marginTop: 26 }}>How the key reaches you</h3>
              <p className="buy-help">
                {canMint()
                  ? 'By email the moment the payment clears, and on WhatsApp too if you leave a number. It is also shown on screen, so you can paste it straight away.'
                  : `By email${hasWhatsApp ? ', and on WhatsApp if you leave a number' : ''}. Keys are issued by hand at the moment, so allow a few hours rather than a few seconds.${hasWhatsApp ? ` If one is slow, ${WHATSAPP_DISPLAY} is the fastest way to chase it.` : ''}`}
              </p>

              <h3 style={{ marginTop: 26 }}>Buying for a practice</h3>
              <p className="buy-help">
                Chartered accountants do not buy this. <Link href="/ca">The CA edition</Link> is free, with
                unlimited client companies, on a membership number.
              </p>
              <p className="buy-help">
                Anything else, including purchase orders and GST invoices in your firm&rsquo;s name:{' '}
                <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a>
                {hasWhatsApp && (
                  <>
                    {' '}or <a href={`https://wa.me/${WHATSAPP_NUMBER}`}>{WHATSAPP_DISPLAY}</a>
                  </>
                )}
                .
              </p>
            </div>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>
      <SiteFooter />
    </>
  )
}
