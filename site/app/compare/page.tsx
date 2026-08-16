import type { Metadata } from 'next'
import SiteNav from '@/components/SiteNav'

export const metadata: Metadata = {
  title: 'Total vs TallyPrime'
}

const ROWS: { particular: string; total: string; tally: string }[] = [
  { particular: 'Price', total: '₹0 (beta)', tally: '₹750+ / month' },
  { particular: 'Fully offline', total: '✓', tally: '✓' },
  { particular: 'Native macOS app', total: '✓', tally: '✗' },
  { particular: 'Data format', total: 'Open SQLite file', tally: 'Proprietary' },
  { particular: 'GSTR-1 / GSTR-3B', total: '✓', tally: '✓' },
  { particular: 'e-Invoice / e-Way bill', total: 'Offline JSON always; live filing experimental', tally: 'Mature, live filing' },
  { particular: 'Payroll', total: 'Basic, built in', tally: 'Paid add-on module' },
  { particular: 'Inventory & manufacturing', total: 'Stock + BOM', tally: 'Deeper inventory tooling' },
  { particular: 'Bank reconciliation', total: '✓', tally: '✓' },
  { particular: 'Multi-user', total: '✗', tally: '✓' },
  { particular: 'Audit trail', total: '✓', tally: '✓' },
  { particular: '⌘K command search', total: '✓', tally: '✗' },
  { particular: 'Updates', total: 'Auto-updates itself', tally: 'Manual' },
  { particular: 'Track record', total: 'Beta', tally: '30+ years in the market' }
]

export default function ComparePage(): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section>
          <h1 className="serif">Total vs TallyPrime</h1>
          <p className="sub">An honest, row-by-row comparison — including where Tally is still ahead.</p>

          <div className="ledger" style={{ marginTop: 34 }}>
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

          <p className="sub" style={{ marginTop: 34, marginBottom: 88 }}>
            Total is a young, single-developer offline app built for macOS — it does the everyday books, GST returns and
            payroll well, but it is still a beta with one person behind it and no multi-user support. If your business
            needs multiple simultaneous users, deeper inventory, or the statutory breadth of a 30-year-old product
            today, buy Tally.
          </p>
        </section>
      </div>
    </>
  )
}
