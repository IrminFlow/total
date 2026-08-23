import type { Metadata } from 'next'
import Link from 'next/link'
import SiteNav from '@/components/SiteNav'

export const metadata: Metadata = {
  title: 'Pricing — Total',
  description:
    'Total is a one-time or yearly licence for offline accounting. An expired licence never locks your books.'
}

const PLANS = [
  {
    name: 'Yearly',
    price: '₹4,999',
    unit: 'per business, per year',
    lines: [
      'Every feature, no per-user seats',
      'Updates and new versions while it runs',
      'Unlimited companies on your machine'
    ]
  },
  {
    name: 'Own it',
    price: '₹14,999',
    unit: 'once, yours permanently',
    featured: true,
    lines: [
      'The version you buy keeps working forever',
      'One year of updates included',
      'Renew for updates only if you want them'
    ]
  },
  {
    name: 'Chartered accountants',
    price: 'Free',
    unit: 'for practising accountants',
    lines: [
      'Unlimited client companies',
      'Consolidated reports across clients',
      'Write to us with your membership number'
    ]
  }
]

export default function Pricing(): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap docs-content pricing" style={{ paddingBottom: 96 }}>
        <h1 className="serif">Pricing</h1>
        <p className="sub">
          Software you install, not a subscription to a server. Thirty days free, no account and
          no card. The price is per business, not per person at a desk.
        </p>

        <div className="plans">
          {PLANS.map((plan) => (
            <div className={`plan${plan.featured ? ' featured' : ''}`} key={plan.name}>
              <p className="plan-name">{plan.name}</p>
              <p className="plan-price num serif">{plan.price}</p>
              <p className="plan-unit">{plan.unit}</p>
              <ul>
                {plan.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
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
          login. You pay, we send a key by email and WhatsApp, and you paste it into{' '}
          <b>Settings → Licence</b>. It is checked on your machine, offline, forever.
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

        <h3>Is it cheaper than Tally?</h3>
        <p>
          Meaningfully, and you should still check{' '}
          <Link href="/compare">what Tally does that Total does not</Link> before switching. We
          would rather you stayed on Tally than bought this and found a gap.
        </p>

        <div className="get" style={{ marginTop: 48 }}>
          <h2 className="serif">Try it for thirty days</h2>
          <p className="sub">No account, no card, no email. Download it and open your books.</p>
          <div className="hero-ctas" style={{ justifyContent: 'center' }}>
            <a className="btn" href="/api/download?platform=mac">
              Download for macOS
            </a>
            <a className="btn ghost" href="/api/download?platform=win">
              Download for Windows
            </a>
          </div>
        </div>
      </div>
    </>
  )
}
