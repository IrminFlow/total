import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession } from '../state/stores'
import { EmptyState, Money, Panel, SectionTitle } from '../components/ui'
import { toDisplayDate } from '@shared/dates'

function fmtQty(qtyMilli: number, decimals: number): string {
  return (qtyMilli / 1000).toFixed(decimals)
}

export function StockSummaryScreen(): React.JSX.Element {
  const { to } = useSession()
  const { data } = useQuery({ queryKey: ['stockSummary', to], queryFn: () => api.reports.stockSummary(to) })
  const rows = data ?? []

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle right={<span className="num text-[12px] text-muted">as on {toDisplayDate(to)}</span>}>
        Stock summary
      </SectionTitle>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No stock items yet" hint="Create items under Masters, or straight from a sales/purchase voucher" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r w-32">Inwards</th>
                <th className="r w-32">Outwards</th>
                <th className="r w-32">Closing qty</th>
                <th className="r w-40">Closing value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.stockItemId} className={r.closingQtyMilli < 0 ? 'text-cr' : ''}>
                  <td>
                    {r.name}
                    {r.closingQtyMilli < 0 && <span className="ml-2 text-[11px]">— negative stock, check entries</span>}
                  </td>
                  <td className="r num">{fmtQty(r.inwardQtyMilli, r.decimals)} {r.unitSymbol}</td>
                  <td className="r num">{fmtQty(r.outwardQtyMilli, r.decimals)} {r.unitSymbol}</td>
                  <td className="r num">{fmtQty(r.closingQtyMilli, r.decimals)} {r.unitSymbol}</td>
                  <td className="r">
                    <Money paise={r.closingValue} />
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={4}>Total</td>
                <td className="r">
                  <Money paise={rows.reduce((s, r) => s + r.closingValue, 0)} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
