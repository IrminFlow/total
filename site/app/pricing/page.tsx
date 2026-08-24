import type { Metadata } from 'next'
import Link from 'next/link'
import ReminderForm from '@/components/ReminderForm'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import { PLANS } from '@/lib/product'
import { approximately, inr, rateFor, RATES_REVIEWED, visitorCountry } from '@/lib/pricing'

export const metadata: Metadata = {
  title: 'Pricing — Total',
  description:
    'Total is a one-time or yearly licence for offline accounting. An expired licence never locks your books.'
}

export default async function Pricing(): Promise<React.JSX.Element> {
  const country = await visitorCountry()
  const rate = rateFor(country)

  return (
    <>
      <SiteNav />
      <div className="wrap docs-content pricing" style={{ paddingBottom: 40 }}>
        <h1 className="serif">Pricing</h1>
        <p className="sub">
          Software you install, not a subscription to a server. Thirty days free, no account and
          no card. The price is per business, not per person at a desk.
        </p>

        <div className="plans">
          {PLANS.map((plan) => {
            const local = approximately(plan.paise, rate)
            return (
              <div className={`plan${plan.featured ? ' featured' : ''}`} key={plan.id}>
                <p className="plan-name">{plan.name}</p>
                <p className="plan-price num serif">{plan.paise > 0 ? inr(plan.paise) : 'Free'}</p>
                <p className="plan-unit">{plan.unit}</p>
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

        {rate ? (
          <p className="plan-fx">
            You appear to be outside India, so a second figure is shown in {rate.code}. It is
            indicative and it is not what you pay: the charge is in rupees and your card issuer
            does the conversion at its own rate. Figures reviewed by hand on {RATES_REVIEWED}.
          </p>
        ) : null}

        <div className="hero-ctas" style={{ marginTop: 26 }}>
          <Link className="btn" href="/buy">
            Buy a licence
          </Link>
          <Link className="btn ghost" href="/download">
            Try it for thirty days
          </Link>
        </div>

        {/* The commitment that matters more than the number. */}
        <div className="callout warn" style={{ maxWidth: 'none', marginTop: 34 }}>
          <p>
            <b>An expired licence never locks your books.</b>
          </p>
          <p>
            If a licence lapses, Total keeps opening every company, reading every report, printing,
            exporting to PDF, CSV and Tally XML, and taking backups. Only posting new entries
            pauses until you renew. Nobody should ever be shut out of their own accounts because a
            payment failed, and your books are files on your own disk either way.
          </p>
        </div>

        <h2>How buying works</h2>
        <p>
          Total has no accounts and never contacts a server, so a licence is a key rather than a
          login. You pay by UPI, card or net banking, the key arrives by email and on WhatsApp if
          you leave a number, and you paste it into <b>Settings → Licence</b>. It is checked on
          your machine, offline, forever.
        </p>

        <h2>Common questions</h2>
        <h3>Is there a per-user charge?</h3>
        <p>
          No. Total runs on one machine at a time, and the licence covers the business rather than
          the person sitting at the keyboard.
        </p>

        <h3>What happens to my data if I stop paying?</h3>
        <p>
          Nothing. It is a folder on your disk that you can copy, and the app keeps reading and
          exporting it whether or not a licence is current.
        </p>

        <h3>Can I move to another computer?</h3>
        <p>
          Yes. Copy <span className="num">~/Documents/total</span> across and paste the same key.
        </p>

        <h3>Are you free for chartered accountants?</h3>
        <p>
          Yes, with unlimited client companies, on a membership number.{' '}
          <Link href="/ca">The CA edition</Link> explains why.
        </p>

        <h3>Is it cheaper than Tally?</h3>
        <p>
          Meaningfully, and you should still check{' '}
          <Link href="/compare">what Tally does that Total does not</Link> before switching. We
          would rather you stayed on Tally than bought this and found a gap.
        </p>

        <h2>A reminder before the trial ends</h2>
        <p className="muted">
          Only if you ask for it here. The app makes no network call, so it cannot tell us you
          installed it, and it will never ask you for an address.
        </p>
        <ReminderForm />
      </div>
      <SiteFooter />
    </>
  )
}
