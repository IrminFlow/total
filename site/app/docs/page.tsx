import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Getting started | Total Docs'
}

export default function GettingStartedPage(): React.JSX.Element {
  return (
    <>
      <h1 className="serif">Getting started</h1>
      <p className="sub">Download Total, open your first company and post a voucher in about five minutes.</p>

      <h2>1. Download & first launch</h2>
      <p>
        Grab the build for your machine from the <a href="/">homepage</a>: macOS (Apple Silicon) or Windows. Total
        isn&rsquo;t code-signed yet, so on macOS Gatekeeper will say the app &ldquo;is damaged and can&rsquo;t be
        opened&rdquo;. Right-click → Open does <b>not</b> get past this for the current build. Instead:
      </p>
      <pre>
        <code>{`# 1. Move Total.app into /Applications
mv ~/Downloads/Total.app /Applications/

# 2. Clear the quarantine flag Gatekeeper set on download
xattr -cr /Applications/Total.app

# 3. Now it opens normally. Double-click, or:
open /Applications/Total.app`}</code>
      </pre>
      <p className="muted">
        You only need to do this once per downloaded version. Later launches (and auto-updates) open normally.
      </p>

      <h2>2. Create your company</h2>
      <p>The first screen you&rsquo;ll see is company creation. It asks for:</p>
      <ul>
        <li>
          <b>Company name</b>
        </li>
        <li>
          <b>State:</b> used for GST place-of-supply and CGST/SGST vs IGST decisions
        </li>
        <li>
          <b>Books begin (FY):</b> the financial year your opening balances start from, e.g. &ldquo;1 Apr
          2025&rdquo;
        </li>
        <li>
          <b>GSTIN:</b> optional; leave it empty if you&rsquo;re not GST-registered
        </li>
        <li>
          <b>Registration type:</b> Regular or Composition, shown once a GSTIN is entered (Total&rsquo;s GST return
          builders target regular registration; see <a href="/docs/gst-returns">GST returns</a>)
        </li>
        <li>
          <b>Address</b>
        </li>
      </ul>
      <p>
        Each company gets its own SQLite file, so you can run as many separate businesses side by side as you like
        without their books ever touching.
      </p>

      <h2>3. The Gateway, in one screen</h2>
      <p>
        Every session opens on the Gateway, a set of tiles showing your whole position. Each is reachable by a
        single-letter key from anywhere (as long as focus isn&rsquo;t in a text field):
      </p>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Opens</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <kbd>V</kbd>
            </td>
            <td>Voucher entry</td>
          </tr>
          <tr>
            <td>
              <kbd>D</kbd>
            </td>
            <td>Day book</td>
          </tr>
          <tr>
            <td>
              <kbd>M</kbd>
            </td>
            <td>Masters</td>
          </tr>
          <tr>
            <td>
              <kbd>T</kbd>
            </td>
            <td>Trial balance</td>
          </tr>
          <tr>
            <td>
              <kbd>P</kbd>
            </td>
            <td>Profit &amp; Loss</td>
          </tr>
          <tr>
            <td>
              <kbd>B</kbd>
            </td>
            <td>Balance sheet</td>
          </tr>
          <tr>
            <td>
              <kbd>S</kbd>
            </td>
            <td>Stock summary (when inventory is on)</td>
          </tr>
          <tr>
            <td>
              <kbd>1</kbd>
            </td>
            <td>GSTR-1</td>
          </tr>
          <tr>
            <td>
              <kbd>3</kbd>
            </td>
            <td>GSTR-3B</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        <kbd>⌘K</kbd> opens global search. Jump to any ledger, voucher, or command by typing its name from
        anywhere in the app.
      </p>

      <h2>4. Post your first sales invoice</h2>
      <p>
        Press <kbd>F8</kbd> from the Gateway (or <kbd>V</kbd> then pick Sales) to open a Sales voucher. Fill the
        party, add stock items or ledger lines, and GST computes live as you type quantities and rates. Save with{' '}
        <kbd>⌘↵</kbd>; back out of any screen with <kbd>Esc</kbd>. The same one-key pattern covers the rest of
        voucher entry:
      </p>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Voucher type</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <kbd>F4</kbd>
            </td>
            <td>Contra</td>
          </tr>
          <tr>
            <td>
              <kbd>F5</kbd>
            </td>
            <td>Payment</td>
          </tr>
          <tr>
            <td>
              <kbd>F6</kbd>
            </td>
            <td>Receipt</td>
          </tr>
          <tr>
            <td>
              <kbd>F7</kbd>
            </td>
            <td>Journal</td>
          </tr>
          <tr>
            <td>
              <kbd>F8</kbd>
            </td>
            <td>Sales</td>
          </tr>
          <tr>
            <td>
              <kbd>F9</kbd>
            </td>
            <td>Purchase</td>
          </tr>
          <tr>
            <td>
              <kbd>Ctrl/Alt+F8</kbd>
            </td>
            <td>Credit note</td>
          </tr>
          <tr>
            <td>
              <kbd>Ctrl/Alt+F9</kbd>
            </td>
            <td>Debit note</td>
          </tr>
        </tbody>
      </table>
      <p>
        Inside any list, including the ledger picker, item search and voucher list, <kbd>↑</kbd> <kbd>↓</kbd> move and{' '}
        <kbd>↵</kbd> drills in, exactly like the amber cursor bar on the homepage.
      </p>

      <h2>5. Where your files live</h2>
      <p>
        Everything lives under <code>~/Documents/total/</code>. Nothing touches the cloud:
      </p>
      <ul>
        <li>
          <code>companies/&lt;slug&gt;/company.db</code>: one SQLite file per company, the single source of truth
        </li>
        <li>
          <code>companies/&lt;slug&gt;/backups/</code>: automatic, WAL-safe snapshots taken every 30 minutes, on
          open, and on quit (the last 20 auto-snapshots are kept)
        </li>
        <li>
          <code>companies/&lt;slug&gt;/exports/</code>: PDFs, CSVs, and JSON you export (invoices, GST returns, CA
          packs, and so on)
        </li>
      </ul>
      <p className="muted">
        Copy the whole <code>total</code> folder anywhere and you&rsquo;ve backed up every company on the machine.
        More on snapshots and restoring in <a href="/docs/backups">Backups & data</a>.
      </p>
    </>
  )
}
