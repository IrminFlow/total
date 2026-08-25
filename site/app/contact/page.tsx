import type { Metadata } from 'next'
import Link from 'next/link'
import ContactForm from '@/components/ContactForm'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'

import { SALES_EMAIL, WHATSAPP_DISPLAY, WHATSAPP_NUMBER, hasWhatsApp } from '@/lib/product'

export const metadata: Metadata = {
  title: 'Contact — Total',
  description:
    'Reach a person about Total: a form that goes where the app’s own support messages go, an email address, and WhatsApp.'
}

/**
 * A contact page with a form on it, and a number when there is one.
 *
 * In this market a business that cannot reach a person before buying does not buy. A support
 * address in a footer reads as a formality; a form that answers, and a number someone picks up,
 * read as a company. That it costs support time is the point — it is the cheapest sales channel
 * available here.
 *
 * The form posts to the same `/api/feedback` the app's Support dialog posts to, so there is one
 * inbox rather than two.
 */

export default function ContactPage(): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio contact-top">
          <h1 className="serif">Talk to us</h1>
          <p className="sub">
            Before you buy, while you are migrating, or when something is wrong. A person reads all
            of these, and the answer comes from whoever wrote the code.
          </p>

          <div className="contact-grid">
            <ContactForm salesEmail={SALES_EMAIL} />

            <div className="contact-routes">
              {hasWhatsApp ? (
                <div className="contact-route">
                  <h3>WhatsApp</h3>
                  <p>
                    Fastest, and usually within the working day.{' '}
                    <a href={`https://wa.me/${WHATSAPP_NUMBER}`} className="mono-inline">
                      {WHATSAPP_DISPLAY}
                    </a>
                  </p>
                  <p>
                    Bring your question and, if it is about your own books, a screenshot. We will
                    never ask you to send us your data.
                  </p>
                </div>
              ) : (
                <div className="contact-route">
                  <h3>WhatsApp</h3>
                  <p>
                    There is no number on this page yet, and a made-up one would be worse than
                    none. Until there is, email and the form beside it are the two routes, and both
                    are read by a person.
                  </p>
                </div>
              )}

              <div className="contact-route">
                <h3>Email</h3>
                <p>
                  <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a> — better for anything with a
                  file attached, or anything that needs a written answer to keep.
                </p>
              </div>

              <div className="contact-route">
                <h3>From inside the app</h3>
                <p>
                  Support in the sidebar attaches your version, your operating system and the
                  recent error log, and shows you exactly what it will send before it sends it. It
                  arrives in the same place as this form.
                </p>
              </div>

              <div className="contact-route">
                <h3>What happens to what you send</h3>
                <p>
                  It is filed as a support message and answered. It is not added to a mailing list,
                  and there is no third-party form service in the middle of it —{' '}
                  <Link href="/privacy">the privacy page</Link> lists every call this site makes.
                </p>
              </div>
            </div>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio" data-reveal>
          <h2 className="serif">Chartered accountants and resellers</h2>
          <p className="sub">
            Total is free for practising accountants, with unlimited client companies. Write with
            your membership number and a licence comes back.
          </p>
          <p className="prose">
            <Link href="/ca">The CA edition</Link> sets out what it carries and how referral codes
            work. <Link href="/partners">The partner page</Link> is for firms that install and
            support accounting software for a living, and it includes the list of things not to say
            on our behalf.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>
      <SiteFooter />
    </>
  )
}
