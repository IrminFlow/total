import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Backups & data — Total Docs'
}

export default function BackupsPage(): React.JSX.Element {
  return (
    <>
      <h1 className="serif">Backups & data</h1>
      <p className="sub">Your books are a folder on disk. Here&rsquo;s exactly what&rsquo;s in it and how it&rsquo;s protected.</p>

      <h2>File layout</h2>
      <p>
        Everything lives under <code>~/Documents/total/</code>:
      </p>
      <ul>
        <li>
          <code>companies/&lt;slug&gt;/company.db</code> — one SQLite file per company; this is the single source of
          truth for every ledger, voucher, and report
        </li>
        <li>
          <code>companies/&lt;slug&gt;/backups/</code> — automatic snapshots (see below)
        </li>
        <li>
          <code>companies/&lt;slug&gt;/exports/</code> — PDFs, CSVs, and JSON you&rsquo;ve exported (invoices, GST
          returns, CA packs, registers)
        </li>
      </ul>

      <h2>Automatic snapshots</h2>
      <p>
        Total takes a WAL-safe snapshot of the active company automatically — every 30 minutes while it&rsquo;s open,
        once when you open a company, and once when you quit. It keeps the most recent 20 automatic snapshots and
        prunes older ones; any backup you take manually is never pruned.
      </p>

      <h2>Restoring a backup</h2>
      <p>
        Go to Settings → Backups, pick a snapshot, and restore it. Before it overwrites anything, Total takes a
        pre-restore safety copy of your current database — so a restore can never silently destroy the state you
        restored away from.
      </p>

      <h2>Encrypted export, for off-machine backup</h2>
      <p>
        Automatic snapshots live next to your company file, which protects you from a bad voucher but not from a dead
        disk. For that, export an <b>encrypted backup</b> — a single AES-256-GCM file locked with a passphrase you
        choose — and copy it to a drive, another machine, or cloud storage of your choice. Total never uploads it
        anywhere itself.
      </p>

      <h2>Moving to a new machine</h2>
      <p>
        Copy the whole <code>~/Documents/total/</code> folder to the new machine and open Total — every company,
        with full history, comes across intact. There&rsquo;s no export/import step and nothing to re-enter.
      </p>

      <h2>Privacy</h2>
      <p>
        Nothing about your business — no ledger names, no amounts, no company data of any kind — ever leaves the
        machine. The only network call Total makes on its own is a periodic check against the update endpoint to see
        whether a newer version is available; that request carries a version number and nothing else.
      </p>
    </>
  )
}
