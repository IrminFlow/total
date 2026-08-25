import Image from 'next/image'
import Link from 'next/link'
import SiteNav from '@/components/SiteNav'
import { latestRelease } from '@/lib/release'
import gatewayLight from '@/public/gateway-light.jpg'
import voucherDark from '@/public/voucher-dark.jpg'
import gstr1Light from '@/public/gstr1-light.jpg'
import FunnelBeacon from '@/components/FunnelBeacon'

const CAPABILITIES = [
  {
    title: 'Run the books',
    summary: 'Fast daily entry with controls that keep the ledger dependable.',
    items: [
      'Contra, payment, receipt, journal, sales, purchase, debit note and credit note vouchers',
      'Invoice mode with live GST, stock allocation and a complete audit trail',
      'Monthly and financial-year quarterly sales or purchase registers with voucher drill-down',
      'Receivable and payable ageing with FIFO bill settlement'
    ]
  },
  {
    title: 'Know the position',
    summary: 'Reports are calculated from voucher lines, never copied into a second balance store.',
    items: [
      'Action centre for collections, exceptions, recurring work, low stock and compliance dates',
      'Profit and loss, balance sheet, cash flow, ratios and prior-year comparisons',
      'Bank statement matching, reconciliation rules and cheque printing',
      'Multi-currency invoices while the books remain in rupees'
    ]
  },
  {
    title: 'Handle Indian operations',
    summary: 'The everyday statutory and operating work is part of the same set of books.',
    items: [
      'GSTR-1 and GSTR-3B review with validated JSON for the portal offline tools',
      'e-Invoice and e-Way Bill JSON exports for review before upload',
      'Weighted-average stock, batches, godowns and bill-of-material manufacture vouchers',
      'EPF, ESI and professional tax calculations with payslips and balanced payroll posting'
    ]
  },
  {
    title: 'Extend carefully',
    summary: 'Automation stays optional, visible and subject to approval.',
    items: [
      'OpenAI or an OpenAI-compatible provider with explicit context sharing',
      'Voucher drafts that cannot post without human approval',
      'JSON mirrors and a local MCP server for agent access without direct database edits',
      'Tally XML import for masters, opening balances, GSTINs and vouchers'
    ]
  }
] as const

export default async function Home(): Promise<React.JSX.Element> {
  const release = await latestRelease()
  const releaseNote = release ? `Version ${release.version} available` : 'Check download availability'

  return (
    <>
      <FunnelBeacon event="landing_view" />
      <SiteNav />
      <main>
        <div className="wrap">
          <section className="home-hero">
            <div className="home-hero-copy">
              <p className="eyebrow">Accounting for Indian businesses</p>
              <h1 className="serif">Your books stay local.</h1>
              <p className="lede">Double-entry accounting, GST, inventory, banking and payroll. No cloud account is required.</p>
              <div className="hero-ctas">
                <a className="btn" href="/api/download">Download Total</a>
                <Link className="text-link" href="/docs">Read the guide</Link>
              </div>
            </div>
            <figure className="hero-product">
              <Image
                src={gatewayLight}
                alt="Total Gateway showing cash, receivables, payables, GST and the day's entries"
                priority
                sizes="(max-width: 800px) 100vw, 660px"
              />
              <figcaption>Open the company and see the position before entering another voucher.</figcaption>
            </figure>
          </section>

          <div className="release-strip" aria-label="Download and product availability">
            <span>{releaseNote}</span>
            <span>macOS Apple Silicon</span>
            <a href="/api/download?platform=win">Windows download</a>
            <span>Accounting works offline</span>
          </div>

          <section className="accounting-proof" aria-labelledby="accounting-proof-heading">
            <div className="section-intro">
              <h2 id="accounting-proof-heading" className="serif">One source of truth for every report</h2>
              <p className="sub">Vouchers post to real double-entry books. Reports are recalculated from those entries, so copied balances cannot drift.</p>
            </div>
            <dl className="proof-facts">
              <div><dt>Money</dt><dd>Stored as integer paise</dd></div>
              <div><dt>Reports</dt><dd>Computed from voucher lines</dd></div>
              <div><dt>Companies</dt><dd>One local file per business</dd></div>
              <div><dt>AI actions</dt><dd>Draft first, approve before posting</dd></div>
            </dl>
          </section>

          <section id="ledger" className="capabilities" aria-labelledby="capabilities-heading">
            <div className="section-intro">
              <h2 id="capabilities-heading" className="serif">The work, organised around your day</h2>
              <p className="sub">From the first voucher to the final review, each task stays connected to the books that produced it.</p>
            </div>
            <div className="capability-grid">
              {CAPABILITIES.map((group, index) => (
                <article className={`capability capability-${index + 1}`} key={group.title}>
                  <div><h3>{group.title}</h3><p>{group.summary}</p></div>
                  <ul>{group.items.map((item) => <li key={item}>{item}</li>)}</ul>
                </article>
              ))}
            </div>
          </section>

          <section id="proof" className="product-proof" aria-labelledby="product-proof-heading">
            <div className="section-intro">
              <h2 id="product-proof-heading" className="serif">See the work before you rely on it</h2>
              <p className="sub">These are screens from the app, running against the same demo company.</p>
            </div>
            <div className="proof-layout">
              <figure className="proof-large">
                <Image
                  src={gstr1Light}
                  alt="GSTR-1 return showing B2B, B2C and total sections computed from vouchers"
                  sizes="(max-width: 800px) 100vw, 720px"
                />
                <figcaption>Review GSTR-1 from the books, then export the validated offline-tool JSON.</figcaption>
              </figure>
              <figure className="proof-small">
                <Image
                  src={voucherDark}
                  alt="Sales voucher entry in dark theme with the party ledger picker open"
                  sizes="(max-width: 800px) 100vw, 430px"
                />
                <figcaption>Ledger suggestions appear while you enter the voucher.</figcaption>
              </figure>
            </div>
          </section>

          <section className="local-section" aria-labelledby="local-heading">
            <div className="local-copy">
              <h2 id="local-heading" className="serif">A company folder you can inspect, copy and restore</h2>
              <p className="sub">Each business stays in a folder you control. Accounting remains available without an internet connection.</p>
              <code className="path">~/Documents/total</code>
            </div>
            <ul className="local-details">
              <li><b>Separate companies.</b><span>Books, attachments and recovery files stay together.</span></li>
              <li><b>Automatic recovery.</b><span>Snapshots are taken while the books are open, with the latest twenty retained.</span></li>
              <li><b>Portable work.</b><span>Export PDFs, spreadsheets and reviewed statutory files when you choose.</span></li>
            </ul>
          </section>

          <section className="keyboard-section" aria-labelledby="keyboard-heading">
            <div className="keyboard-heading">
              <h2 id="keyboard-heading" className="serif">Keep the accounting muscle memory</h2>
              <p className="sub">Use familiar voucher keys, then reach any other screen with command search.</p>
            </div>
            <div className="keyboard-columns">
              <article>
                <h3>Voucher keys</h3>
                <div className="keys" aria-label="Voucher keyboard shortcuts">
                  <kbd>F4 Contra</kbd><kbd>F5 Payment</kbd><kbd>F6 Receipt</kbd>
                  <kbd>F7 Journal</kbd><kbd className="hot">F8 Sales</kbd><kbd>F9 Purchase</kbd>
                </div>
                <p>Dates accept shorthand, and every voucher type is available without leaving the keyboard.</p>
              </article>
              <article>
                <h3>Anywhere in Total</h3>
                <div className="keys" aria-label="Application keyboard shortcuts">
                  <kbd className="hot">⌘K Search</kbd><kbd>⌘↵ Save</kbd><kbd>Esc Back</kbd>
                </div>
                <p>Search screens and actions by name. Move through lists with arrow keys and drill in with Enter.</p>
              </article>
            </div>
          </section>

          <section className="get" id="get" aria-labelledby="download-heading">
            <h2 id="download-heading" className="serif">Start with a company you know</h2>
            <p className="sub">The public beta is free. Create a company, enter a voucher and check the reports for yourself.</p>
            <div className="hero-ctas">
              <a className="btn" href="/api/download?platform=mac">Download for macOS</a>
              <a className="btn ghost" href="/api/download?platform=win">Download for Windows</a>
            </div>
          </section>
        </div>
      </main>
    </>
  )
}
