import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { EmptyState, Money, Panel, SectionTitle, useKeyNav } from '../components/ui'
import { toDisplayDate } from '@shared/dates'

export function TrialBalanceScreen(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const { data } = useQuery({ queryKey: ['trialBalance', to], queryFn: () => api.reports.trialBalance(to) })
  const rows = data?.rows ?? []
  const { active, setActive } = useKeyNav(rows.length, (i) => {
    const r = rows[i]
    if (r && r.ledgerId > 0) nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })
  })

  const matched = data && data.totalDebit === data.totalCredit

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle right={<span className="num text-[12px] text-muted">as on {toDisplayDate(to)}</span>}>
        Trial balance
      </SectionTitle>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No balances yet" hint="Enter a voucher or set opening balances" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Ledger</th>
                <th>Group</th>
                <th className="r w-40">Debit</th>
                <th className="r w-40">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.ledgerId}
                  data-active={i === active}
                  className="kbar-row cursor-pointer"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => r.ledgerId > 0 && nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
                >
                  <td>{r.ledgerName}</td>
                  <td className="text-muted">{r.groupName}</td>
                  <td className="r">
                    <Money paise={r.debit} />
                  </td>
                  <td className="r">
                    <Money paise={r.credit} />
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={2}>Total {matched ? '' : '— debits and credits differ; check opening balances'}</td>
                <td className="r">
                  <Money paise={data?.totalDebit ?? 0} />
                </td>
                <td className="r">
                  <Money paise={data?.totalCredit ?? 0} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
