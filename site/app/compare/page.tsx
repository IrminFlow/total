import type { Metadata } from 'next'
import Link from 'next/link'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import { inr } from '@/lib/pricing'
import { planById, priceState } from '@/lib/product'

export const metadata: Metadata = {
  title: 'Total vs TallyPrime',
  description:
    'A row-by-row comparison of Total and TallyPrime, including the four things TallyPrime does better and when to buy it instead.'
}

/**
 * OPERATOR: update this date whenever a row below is checked against the current TallyPrime.
 * A comparison table with no date on it is a claim about a competitor that nobody is
 * accountable for, and this one is going to age.
 */
const REVIEWED = '2026-08-24'

const ROWS: { particular: string; total: string; tally: string }[] = [
  { particular: 'Native macOS app', total: 'Yes', tally: 'No, Windows only' },
  { particular: 'Fully offline', total: 'Yes, no network call for your books', tally: 'Yes' },
  { particular: 'Data format', total: 'One open SQLite file per company', tally: 'Proprietary' },
  { particular: 'GSTR-1 and GSTR-3B', total: 'On screen, exported as portal JSON', tally: 'Yes' },
  { particular: 'GSTR-2B reconciliation', total: 'Yes', tally: 'Yes' },
  {
    particular: 'e-Invoice and e-Way bill',
    total: 'Offline JSON always. Live filing is written but untested, and ships switched off',
    tally: 'Mature, live filing in daily use'
  },
  { particular: 'Payroll', total: 'Included: EPF, ESI, PT, TDS on salary, Form 16, payslips', tally: 'Separate paid module' },
  {
    particular: 'Inventory and manufacturing',
    total: 'Bills of materials, batches and expiry, godowns, FIFO and weighted average, price levels',
    tally: 'Deeper: job work, more valuation methods, more report depth'
  },
  { particular: 'Bank reconciliation', total: 'Statement import, matching rules, BRS, cheque printing', tally: 'Yes' },
  { particular: 'Cost centres and budgets', total: 'Yes, with variance', tally: 'Yes' },
  { particular: 'Multi-user', total: 'Local users and roles, one machine at a time', tally: 'Yes, over a network' },
  { particular: 'Audit trail', total: 'Every change, with a bin for deletions', tally: 'Yes' },
  { particular: 'Command search', total: '⌘K reaches any screen or action by name', tally: 'No' },
  { particular: 'Updates', total: 'The app updates itself', tally: 'Manual' },
  { particular: 'Signed installers', total: 'Not yet, so the operating system warns on first launch', tally: 'Yes' },
  { particular: 'Support network', total: 'Email and WhatsApp, from the people who wrote it', tally: 'Thousands of partners in every district' },
  { particular: 'Track record', total: 'New', tally: 'More than thirty years' }
]

const TALLY_WINS: { h: string; p: string }[] = [
  {
    h: 'Two people in the same books',
    p: 'Tally does multi-user over a network and Total does not. If a second person needs to post while the first is posting, this is not a preference, it is the answer, and no other row on the table changes it.'
  },
  {
    h: 'Live e-invoicing that is known to work',
    p: 'Tally registers invoices with the portal every day in thousands of businesses. Total produces the JSON for the government offline tool, which is a step you take by hand. Its direct filing client has never been run against the real portal and is labelled an experiment inside the app.'
  },
  {
    h: 'Somebody down the road who knows it',
    p: 'Tally has a partner in nearly every district, and if your accountant, your CA and your last three employees all know Tally, that is real value that a feature table cannot show. Support here is one email address and one WhatsApp number.'
  },
  {
    h: 'Thirty years of edge cases',
    p: 'Every unusual thing an Indian business does has happened to Tally already and been handled. Total is new. It is tested hard, and it has not yet met your particular trade.'
  }
]

export default function ComparePage(): React.JSX.Element {
  const annual = planById('annual')
  const annualPriced = annual ? priceState(annual) === 'priced' : false

  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">Total against TallyPrime</h1>
          <p className="sub">
            Written by the people who make one of them, so read the next section first. It is the one that
            costs us something.
          </p>
          <p className="reviewed num">Rows checked against the current TallyPrime on {REVIEWED}</p>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Four things TallyPrime does better</h2>
          <p className="sub">If any one of these is what your business runs on, buy Tally. Genuinely.</p>
          <div className="two" style={{ marginTop: 26 }}>
            {TALLY_WINS.map((item) => (
              <div key={item.h}>
                <h3>{item.h}</h3>
                <p>{item.p}</p>
              </div>
            ))}
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Row by row</h2>
          <p className="sub">
            Prices are not on this table. Tally publishes its own and changes them, and quoting a competitor&rsquo;s
            price from memory is how comparison pages become fiction. Ours are on the{' '}
            <Link href="/pricing">pricing page</Link>
            {annual && annualPriced ? `, starting at ${inr(annual.paise)} a year` : ''}.
          </p>

          <div className="ledger" style={{ marginTop: 30 }}>
            <table>
              <thead>
                <tr>
                  <th>Particulars</th>
                  <th>Total</th>
                  <th>TallyPrime</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.particular}>
                    <td className="f">{row.particular}</td>
                    <td className="p">{row.total}</td>
                    <td className="p">{row.tally}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Who should switch</h2>
          <p className="prose">
            A business on a Mac, keeping its own books, one person posting at a time, filing GST through the
            offline tool. That is who Total is better for, and it is better by a distance, because the
            alternative is a Windows virtual machine.
          </p>
          <p className="prose">
            A business with a networked back office, a Tally-trained team and a partner on call should stay
            where it is. The <Link href="/roadmap">roadmap</Link> says what is not built, without dates on it,
            and the day multi-user exists this paragraph will change.
          </p>
          <p className="prose">
            If you are not sure, the trial has no account, no card and no email address. Import a Tally export,
            run last quarter, and compare the return with what you filed.
          </p>
          <div className="hero-ctas">
            <Link className="btn" href="/download">
              Download Total
            </Link>
            <Link className="btn ghost" href="/docs/coming-from-tally">
              Coming from Tally
            </Link>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>
      <SiteFooter />
    </>
  )
}
