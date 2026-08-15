import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { EmptyState, Money, Panel, SectionTitle, useKeyNav } from '../components/ui'
import { toDisplayDate } from '@shared/dates'

export function LedgerStatementScreen({ ledgerId }: { ledgerId: number }): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const { data } = useQuery({
    queryKey: ['ledgerStatement', ledgerId, from, to],
    queryFn: () => api.reports.ledger(ledgerId, from, to)
  })

  const rows = data?.rows ?? []
  const { active, setActive } = useKeyNav(rows.length, (i) => {
    const r = rows[i]
    if (r) nav.go({ name: 'voucher-entry', voucherId: r.voucherId })
  })

  if (!data) return <p className="text-muted">Loading…</p>

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle right={<Money paise={data.closing} signed className="text-[15px]" />}>
        {data.ledgerName}
      </SectionTitle>
      <Panel>
        <div className="flex justify-between border-b border-line px-4 py-2 text-[12px] text-muted">
          <span>
            Opening balance · <Money paise={data.opening} signed />
          </span>
          <span>
            {toDisplayDate(from)} → {toDisplayDate(to)}
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No entries for this ledger in the period" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-24">Date</th>
                <th>Particulars</th>
                <th className="w-24">Type · No.</th>
                <th className="r w-32">Debit</th>
                <th className="r w-32">Credit</th>
                <th className="r w-36">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  data-active={i === active}
                  className="kbar-row cursor-pointer"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
                >
                  <td className="num text-muted">{toDisplayDate(r.date)}</td>
                  <td className="max-w-64 truncate">{r.particulars}</td>
                  <td className="num text-[12px] text-muted">
                    {r.voucherType} {r.number}
                  </td>
                  <td className="r">
                    <Money paise={r.debit} />
                  </td>
                  <td className="r">
                    <Money paise={r.credit} />
                  </td>
                  <td className="r">
                    <Money paise={r.running} signed />
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={3}>Closing balance</td>
                <td className="r">
                  <Money paise={data.totalDebit} />
                </td>
                <td className="r">
                  <Money paise={data.totalCredit} />
                </td>
                <td className="r">
                  <Money paise={data.closing} signed />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
