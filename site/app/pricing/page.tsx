import type { Metadata } from 'next'
import Link from 'next/link'
import ReminderForm from '@/components/ReminderForm'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import {
  PLANS,
  SALES_EMAIL,
  WHATSAPP_DISPLAY,
  WHATSAPP_NUMBER,
  hasWhatsApp,
  paymentLink,
  priceState,
  pricingAnnounced
} from '@/lib/product'
import { approximately, inr, rateFor, RATES_REVIEWED, visitorCountry } from '@/lib/pricing'

export const metadata: Metadata = {
  title: 'Pricing — Total',
  description:
    'Total is a licence you buy once or renew yearly, paid by UPI or card. An expired licence never locks your books — it keeps reading, printing and exporting forever.'
}

/**
 * The pricing page.
 *
 * Two things it is built around. The commitment gets the largest type on the page, because "an
 * expired licence never locks your books" is the single most reassuring fact about this product's
 * commercial model and it was previously a callout below the fold. And the number is read from
 * the environment (see lib/product.ts), so before an owner has decided one this page says so in
 * plain words instead of printing ₹0 — which is the state it ships in.
 */
export default async function Pricing(): Promise<React.JSX.Element> {
  const country = await visitorCountry()
  const rate = rateFor(country)
  const announced = pricingAnnounced()
  const link = paymentLink()

  return (
    <>
      <SiteNav />

      <div className="wrap">
        <section className="folio price-head">
          <h1 className="serif">What it costs</h1>
          <p className="sub">
            Software you install, not a subscription to a server. Thirty days free, with no account
            and no card. One licence covers the business, not each person at a desk.
          </p>

          <div className="plans">
            {PLANS.map((plan) => {
              const state = priceState(plan)
              const local = state === 'priced' ? approximately(plan.paise, rate) : null
              return (
                <div className={`plan${plan.featured ? ' featured' : ''}`} key={plan.id}>
                  <p className="plan-name">{plan.name}</p>
                  {state === 'priced' ? (
                    <p className="plan-price num serif">{inr(plan.paise)}</p>
                  ) : state === 'free' ? (
                    <p className="plan-price num serif">Free</p>
                  ) : (
                    <p className="plan-price plan-price-pending serif">Not yet announced</p>
                  )}
                  <p className="plan-unit">
                    {state === 'unannounced' ? 'per business, per year — the figure is being set' : plan.unit}
                  </p>
                  {local ? <p className="plan-local num">about {local}</p> : null}
                  <ul>
                    {plan.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>

          {announced && rate ? (
            <p className="plan-fx">
              You appear to be outside India, so a second figure is shown in {rate.code}. It is
              indicative and it is not what you pay: the charge is in rupees and your card issuer
              does the conversion at its own rate. Figures reviewed by hand on {RATES_REVIEWED}.
            </p>
          ) : null}

          {announced ? (
            <div className="hero-ctas" style={{ marginTop: 30 }}>
              <Link className="btn" href="/buy">
                Buy a licence
              </Link>
              <Link className="btn ghost" href="/download">
                Try it for thirty days
              </Link>
            </div>
          ) : (
            <>
              <div className="callout warn price-pending">
                <p>
                  <b>The price has not been published yet.</b>
                </p>
                <p>
                  Rather than show you a number that might change before you can pay it, this page
                  waits. The trial is the whole product for thirty days and it does not ask for a
                  card, so nothing about the wait is in your way. Ask what it will cost and you get
                  an answer the same day, along with the figure before it goes on this page.
                </p>
              </div>
              <div className="hero-ctas" style={{ marginTop: 26 }}>
                <Link className="btn" href="/download">
                  Try it for thirty days
                </Link>
                <a className="btn ghost" href={`mailto:${SALES_EMAIL}?subject=What%20will%20Total%20cost%3F`}>
                  Ask what it will cost
                </a>
                {hasWhatsApp ? (
                  <a className="btn ghost" href={`https://wa.me/${WHATSAPP_NUMBER}`}>
                    {WHATSAPP_DISPLAY}
                  </a>
                ) : null}
              </div>
            </>
          )}
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>

      {/* The commitment that matters more than the number, and it gets the biggest type here. */}
      <div className="band promise-band" data-reveal>
        <div className="wrap">
          <p className="promise-eyebrow num">The commitment</p>
          <p className="promise serif">An expired licence never locks your books.</p>
          <div className="promise-grid">
            <p>
              If a licence lapses, Total keeps opening every company, reading every report,
              printing, exporting to PDF, CSV and Tally XML, and taking backups — forever, with no
              renewal and no further payment. Only posting new entries pauses until you renew.
            </p>
            <p>
              Nobody should be shut out of their own accounts because a card expired. Your books are
              files in a folder on your own disk either way, and the app that reads them does not
              ask anyone for permission to open them.
            </p>
          </div>
        </div>
      </div>

      <div className="wrap">
        <section className="folio" data-reveal>
          <h2 className="serif">How buying works</h2>
          <p className="sub">
            Total has no accounts and never contacts a server, so a licence is a key rather than a
            login.
          </p>
          <ol className="steps">
            <li>
              <b>Pay by UPI, card or net banking.</b> UPI is the default, because it is how this
              market pays.
              {link ? (
                <>
                  {' '}
                  <a href={link}>The payment link is here.</a>
                </>
              ) : null}
            </li>
            <li>
              <b>The key arrives by email</b>, and on WhatsApp too if you leave a number. It is a
              short signed piece of text, not a login.
            </li>
            <li>
              <b>Paste it into Settings → Licence.</b> It is checked on your own machine, offline,
              with no activation call — so it works on a machine that has never seen the internet.
            </li>
          </ol>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio" data-reveal>
          <h2 className="serif">Questions people ask before paying</h2>
          <div className="two qa">
            <div>
              <h3>Is there a per-user charge?</h3>
              <p>
                No. Total runs on one machine at a time, and the licence covers the business rather
                than the person sitting at the keyboard.
              </p>
              <h3>What happens to my data if I stop paying?</h3>
              <p>
                Nothing. It is a folder on your disk that you can copy, and the app keeps reading
                and exporting it whether or not a licence is current.
              </p>
              <h3>Can I move to another computer?</h3>
              <p>
                Yes. Copy <span className="mono-inline">~/Documents/total</span> across and paste
                the same key.
              </p>
            </div>
            <div>
              <h3>Are you free for chartered accountants?</h3>
              <p>
                Yes, with unlimited client companies, on a membership number.{' '}
                <Link href="/ca">The CA edition</Link> explains why.
              </p>
              <h3>Is it cheaper than Tally?</h3>
              <p>
                Meaningfully, and you should still check{' '}
                <Link href="/compare">what Tally does that Total does not</Link> before switching.
                We would rather you stayed on Tally than bought this and found a gap.
              </p>
              <h3>Do I get a GST invoice?</h3>
              <p>
                Yes, in your firm&rsquo;s name with your GSTIN on it. Ask at{' '}
                <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a> and it comes back the same day.
              </p>
            </div>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio" data-reveal>
          <h2 className="serif">A reminder before the trial ends</h2>
          <p className="sub">
            Only if you ask for it here. The app makes no network call, so it cannot tell us you
            installed it, and it will never ask you for an address.
          </p>
          <ReminderForm />
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>

      <SiteFooter />
    </>
  )
}
