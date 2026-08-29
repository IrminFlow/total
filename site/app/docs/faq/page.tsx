import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'FAQ - Docs'
}

export default function FaqPage(): React.JSX.Element {
  return (
    <>
      <h1 className="serif">Frequently asked questions</h1>
      <p className="sub">The honest answers, including the ones that aren&rsquo;t flattering.</p>

      <h2>Is it free?</h2>
      <p>
        Yes, while Total is in beta. When sales open, the Business licence is planned at ₹9,900 plus applicable taxes
        for perpetual use of that major version, including 12 months of updates and support. Optional Care renewals
        extend updates and support; existing books and portable export are never disabled. See <a href="/pricing">pricing</a>.
      </p>

      <h2>Does it run on Windows?</h2>
      <p>
        Yes. Total ships a native macOS build (Apple Silicon) and a Windows installer. Both talk to the same
        <code>~/Documents/total</code>-style data folder and the same file format, so a company created on one platform
        opens on the other if you copy the folder across.
      </p>

      <h2>Is my data safe and private?</h2>
      <p>
        Your books stay in a local company folder. Total has no required online account and does not upload accounting
        data in the background. The app checks for updates without sending book contents. Data leaves only when you
        deliberately export it, submit a support case, enable an integration, or approve visible context for an AI
        provider. Local user profiles and PINs control access on the same installation.
      </p>

      <h2>Can my CA use it?</h2>
      <p>
        Yes. Company details has a <b>CA export pack</b> that writes a Tally-importable XML file plus every register
        (sales, purchase, ledger, stock, GST) as CSV in one go, so your accountant can work in whatever tool they
        already use without you re-typing anything.
      </p>

      <h2>Does it support multiple users?</h2>
      <p>
        No. Total is built for a single machine. It does have local user profiles with PIN login and
        owner/accountant/viewer roles, plus a full audit trail of who changed what, but that&rsquo;s access control on
        one installation, not simultaneous multi-user editing over a network. If several people need to post
        vouchers into the same books at the same time, Total isn&rsquo;t the right fit yet.
      </p>

      <h2>Can I import from Tally?</h2>
      <p>
        Yes, via Tally&rsquo;s XML export. See <a href="/docs/coming-from-tally">Coming from Tally</a> for the exact
        steps and the current limits (cost centres and bill references are skipped; multi-currency amounts land as
        INR).
      </p>

      <h2>What happens when I&rsquo;m offline?</h2>
      <p>
        Everything works: vouchers, reports, GST computation, invoicing, payroll, banking reconciliation and backups.
        All of it runs locally with no network required. Update checks, AI providers and optional online integrations
        wait for a connection; the books keep running on the version you have.
      </p>

      <h2>macOS says the app is damaged and can&rsquo;t be opened. What now?</h2>
      <p>
        Total&rsquo;s builds aren&rsquo;t code-signed yet, so Gatekeeper quarantines the download and shows that
        message. Right-click → Open does <b>not</b> get past it for this build. The fix:
      </p>
      <pre>
        <code>{`# 1. Move Total.app into /Applications (drag it, or:)
mv ~/Downloads/Total.app /Applications/

# 2. Clear the quarantine flag
xattr -cr /Applications/Total.app

# 3. Open normally by double-clicking, or:
open /Applications/Total.app`}</code>
      </pre>
      <p className="muted">
        You only need to do this once per download. Full details in{' '}
        <a href="/docs">Getting started</a>.
      </p>
    </>
  )
}
