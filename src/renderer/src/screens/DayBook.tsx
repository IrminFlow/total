import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { EmptyState, Money, Panel, SectionTitle, TextInput, useKeyNav } from '../components/ui'
import { toDisplayDate } from '@shared/dates'

export function DayBook(): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const [filter, setFilter] = useState('')
  const { data } = useQuery({
    queryKey: ['daybook', from, to],
    queryFn: () => api.reports.dayBook(from, to)
  })

  const rows = useMemo(() => {
    const all = data ?? []
    const q = filter.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (r) =>
        r.account.toLowerCase().includes(q) ||
        r.voucherType.toLowerCase().includes(q) ||
        r.number.toLowerCase().includes(q) ||
        (r.narration ?? '').toLowerCase().includes(q)
    )
  }, [data, filter])

  const { active, setActive } = useKeyNav(rows.length, (i) => {
    const r = rows[i]
    if (r) nav.go({ name: 'voucher-entry', voucherId: r.voucherId })
  })

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={<TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to filter…" className="w-64" />}
      >
        Day book
      </SectionTitle>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No entries in this period" hint="Press V for voucher entry" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-24">Date</th>
                <th className="w-28">Type</th>
                <th className="w-20">No.</th>
                <th>Account</th>
                <th>Narration</th>
                <th className="r w-36">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.voucherId}`}
                  data-active={i === active}
                  className="kbar-row cursor-pointer"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
                >
                  <td className="num text-muted">{toDisplayDate(r.date)}</td>
                  <td className="text-muted">{r.voucherType}</td>
                  <td className="num text-muted">{r.number}</td>
                  <td>{r.account}</td>
                  <td className="max-w-56 truncate text-muted">{r.narration}</td>
                  <td className="r">
                    <Money paise={r.debit} />
                    {r.voucherType === 'Sales' && (
                      <button
                        className="ml-2 text-[11.5px] text-blue hover:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          void api.invoice.pdf(r.voucherId)
                        }}
                        title="Invoice PDF"
                      >
                        PDF
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={5}>Total · {rows.length} vouchers</td>
                <td className="r">
                  <Money paise={rows.reduce((s, r) => s + r.debit, 0)} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
