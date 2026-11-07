import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'FAQ — Total Docs'
}

export default function FaqPage(): React.JSX.Element {
  return (
    <>
      <h1 className="serif">Frequently asked questions</h1>
      <p className="sub">The honest answers, including the ones that aren&rsquo;t flattering.</p>

      <h2>Is it free?</h2>
      <p>
        Yes, while Total is in beta. There&rsquo;s no subscription, no per-user seat, and no server bill — the app runs
        entirely on your Mac or PC and the only cost is the machine you already own.
      </p>

      <h2>Does it run on Windows?</h2>
      <p>
        Yes. Total ships a native macOS build (Apple Silicon, macOS 13 Ventura or later) and a Windows installer. Both talk to the same
        <code>~/Documents/total</code>-style data folder and the same file format, so a company created on one platform
        opens on the other if you copy the folder across.
      </p>

      <h2>Is my data safe and private?</h2>
      <p>
        Your books stay on your machine. Two features send something only once you turn them on: the AI helper
        (questions and bills go to the AI service with your key; identifiers in text are masked by default, but photos and scans of bills are sent as they are) and GST e-invoice /
        e-way bill filing (the invoice goes to the government portal). The update check is on by default; it sends no
        business data, and you can turn it off. There is no account, no login, and no background sync — your books are a folder of SQLite files that
        only your copy of Total touches.
      </p>

      <h2>Can my CA use it?</h2>
      <p>
        Yes. Company details has a <b>CA export pack</b> that writes a Tally-importable XML file plus every register
        (sales, purchase, ledger, stock, GST) as CSV in one go, so your accountant can work in whatever tool they
        already use without you re-typing anything.
      </p>

      <h2>Does it support multiple users?</h2>
      <p>
        No — Total is built for a single machine. It does have local user profiles with PIN login and
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
        Everything works. Vouchers, reports, GST computation, invoicing, payroll, banking reconciliation, backups —
        all of it runs locally with no network required. Only the AI helper, live e-invoice / e-way bill filing and
        the update check want a connection, and without one the rest of the app keeps working.
      </p>

      <h2>macOS says the app is damaged and can&rsquo;t be opened — now what?</h2>
      <p>
        Total&rsquo;s builds aren&rsquo;t code-signed yet, so Gatekeeper quarantines the download and shows that
        message. Right-click → Open does <b>not</b> get past it for this build. The fix:
      </p>
      <pre>
        <code>{`# 1. Move Total.app into /Applications (drag it, or:)
mv ~/Downloads/Total.app /Applications/

# 2. Clear the quarantine flag
xattr -cr /Applications/Total.app

# 3. Open normally — double-click, or:
open /Applications/Total.app`}</code>
      </pre>
      <p className="muted">
        You only need to do this once per download. Full details in{' '}
        <a href="/docs">Getting started</a>.
      </p>
    </>
  )
}
