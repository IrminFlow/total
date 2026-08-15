import Image from 'next/image'
import { latestRelease } from '@/lib/release'
import gatewayLight from '@/public/gateway-light.jpg'
import voucherDark from '@/public/voucher-dark.jpg'

const FEATURES: { f: string; p: string }[] = [
  { f: 'Vouchers', p: 'Contra to credit note, invoice mode with live GST, audit log on every change' },
  { f: 'GST returns', p: "GSTR-1 and GSTR-3B on screen, exported as JSON the portal's offline tool accepts" },
  { f: 'e-Invoice & e-Way', p: 'Offline JSON for the government tools — or live IRN and e-way bill generation with your NIC credentials' },
  { f: 'Invoice PDF', p: 'GST tax invoice with HSN, tax breakup, amount in words and the double rule' },
  { f: 'Stock & manufacturing', p: 'Weighted-average valuation, bills of materials, one-screen manufacture vouchers' },
  { f: 'Banking', p: 'Reconciliation with statement CSV import that matches entries by amount and date' },
  { f: 'Payroll', p: 'EPF, ESI and professional tax computed to the rupee; payslip PDFs; one balanced posting' },
  { f: 'Registers & ageing', p: 'Sales and purchase registers, receivable and payable ageing with FIFO bill settlement' },
  { f: 'Multi-currency', p: 'Invoice in USD or EUR at your rate; the books stay in rupees' },
  { f: 'Tally import', p: "Bring your masters and vouchers across from Tally's XML export" }
]

export default async function Home(): Promise<React.JSX.Element> {
  const release = await latestRelease()
  const versionNote = release ? `v${release.version} · Apple Silicon` : 'Free beta · Apple Silicon'

  return (
    <>
      <div className="wrap">
        <div className="top">
          <span className="wordmark serif">Total</span>
          <span className="tag">for macOS · fully offline</span>
          <span className="cta-mini">
            <a className="btn small" href="/api/download">
              Download
            </a>
          </span>
        </div>

        <div className="hero">
          <p className="eyebrow">Accounting for Indian businesses</p>
          <h1 className="serif">
            Your books. On this Mac. <span className="quiet">Nowhere else.</span>
          </h1>
          <p className="lede">
            Total is Tally-grade double-entry accounting rebuilt for macOS — GST returns, invoices, stock, banking and
            payroll, all computed on your machine and saved in a folder you can copy. No cloud. No account. No internet
            required.
          </p>
          <div className="hero-ctas">
            <a className="btn" href="/api/download">
              Download for macOS
            </a>
            <a className="btn ghost" href="#ledger">
              See what&rsquo;s inside
            </a>
            <span className="hero-note">{versionNote}</span>
          </div>

          <div className="ledger-strip" role="img" aria-label="Three ledger rows with the amber selection bar on the middle entry">
            <div className="strip-row">
              <span className="d num">14-Aug-26</span>
              <span className="t">Purchase</span>
              <span className="p">Bulk Suppliers</span>
              <span className="a num">2,36,000.00</span>
            </div>
            <div className="strip-row active">
              <span className="d num">15-Aug-26</span>
              <span className="t">Sales</span>
              <span className="p">Umbrella Retail — 2 × Laptop 14&Prime;, CGST + SGST computed live</span>
              <span className="a num">1,06,200.00</span>
            </div>
            <div className="strip-row">
              <span className="d num">15-Aug-26</span>
              <span className="t">Receipt</span>
              <span className="p">Cash</span>
              <span className="a num">50,000.00</span>
            </div>
          </div>
          <p className="strip-hint">
            The amber bar is the cursor. <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>↵</kbd> drills in, <kbd>Esc</kbd> backs out
            — everywhere.
          </p>
        </div>

        <div className="shot">
          <Image
            src={gatewayLight}
            alt="The Total Gateway: cash, receivables, payables and GST tiles above the day's entries"
            priority
            sizes="(max-width: 1020px) 100vw, 972px"
          />
          <p className="caption">The Gateway — your whole position the moment the books open.</p>
        </div>

        <section id="ledger">
          <h2 className="serif">The ledger of features</h2>
          <p className="sub">
            Everything posts to real double-entry books — every report below is computed from vouchers, so nothing can
            drift.
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
                  <td className="r amt">₹0 / month</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="band">
        <div className="wrap">
          <div className="band-grid">
            <div>
              <h2 className="serif">No cloud. No account. No &ldquo;sync&rdquo;.</h2>
              <p className="sub">
                Your ledgers are yours the way a bahi khata was yours — a thing on your desk, not a row in someone
                else&rsquo;s database.
              </p>
              <span className="path">~/Documents/total</span>
              <ul>
                <li>
                  <b>One SQLite file per company.</b> Copy the folder and you&rsquo;ve backed up the business.
                </li>
                <li>
                  <b>Automatic snapshots</b> every time books open — the last twenty are kept.
                </li>
                <li>
                  <b>Works on a train, in a power cut, forever.</b> Filing happens through exported files, the way
                  offline Tally users have always filed.
                </li>
              </ul>
            </div>
            <div>
              <Image
                src={voucherDark}
                alt="Voucher entry in dark theme with the ledger picker open"
                sizes="(max-width: 800px) 100vw, 550px"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="wrap">
        <section>
          <h2 className="serif">Your fingers already know it</h2>
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
                Contra, Payment, Receipt, Journal, Sales, Purchase — the function keys sit exactly where twenty years of
                habit left them. Dates take shorthand: type <span className="mono-inline">7</span> for the 7th,{' '}
                <span className="mono-inline">7/4</span> for April, <span className="mono-inline">y</span> for yesterday.
              </p>
              <p>
                Moving from Tally? Export your masters and day book as XML and import them in one step — opening
                balances, GSTINs and vouchers included.
              </p>
            </div>
            <div>
              <h3>And a few things Tally never learned</h3>
              <div className="keys">
                <kbd className="hot">⌘K</kbd>
                <kbd>⌘↵</kbd>
                <kbd>Esc</kbd>
              </div>
              <p>
                <span className="mono-inline">⌘K</span> reaches any screen or action by name. The app suggests ledgers
                by how you actually use them, warns when an entry looks like a duplicate, checks GSTIN check-digits as
                you type, and asks twice before an amount ten times a ledger&rsquo;s usual size.
              </p>
              <p>
                Updates arrive on their own: the app checks GitHub releases and installs new versions with one restart —
                your books never move.
              </p>
            </div>
          </div>
        </section>

        <div className="get" id="get">
          <h2 className="serif">Open your books tonight</h2>
          <p className="sub">
            One DMG, Apple Silicon, free while in beta. Create a company and post your first voucher in under a minute.
          </p>
          <a className="btn" href="/api/download">
            Download Total for macOS
          </a>
          <p className="fine num">
            {release ? `Total ${release.version} · auto-updates from GitHub releases` : 'your data never leaves the machine'}
          </p>
        </div>

        <footer>
          <span>Total — offline accounting for macOS.</span>
          <span>Made for the desk that used to hold the bahi khata.</span>
        </footer>
      </div>
    </>
  )
}
