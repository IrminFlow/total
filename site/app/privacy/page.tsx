import type { Metadata } from 'next'
import Link from 'next/link'
import SiteNav from '@/components/SiteNav'

export const metadata: Metadata = {
  title: 'Privacy — Total',
  description:
    'Exactly what leaves your machine when you use Total, and what never does. Written as a list of network calls, not as a policy.'
}

/**
 * A privacy page written as a list of network calls.
 *
 * Most privacy policies describe intentions. This one describes behaviour: every request the app
 * can make, what triggers it, and what is in it. That is the only form of the document a reader
 * can check against the app, and the only one worth writing for a product whose whole claim is
 * that the data stays put.
 */
const CALLS: { when: string; where: string; what: string; optional: string }[] = [
  {
    when: 'On launch, once',
    where: 'This website’s /api/latest',
    what: 'Nothing about you. The app asks what the newest version number is.',
    optional: 'Yes — turn off update checks in Settings → About.'
  },
  {
    when: 'When you click Download update',
    where: 'This website’s /api/download',
    what: 'Nothing about you. The installer comes back.',
    optional: 'Yes — you can always download from the site by hand.'
  },
  {
    when: 'Only if you turn the assistant on and add your own API key',
    where: 'The endpoint you configured — OpenAI, or a model on your own machine',
    what:
      'Your question and the rows the assistant read to answer it, with GSTIN, PAN, bank details, email, phone and anything payroll removed first. The app shows you the exact payload before you send it.',
    optional: 'Yes — the assistant is off until you switch it on, per company.'
  },
  {
    when: 'Only if you enter NIC credentials and generate an e-invoice',
    where: 'The government’s e-invoice and e-way bill APIs',
    what: 'The invoice, as the portal’s published schema requires it.',
    optional: 'Yes — the offline route exports a JSON file you upload yourself.'
  },
  {
    when: 'Only if you click a WhatsApp reminder',
    where: 'wa.me, in your browser',
    what: 'The reminder text and the party’s number, so WhatsApp can open the chat.',
    optional: 'Yes — it is a link you click.'
  }
]

const NEVER = [
  'Your books. No company database, backup or voucher is ever uploaded anywhere.',
  'Analytics or telemetry of any kind. There is no event pipeline, no crash reporter phoning home, no session recording.',
  'Your name, email or business details. Downloading Total does not ask for them, and the app has no account.',
  'Your licence key, beyond the machine it is entered on. It is verified by a signature check, offline.'
]

export default function PrivacyPage(): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">What leaves your machine</h1>
          <p className="sub">
            Total keeps your books in <span className="path">~/Documents/total</span> and nowhere else.
            Rather than promise that in the abstract, here is every request the app can make.
          </p>

          <div className="ledger">
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Where</th>
                  <th scope="col">What is in it</th>
                  <th scope="col">Can you turn it off?</th>
                </tr>
              </thead>
              <tbody>
                {CALLS.map((c) => (
                  <tr key={c.when}>
                    <td className="f">{c.when}</td>
                    <td className="p">{c.where}</td>
                    <td className="p">{c.what}</td>
                    <td className="p">{c.optional}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">What never leaves, under any setting</h2>
          <ul className="plain-list">
            {NEVER.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="sub">
            The app&rsquo;s renderer cannot reach the network at all — its content-security policy is{' '}
            <span className="mono-inline">default-src &apos;self&apos;</span>, which is why every one of the
            calls above is made by the main process and listed here.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Where your data actually is</h2>
          <p className="sub">
            One SQLite file per company under <span className="path">~/Documents/total</span>, plus its
            backups and anything you have exported. Copy the folder and you have copied the business.
            Delete it and it is gone — there is no other copy, which is the trade.
          </p>
          <p className="sub">
            Two things are stored outside it, deliberately. Your assistant API key goes to the operating
            system&rsquo;s keychain rather than into a company file, because a company file is copied into
            every backup and export. Your GST portal credentials go the same way.
          </p>
          <p className="sub">
            Questions about any of this: <a href="mailto:total@irminflow.com">total@irminflow.com</a>, or{' '}
            <Link href="/contact">get in touch</Link>.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>
    </>
  )
}
