import type { Metadata } from 'next'
import SiteNav from '@/components/SiteNav'

export const metadata: Metadata = { title: 'Pricing — Total' }

const PLANS = [
  {
    name: 'Business', price: '₹9,900', scope: 'One legal business · up to 3 devices',
    included: 'Perpetual use of the purchased major version · 12 months of updates and standard support',
    renewal: 'Optional Care renewal: ₹3,600/year'
  },
  {
    name: 'Practice', price: '₹29,900', scope: 'Up to 25 client businesses · up to 3 devices',
    included: 'Practice workspace · perpetual use of the purchased major version · 12 months of updates and standard support',
    renewal: 'Optional Practice Care renewal: ₹9,900/year'
  }
] as const

export default function PricingPage(): React.JSX.Element {
  return <><SiteNav /><main className="wrap pricing-page">
    <p className="eyebrow">Founding commercial policy · 24 August 2026</p>
    <h1 className="serif">Own the software. Always own the books.</h1>
    <p className="lede">Total v0.5 is ₹0 during the public beta. When paid licences open, they will be one-time major-version licences—not a subscription required to read or export your accounting data.</p>

    <section className="pricing-ledger" aria-labelledby="plans-heading">
      <div className="pricing-head"><h2 id="plans-heading" className="serif">Pricing after beta</h2><span>Sales not open yet</span></div>
      {PLANS.map((plan) => <article className="pricing-row" key={plan.name}>
        <div><p className="pricing-name">{plan.name}</p><p>{plan.scope}</p></div>
        <div><p>{plan.included}</p><p className="pricing-renewal">{plan.renewal}</p></div>
        <p className="pricing-amount num">{plan.price}<small> + applicable taxes</small></p>
      </article>)}
    </section>

    <div className="pricing-notes">
      <section><h2 className="serif">The permanent promise</h2><p>A licence expiry or a decision not to renew Care will never disable your purchased version, existing books, reports, backups or complete portable export. Optional Care covers later updates and support; it is not rent for your data.</p></section>
      <section><h2 className="serif">Beta to paid</h2><p>No card is collected in beta and nobody is converted automatically. Paid sales will start only after at least 60 days&rsquo; notice. Beta users can keep evaluating during that notice and choose whether to buy.</p></section>
      <section><h2 className="serif">Direct-purchase refunds</h2><p>For a licence bought directly from Irmin Labs, request a refund within 30 calendar days of purchase. We may first offer reasonable help to fix the issue. Services already delivered and purchases through a reseller or marketplace follow the terms shown at that checkout, subject to applicable law.</p></section>
      <section><h2 className="serif">Support response targets</h2><p>Support hours are Monday–Friday, 10:00–18:00 IST, excluding published holidays. We target acknowledgement within 4 business hours for suspected data-loss or security incidents, 1 business day for a blocked core workflow, and 2 business days for normal questions. These are operating targets, not guaranteed resolution times.</p></section>
    </div>
    <p className="pricing-fine">Prices are in Indian rupees and may change before sales open; any change will be dated here before purchase. This commercial policy supplements the <a href="/terms">terms of use</a> and remains subject to applicable law and qualified legal review.</p>
  </main></>
}
