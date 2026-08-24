import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'GST returns | Total Docs'
}

export default function GstReturnsPage(): React.JSX.Element {
  return (
    <>
      <h1 className="serif">GST returns</h1>
      <p className="sub">
        Everything is computed from your vouchers at query time. The return you see is always what your books say
        today.
      </p>

      <h2>What Total computes</h2>
      <p>
        <b>GSTR-1:</b> outward supplies, split into the sections the portal expects: B2B, B2CL, B2CS, credit/debit
        notes (CDNR), and the HSN summary.
      </p>
      <p>
        <b>GSTR-3B:</b> the summary return, with the tax liability breakup and eligible ITC computed from your
        purchase-side vouchers.
      </p>
      <p>
        <b>GSTR-2B reconciliation:</b> import the portal&rsquo;s 2B JSON and Total matches it line by line against
        your purchase register, sorting everything into matched, mismatch, and missing buckets so you can see exactly
        which vendor invoices need a follow-up before you claim ITC.
      </p>

      <h2>The month-end flow</h2>
      <ol>
        <li>Review GSTR-1 and GSTR-3B on screen. Press <kbd>1</kbd> or <kbd>3</kbd> from the Gateway.</li>
        <li>Import the GSTR-2B JSON from the portal and reconcile against your purchases.</li>
        <li>
          Clear the <b>validation panel</b>. Export stays disabled while anything blocking remains (missing HSN,
          invalid buyer GSTINs, duplicate invoice numbers, booked totals that don&rsquo;t tie to computed tax). Each
          issue drills straight into the offending vouchers.
        </li>
        <li>Export GSTR-1 / GSTR-3B as JSON. The GSTR-1 file carries the full table set, including the HSN summary (Table 12), documents issued (Table 13), advances (11A/11B) and nil-rated (Table 8).</li>
        <li>Upload that JSON through the GST portal&rsquo;s offline tool, the same way offline Tally users always have.</li>
      </ol>
      <p className="muted">
        Filing deadlines: GSTR-1 is due on the 11th, GSTR-3B on the 20th, of the month following the tax period. A
        compliance panel inside Total tracks these dates against your own filing history so upcoming and overdue
        returns show up without you needing to remember the calendar.
      </p>

      <h2>e-Invoice & e-Way bill</h2>
      <p>
        Every e-invoice and e-way bill goes through the same offline-first path: Total builds the JSON payload the
        NIC schema expects, including credit/debit note references (CRN/DBN) and SEZ/export supply types, that you
        can upload through the NIC&rsquo;s own offline tools. E-way bills export both ways: one combined bulk file
        for the period, and a <b>separate JSON per consignment</b> (the portal&rsquo;s bulk tool processes one bill
        per file), each carrying the mandatory from/to place, PIN codes and transaction type from the voucher&rsquo;s
        transport details.
      </p>
      <p>
        There is also a <b>live filing</b> path that talks to the NIC APIs directly and returns an IRN or e-way bill
        number in the app. Treat this as experimental. It&rsquo;s built to the published API spec but hasn&rsquo;t
        been run against the real portal. If you use it, test against the NIC sandbox first before pointing it at
        production credentials.
      </p>

      <h2>Composition dealers</h2>
      <p>
        Total&rsquo;s GSTR-1 and GSTR-3B builders target <b>regular</b> GST registration. If your company is
        registered under the composition scheme, use Total for your books and invoicing, but file your CMP-08 /
        GSTR-4 returns through another route for now.
      </p>
    </>
  )
}
