import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Backups & data | Total Docs'
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
          <code>companies/&lt;slug&gt;/company.db</code>: one SQLite file per company; this is the single source of
          truth for every ledger, voucher, and report
        </li>
        <li>
          <code>companies/&lt;slug&gt;/backups/</code>: automatic snapshots (see below)
        </li>
        <li>
          <code>companies/&lt;slug&gt;/exports/</code>: PDFs, CSVs, and JSON you&rsquo;ve exported (invoices, GST
          returns, CA packs, registers)
        </li>
      </ul>

      <h2>Automatic snapshots</h2>
      <p>
        Total takes a WAL-safe snapshot of the active company automatically: every 30 minutes while it&rsquo;s open,
        once when you open a company, and once when you quit. It keeps the most recent 20 automatic snapshots and
        prunes older ones; any backup you take manually is never pruned.
      </p>

      <h2>Restoring a backup</h2>
      <p>
        Go to Settings → Backups, pick a snapshot, and restore it. Before it overwrites anything, Total takes a
        pre-restore safety copy of your current database, so a restore can never silently destroy the state you
        restored away from.
      </p>

      <h2>Complete backup for another computer</h2>
      <p>
        Automatic snapshots live next to your company file, which protects you from a bad voucher but not from a dead
        disk. For that, create a <b>complete encrypted backup</b>: one passphrase-protected file containing the verified
        database, managed documents, workflow files, and a portable key for encrypted attachments. Copy it to a drive,
        another machine, or storage you control. Total does not upload it for you.
      </p>

      <h2>Moving to a new machine</h2>
      <p>
        From the company launcher, choose Restore backup and select the <code>.totalbak</code> file. Total verifies the
        package before creating a separate restored company. Keep the passphrase outside the old computer; Total cannot
        recover it.
      </p>

      <h2>Privacy</h2>
      <p>
        Nothing about your business, including ledger names, amounts or company data, ever leaves the
        machine. The only network call Total makes on its own is a periodic check against the update endpoint to see
        whether a newer version is available; that request carries a version number and nothing else.
      </p>
    </>
  )
}
