import type { Metadata } from 'next'
import Link from 'next/link'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import Testimonials from '@/components/Testimonials'
import { SALES_EMAIL, WHATSAPP_DISPLAY, WHATSAPP_NUMBER, hasWhatsApp } from '@/lib/product'

export const metadata: Metadata = {
  title: 'Free for chartered accountants — Total',
  description:
    'Total is free for practising chartered accountants, with unlimited client companies, consolidated reports and a referral code for clients.'
}

const INCLUDED: { thing: string; detail: string }[] = [
  { thing: 'Unlimited client companies', detail: 'One machine, as many books as you keep. No per-company charge and no counter.' },
  { thing: 'Consolidated reports', detail: 'Trial balance, profit and loss and balance sheet across selected companies at once.' },
  { thing: 'Tally XML import', detail: "Bring a client's masters and vouchers across from their Tally export, with a report of what did not." },
  { thing: 'GST returns and matching', detail: 'GSTR-1, GSTR-3B and GSTR-2B reconciliation, exported as the JSON the portal accepts.' },
  { thing: 'The audit pack', detail: 'Audit trail, exceptions, ledger scrutiny, a year-end pack and a fixed asset register.' },
  { thing: 'Payroll and TDS', detail: 'EPF, ESI, professional tax, TDS on salary, Form 16 and payslip PDFs.' }
]

export default function CaPage(): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">Free for chartered accountants</h1>
          <p className="sub">
            Unlimited client companies, every feature, no charge. Write with your membership number and a
            licence comes back.
          </p>

          <div className="callout" style={{ marginTop: 26 }}>
            <p>
              <b>Why give it away.</b> An accountant who keeps twelve sets of books on this software is the
              only review that matters in this market, and no advertisement buys the same thing. It also
              means the people best placed to find a mistake in the GST logic are using it every day, which
              is worth more than the licence fee.
            </p>
          </div>

          <h2>What the edition carries</h2>
          <div className="ledger" style={{ marginTop: 22 }}>
            <table>
              <thead>
                <tr>
                  <th>Particulars</th>
                  <th>What you get</th>
                </tr>
              </thead>
              <tbody>
                {INCLUDED.map((row) => (
                  <tr key={row.thing}>
                    <td className="f">{row.thing}</td>
                    <td className="p">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Getting a licence</h2>
          <p className="sub">Three lines in an email. There is no form, no sales call and no trial to start.</p>
          <ol className="steps">
            <li>
              <b>Write to <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a></b> with your name, your firm and
              your ICAI membership number.
              {hasWhatsApp && (
                <>
                  {' '}WhatsApp on <a href={`https://wa.me/${WHATSAPP_NUMBER}`}>{WHATSAPP_DISPLAY}</a> works just as well.
                </>
              )}
            </li>
            <li>
              <b>A key comes back</b>, valid for a year, covering unlimited companies. It is checked offline on
              your machine and renewed on request each year, by asking.
            </li>
            <li>
              <b>Nothing about your clients reaches us.</b> There is no account, no sync, and no list of the
              companies you keep. We know your name and your membership number, and that is the whole record.
            </li>
          </ol>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Sending clients across</h2>
          <p className="sub">
            If a client of yours buys, you get a code that takes money off their bill and credits you.
          </p>
          <p className="prose">
            Ask for a referral code and you get one under your firm&rsquo;s name. Hand your client the link,
            they get the discount at checkout, and the code is what tells us who to credit. The tracking is the
            code and nothing else: no analytics script runs on this site, no pixel is loaded, and a client who
            visits and does not buy leaves no record at all.
          </p>
          <p className="prose">
            Commission terms are settled per firm rather than published, because a practice sending two clients
            a year and one sending forty are not the same conversation.{' '}
            <Link href="/partners">The partner page</Link> sets out how the arrangement works.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <Testimonials />

        <div className="get">
          <h2 className="serif">Try it on one client first</h2>
          <p className="sub">
            Import a Tally export, run last quarter&rsquo;s GSTR-1, and see whether the figures agree with what
            you filed.
          </p>
          <div className="hero-ctas" style={{ justifyContent: 'center' }}>
            <Link className="btn" href="/download">
              Download Total
            </Link>
            <a className="btn ghost" href={`mailto:${SALES_EMAIL}`}>
              Ask for a licence
            </a>
          </div>
        </div>
      </div>
      <SiteFooter />
    </>
  )
}
