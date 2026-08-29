import type { Metadata } from 'next'
import Link from 'next/link'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import { SALES_EMAIL, WHATSAPP_DISPLAY, WHATSAPP_NUMBER, hasWhatsApp } from '@/lib/product'

export const metadata: Metadata = {
  title: 'Partners and resellers — Total',
  description:
    'How reselling Total works: referral codes, what you are expected to support, what we support, and what we will not ask you to say.'
}

export default function PartnersPage(): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">Partners and resellers</h1>
          <p className="sub">
            Written for the people who already install and support accounting software for a living. It says
            what you get, what you owe, and what we will not ask you to do.
          </p>

          <div className="callout warn" style={{ marginTop: 26 }}>
            <p>
              <b>Read this first.</b> Total is a young product from a small team. If you build a practice on
              reselling it, you are taking that risk with us. The <Link href="/compare">comparison page</Link>{' '}
              lists where TallyPrime is still ahead, and the <Link href="/roadmap">roadmap</Link> says what is
              not built. Send both to a prospect before you send a quotation.
            </p>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">How the arrangement works</h2>
          <ol className="steps">
            <li>
              <b>You get a code under your firm&rsquo;s name.</b> Ask for one and it is issued the same week. It
              takes an agreed percentage off your client&rsquo;s bill and records the sale against you.
            </li>
            <li>
              <b>Your client buys directly.</b> They pay us by UPI or card, the key is issued to their business
              name, and you are credited from the code. You never hold stock, float money, or carry a debtor.
            </li>
            <li>
              <b>Commission is settled quarterly</b> against the codes redeemed, with the list of orders behind
              it. Rates are agreed per firm and written down before the first sale, not after it.
            </li>
            <li>
              <b>Either side can stop.</b> Codes are retired on request. A retired code stops working at
              checkout, and any sale already made under it is still settled.
            </li>
          </ol>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Who does what</h2>
          <div className="two">
            <div>
              <h3>Yours</h3>
              <p>
                Installing it, migrating the client from Tally, setting up masters and opening balances, and
                the first month of hand-holding. You know that work and you charge for it. We do not price it,
                cap it, or ask to see the invoice.
              </p>
              <p>
                Answering the everyday questions: which voucher type, how a report is read, why a figure moved.
                Anything that is a question about accounting rather than about the software.
              </p>
            </div>
            <div>
              <h3>Ours</h3>
              <p>
                Bugs, crashes, wrong figures, a return the portal rejects, and anything statutory that changed.
                Send it straight to us and skip the layer: a defect routed through a reseller takes two days
                longer to reach the person who can fix it.
              </p>
              <p>
                Keys, renewals and replacements. If a client loses a key, we reissue it to the same business
                name at no charge, whoever sold it.
              </p>
            </div>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Things not to say on our behalf</h2>
          <ul className="plain-list">
            <li>
              That live e-invoice filing to the NIC portal works. The client exists, written to the published
              specification, and has never been run against the real portal. It ships switched off and labelled
              an experiment, and it must be sold that way or not at all.
            </li>
            <li>
              That two people can work in the same books at once over a network. They cannot. Total has local
              users and roles on one machine.
            </li>
            <li>
              That the installers are signed. They are not yet, so macOS and Windows both warn on first launch.
              The <Link href="/download">download page</Link> explains what the warning says and how to get past
              it, and a client who is told beforehand does not ring you about it.
            </li>
            <li>
              That anything on the roadmap has a date. Nothing does. Quote what is in the build today.
            </li>
          </ul>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Getting started</h2>
          <p className="prose">
            Write to <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a>
            {hasWhatsApp && (
              <>
                {' '}or WhatsApp <a href={`https://wa.me/${WHATSAPP_NUMBER}`}>{WHATSAPP_DISPLAY}</a>
              </>
            )}{' '}
            with your firm, the towns you
            cover and roughly how many clients you keep books for. You get a licence for your own use first,
            because nobody should resell software they have not run for a month.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>
      <SiteFooter />
    </>
  )
}
