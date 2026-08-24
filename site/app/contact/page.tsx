import type { Metadata } from 'next'
import Link from 'next/link'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'

import { WHATSAPP_DISPLAY, WHATSAPP_NUMBER, hasWhatsApp } from '@/lib/product'

export const metadata: Metadata = {
  title: 'Contact — Total',
  description: 'Reach a person about Total: WhatsApp, email, or the in-app support form.'
}

/**
 * A contact page with a WhatsApp number on it.
 *
 * In this market a business that cannot reach a person before buying does not buy. A support
 * address in a footer reads as a formality; a number someone answers reads as a company. That it
 * costs support time is the point — it is the cheapest sales channel available here.
 */

export default function ContactPage(): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">Talk to us</h1>
          <p className="sub">
            Before you buy, while you are migrating, or when something is wrong. A person reads all
            of these.
          </p>

          <div className="two">
            {hasWhatsApp && (
              <div>
                <h3>WhatsApp</h3>
                <p>
                  Fastest, and usually within the working day.{' '}
                  <a href={`https://wa.me/${WHATSAPP_NUMBER}`} className="mono-inline">
                    {WHATSAPP_DISPLAY}
                  </a>
                </p>
                <p>
                  Bring your question and, if it is about your own books, a screenshot. We will never ask
                  you to send us your data.
                </p>
              </div>
            )}
            <div>
              <h3>Email</h3>
              <p>
                <a href="mailto:total@irminflow.com">total@irminflow.com</a> — better for anything with
                a file attached, or anything that needs a written answer to keep.
              </p>
              <h3>From inside the app</h3>
              <p>
                Support in the sidebar attaches your version, your operating system and the recent error
                log, and shows you exactly what it will send before it sends it.
              </p>
            </div>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Chartered accountants and resellers</h2>
          <p className="sub">
            Total is free for practising accountants, with unlimited client companies. Write with your
            membership number and a licence comes back.
          </p>
          <p className="prose">
            <Link href="/ca">The CA edition</Link> sets out what it carries and how referral codes work.{' '}
            <Link href="/partners">The partner page</Link> is for firms that install and support accounting
            software for a living, and it includes the list of things not to say on our behalf.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>
      <SiteFooter />
    </>
  )
}
