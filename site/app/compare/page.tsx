import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import FunnelBeacon from "@/components/FunnelBeacon";

export const metadata: Metadata = {
  title: "Total vs TallyPrime",
  description:
    "Compare Total and TallyPrime for offline accounting, macOS, GST, payroll, inventory and multi-user work.",
  alternates: { canonical: "/compare" },
};

const ROWS: { particular: string; total: string; tally: string }[] = [
  {
    particular: "Price",
    total: "₹0 beta; ₹9,900 perpetual Business licence after beta",
    tally: "See current Tally pricing",
  },
  { particular: "Fully offline", total: "✓", tally: "✓" },
  { particular: "Native macOS app", total: "✓", tally: "✗" },
  {
    particular: "Data format",
    total: "Open SQLite file",
    tally: "Proprietary",
  },
  { particular: "GSTR-1 / GSTR-3B", total: "✓", tally: "✓" },
  {
    particular: "e-Invoice / e-Way bill",
    total: "Offline JSON always; live filing experimental",
    tally: "Mature, live filing",
  },
  {
    particular: "Payroll",
    total: "Pay heads, EPF/ESI/PT, payslips",
    tally: "Paid add-on module",
  },
  {
    particular: "Inventory & manufacturing",
    total: "BOM, batches & expiry, godowns, FIFO / weighted avg, price levels",
    tally: "Deeper inventory tooling",
  },
  {
    particular: "Bank reconciliation",
    total: "✓ + BRS, rules, cheque printing",
    tally: "✓",
  },
  { particular: "Cash flow & ratio reports", total: "✓", tally: "✓" },
  { particular: "Cost centres & budgets", total: "✓", tally: "✓" },
  {
    particular: "Reviewed automation inbox",
    total: "✓",
    tally: "Check current product",
  },
  {
    particular: "Multi-user",
    total: "Local users + roles (one machine)",
    tally: "✓ (network)",
  },
  { particular: "Audit trail", total: "✓", tally: "✓" },
  { particular: "⌘K command search", total: "✓", tally: "✗" },
  {
    particular: "Updates",
    total: "In-app update checks",
    tally: "Check current product",
  },
  {
    particular: "Track record",
    total: "Beta",
    tally: "30+ years in the market",
  },
];

export default function ComparePage(): React.JSX.Element {
  return (
    <>
      <FunnelBeacon event="compare_view" />
      <SiteNav />
      <main className="wrap">
        <section>
          <h1 className="serif">Total vs TallyPrime</h1>
          <p className="sub">
            A row-by-row comparison, including where Tally is still ahead.
          </p>

          <div className="ledger compare-ledger">
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

          <p className="compare-note">
            This comparison describes Total v5. Competitor pricing and
            capabilities can change, so verify current TallyPrime terms before
            purchasing.
          </p>

          <div className="compare-verdict" aria-label="Which product fits">
            <article>
              <h2 className="serif">Choose Total when</h2>
              <p>
                You want native macOS or Windows books on one machine, local
                files, familiar voucher keys and reviewed offline exports.
              </p>
            </article>
            <article>
              <h2 className="serif">Choose TallyPrime when</h2>
              <p>
                You need simultaneous network users, a longer operating track
                record or workflows beyond Total&rsquo;s current scope.
              </p>
            </article>
          </div>
          <div className="hero-ctas compare-ctas">
            <a className="btn" href="/api/download">
              Download the free beta
            </a>
            <Link className="text-link" href="/docs/coming-from-tally">
              Read the migration guide
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
