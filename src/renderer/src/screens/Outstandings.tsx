import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { EmptyState, Money, Panel, SectionTitle } from '../components/ui'
import { toDisplayDate } from '@shared/dates'

export function OutstandingsScreen(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const [side, setSide] = useState<'receivable' | 'payable'>('receivable')
  const [openParty, setOpenParty] = useState<number | null>(null)
  const { data } = useQuery({
    queryKey: ['outstandings', side, to],
    queryFn: () => api.analysis.outstandings(side, to)
  })
  const parties = data ?? []
  const total = parties.reduce((s, p) => s + p.pending, 0)
  const bucketTotals = [0, 1, 2, 3].map((i) => parties.reduce((s, p) => s + p.buckets[i as 0 | 1 | 2 | 3], 0))

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex gap-1">
            {(['receivable', 'payable'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={`rounded-md px-3 py-1 text-[12.5px] capitalize ${side === s ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'}`}
              >
                {s}s
              </button>
            ))}
          </div>
        }
      >
        {side === 'receivable' ? 'Receivables' : 'Payables'} · ageing
      </SectionTitle>
      <Panel>
        {parties.length === 0 ? (
          <EmptyState title={`Nothing ${side === 'receivable' ? 'to collect' : 'to pay'} as on ${toDisplayDate(to)}`} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Party</th>
                <th className="r w-32">0–30 d</th>
                <th className="r w-32">31–60 d</th>
                <th className="r w-32">61–90 d</th>
                <th className="r w-32">90+ d</th>
                <th className="r w-36">Pending</th>
              </tr>
            </thead>
            <tbody>
              {parties.map((p) => (
                <>
                  <tr
                    key={p.ledgerId}
                    className="cursor-pointer"
                    onClick={() => setOpenParty(openParty === p.ledgerId ? null : p.ledgerId)}
                  >
                    <td>
                      <span className="mr-1.5 inline-block w-3 text-[10px] text-muted">{openParty === p.ledgerId ? '▾' : '▸'}</span>
                      {p.name}
                    </td>
                    <td className="r"><Money paise={p.buckets[0]} /></td>
                    <td className="r"><Money paise={p.buckets[1]} /></td>
                    <td className="r"><Money paise={p.buckets[2]} /></td>
                    <td className="r"><span className={p.buckets[3] > 0 ? 'text-cr' : ''}><Money paise={p.buckets[3]} /></span></td>
                    <td className="r font-medium"><Money paise={p.pending} /></td>
                  </tr>
                  {openParty === p.ledgerId &&
                    p.bills.map((b, i) => (
                      <tr key={`${p.ledgerId}-${i}`} className="bg-panel2/50">
                        <td className="pl-9 text-muted">
                          <button
                            className="hover:text-blue hover:underline"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (b.voucherId) nav.go({ name: 'voucher-entry', voucherId: b.voucherId })
                            }}
                          >
                            {b.number}
                          </button>
                          <span className="num ml-3 text-[11.5px]">{toDisplayDate(b.date)} · {b.ageDays} days</span>
                        </td>
                        <td colSpan={4}></td>
                        <td className="r text-muted"><Money paise={b.pending} /></td>
                      </tr>
                    ))}
                </>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="r"><Money paise={bucketTotals[0]!} /></td>
                <td className="r"><Money paise={bucketTotals[1]!} /></td>
                <td className="r"><Money paise={bucketTotals[2]!} /></td>
                <td className="r"><Money paise={bucketTotals[3]!} /></td>
                <td className="r"><Money paise={total} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-[11.5px] text-muted">
        Receipts settle the oldest bills first. Click a party to see its open bills; click a bill number to open the voucher.
      </p>
    </div>
  )
}
