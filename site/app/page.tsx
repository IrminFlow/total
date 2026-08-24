import Image from 'next/image'
import Link from 'next/link'
import SiteFooter from '@/components/SiteFooter'
import Testimonials from '@/components/Testimonials'
import { latestRelease } from '@/lib/release'
import gatewayLight from '@/public/gateway-light.jpg'
import voucherDark from '@/public/voucher-dark.jpg'
import gstr1Light from '@/public/gstr1-light.jpg'

const FEATURES: { f: string; p: string }[] = [
  { f: 'Vouchers', p: 'Contra to credit note, invoice mode with live GST, audit log on every change' },
  { f: 'GST returns', p: "GSTR-1 and GSTR-3B on screen, exported as JSON the portal's offline tool accepts" },
  { f: 'e-Invoice & e-Way', p: 'Offline JSON the government tools accept, with HSN and CRN/DBN references. Live NIC filing ships as an experiment' },
  { f: 'Invoice PDF', p: 'GST tax invoice with HSN, tax breakup, amount in words and the double rule' },
  { f: 'Stock & manufacturing', p: 'FIFO valuation, batches, bills of materials, one-screen manufacture vouchers' },
  { f: 'Banking', p: 'Reconciliation with statement CSV import that matches entries by amount and date' },
  { f: 'Payroll', p: 'EPF, ESI and professional tax computed to the rupee; payslip PDFs; one balanced posting' },
  { f: 'Registers & ageing', p: 'Sales and purchase registers by month or quarter, receivable and payable ageing' },
  { f: 'Multi-currency', p: 'Invoice in USD or EUR at your rate; the books stay in rupees' },
  { f: 'Tally import', p: "Bring your masters and vouchers across from Tally's XML export" }
]

/**
 * The hero object: one real sales invoice that foots.
 *
 * Dr 1,06,200.00 against Cr 90,000.00 + 8,100.00 + 8,100.00. The GST is 18% on 90,000 split
 * into CGST and SGST, which is what an intra-state sale actually produces. It balances because
 * every entry in the product balances, and that is the pitch.
 */
const VOUCHER = [
  { side: 'Dr', cls: 'dr', account: 'Umbrella Retail', note: 'Sundry Debtors', amount: '1,06,200.00', active: true },
  { side: 'Cr', cls: 'cr', account: 'Sales A/c', note: '2 × Laptop 14"', amount: '90,000.00' },
  { side: 'Cr', cls: 'cr', account: 'CGST Output', note: '9%', amount: '8,100.00' },
  { side: 'Cr', cls: 'cr', account: 'SGST Output', note: '9%', amount: '8,100.00' }
]

export default async function Home(): Promise<React.JSX.Element> {
  const release = await latestRelease()

  return (
    <>
      <div className="wrap">
        <div className="top">
          <span className="wordmark serif">Total</span>
          <span className="tag">for macOS and Windows · fully offline</span>
          <span className="top-links">
            <Link href="/docs">Docs</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/compare">Compare</Link>
            <Link href="/roadmap">Roadmap</Link>
          </span>
        </div>

        {/* Three things and no more: the claim, the sentence under it, and the way in. The
            version note, the eyebrow and the nav's own Download button all used to live here and
            all three were reading room the claim needed. */}
        <div className="hero">
          <h1 className="serif">
            Your books. On your desk. <span className="quiet">Nowhere else.</span>
          </h1>
          <p className="lede">
            Tally-grade double-entry accounting, rebuilt for a machine you own. No cloud, no account.
          </p>
          <div className="hero-ctas">
            <a className="btn" href="/api/download?platform=mac">
              Download for macOS
            </a>
            <a className="btn ghost" href="/api/download?platform=win">
              Windows
            </a>
          </div>
        </div>

        <section className="folio">
          <h2 className="serif">It foots, and you never typed the tax</h2>
          <p className="sub">
            One real sales invoice. Eighteen percent on ninety thousand, split into CGST and SGST because
            the parties are in the same state, and the debits equal the credits.
          </p>
          <div className="voucher" role="img" aria-label="A sales invoice in Total: one debit of 1,06,200.00 against three credits totalling the same, with CGST and SGST computed at 9 percent each.">
            <div className="voucher-head">
              <span className="kind serif">Sales</span>
              <span className="no">No. 4</span>
              <span className="date">15-Aug-26</span>
            </div>
            {VOUCHER.map((line) => (
              <div className={`vrow${line.active ? ' active' : ''}`} key={line.account}>
                <span className={`side ${line.cls}`}>{line.side}</span>
                <span>
                  {line.account} <span className="note">{line.note}</span>
                </span>
                <span className="amt">{line.amount}</span>
              </div>
            ))}
            <div className="vtotal">
              <span />
              <span>Total</span>
              <span className="amt">1,06,200.00</span>
            </div>
          </div>
          <p className="vfoot">
            The amber bar is the cursor: <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>↵</kbd> takes you to the next
            field, <kbd>Esc</kbd> backs out.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio" id="ledger">
          <h2 className="serif">The ledger of features</h2>
          <p className="sub">
            Everything posts to real double-entry books. Every report below is computed from vouchers at the
            moment you open it, so nothing can drift.
          </p>
          <div className="ledger">
            <table>
              <thead>
                <tr>
                  <th>Particulars</th>
                  <th>What you get</th>
                  <th className="r">Amount</th>
                </tr>
              </thead>
              <tbody>
                {FEATURES.map((row) => (
                  <tr key={row.f}>
                    <td className="f">{row.f}</td>
                    <td className="p">{row.p}</td>
                    <td className="r amt">included</td>
                  </tr>
                ))}
                <tr className="total">
                  <td className="f">Total</td>
                  <td className="p">no subscription, no per-user seats, no server</td>
                  <td className="r amt">one licence</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Your fingers already know it</h2>
          <p className="sub">
            One letter of every menu item is red. Press it and you are there, from any screen.
          </p>
          <div className="shot">
            <Image
              src={gatewayLight}
              alt="The Total Gateway: cash, receivables, payables and GST tiles above the day's entries, with one letter of every sidebar item picked out in red"
              priority
              sizes="(max-width: 1020px) 100vw, 972px"
            />
            <p className="caption">
              <span className="hot-letter">V</span>oucher entry. <span className="hot-letter">D</span>ay book.{' '}
              <span className="hot-letter">B</span>alance sheet. The whole app, without the mouse.
            </p>
          </div>
          <div className="two">
            <div>
              <h3>Tally muscle memory, kept</h3>
              <div className="keys">
                <kbd>F4</kbd>
                <kbd>F5</kbd>
                <kbd>F6</kbd>
                <kbd>F7</kbd>
                <kbd className="hot">F8</kbd>
                <kbd>F9</kbd>
              </div>
              <p>
                Contra, Payment, Receipt, Journal, Sales, Purchase. The function keys sit exactly where twenty
                years of habit left them. Dates take shorthand: type <span className="mono-inline">7</span> for the
                7th, <span className="mono-inline">7/4</span> for April, <span className="mono-inline">y</span> for
                yesterday.
              </p>
              <p>
                Enter walks the voucher field by field and asks to accept at the end, the way it always has.
              </p>
            </div>
            <div>
              <h3>And a few things Tally never learned</h3>
              <div className="keys">
                <kbd className="hot">⌘K</kbd>
                <kbd>⌘↵</kbd>
                <kbd>?</kbd>
              </div>
              <p>
                <span className="mono-inline">⌘K</span> reaches any screen or action by name.{' '}
                <span className="mono-inline">?</span> lists every shortcut, generated from the app itself, so it
                can never describe a key that no longer works.
              </p>
              <p>
                The app suggests ledgers by how you actually use them, warns when an entry looks like a duplicate,
                checks GSTIN check-digits as you type, and asks twice before an amount ten times a ledger&rsquo;s
                usual size.
              </p>
            </div>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio" id="proof">
          <h2 className="serif">Proof, not promises</h2>
          <p className="sub">Two screens from the app itself, running on the same demo books as the ledger above.</p>
          <div className="shots-grid">
            <figure>
              <Image
                src={gstr1Light}
                alt="GSTR-1 return screen showing B2B, B2C and total sections computed from voucher entries"
                sizes="(max-width: 800px) 100vw, 486px"
              />
              <figcaption className="caption">
                GSTR-1 computed from your books, exported as the JSON the portal takes.{' '}
                <Link href="/demo">See it done end to end.</Link>
              </figcaption>
            </figure>
            <figure>
              <Image
                src={voucherDark}
                alt="Sales voucher entry in dark theme with the party ledger picker open"
                sizes="(max-width: 800px) 100vw, 486px"
              />
              <figcaption className="caption">Dark theme, mid-entry. The ledger picker suggests as you type.</figcaption>
            </figure>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>

      <div className="band">
        <div className="wrap">
          <div className="band-grid">
            <div>
              <h2 className="serif">No cloud. No account. No &ldquo;sync&rdquo;.</h2>
              <p className="sub">
                Your ledgers are yours the way a bahi khata was yours: a thing on your desk, not a row in someone
                else&rsquo;s database.
              </p>
              <span className="path">~/Documents/total</span>
              <ul>
                <li>
                  <b>One SQLite file per company.</b> Copy the folder and you have backed up the business.
                </li>
                <li>
                  <b>Automatic snapshots</b> every time books open. The last twenty are kept.
                </li>
                <li>
                  <b>Works on a train, in a power cut, forever.</b> Filing happens through exported files, the way
                  offline Tally users have always filed.
                </li>
                <li>
                  <b>An assistant only if you want one.</b> Bring your own API key, or point it at a model running
                  on your own machine. It is off until you turn it on.
                </li>
              </ul>
            </div>
            <div>
              <p className="band-quote serif">
                Every figure the assistant gives you is quoted from a report, with the rows shown underneath.
              </p>
              <p className="band-quote-note">
                It reads your books through the same code that draws the screens, and it cannot change anything.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="wrap">
        <Testimonials />

        <div className="get" id="get">
          <h2 className="serif">Open your books tonight</h2>
          <p className="sub">
            Thirty days of everything, with no account and no card. Create a company and post your first
            voucher in under a minute.
          </p>
          <div className="hero-ctas" style={{ justifyContent: 'center' }}>
            <a className="btn" href="/api/download?platform=mac">
              Download for macOS
            </a>
            <a className="btn ghost" href="/api/download?platform=win">
              Download for Windows
            </a>
          </div>
          <p className="fine num">
            {release ? `Total ${release.version}` : 'Your data never leaves the machine'}
          </p>
        </div>

      </div>
      <SiteFooter />
    </>
  )
}
