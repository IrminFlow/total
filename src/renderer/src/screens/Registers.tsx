import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle } from '../components/ui'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[m - 1]} ${y}`
}

export function RegistersScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const [kind, setKind] = useState<'sales' | 'purchase'>('sales')
  const [busy, setBusy] = useState<'caPack' | 'tallyXml' | null>(null)
  const { data } = useQuery({
    queryKey: ['register', kind, from, to],
    queryFn: () => api.analysis.register(kind, from, to)
  })
  const rows = data ?? []

  const runExport = async (which: 'caPack' | 'tallyXml'): Promise<void> => {
    setBusy(which)
    try {
      const r = which === 'caPack' ? await api.exporter.caPack(from, to) : await api.exporter.tallyXml(from, to)
      toast.push('success', `Saved to ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {(['sales', 'purchase'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`rounded-md px-3 py-1 text-[12.5px] capitalize ${kind === k ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'}`}
                >
                  {k}
                </button>
              ))}
            </div>
            <Button disabled={busy !== null} onClick={() => void runExport('tallyXml')}>
              Tally XML
            </Button>
            <Button variant="primary" disabled={busy !== null} onClick={() => void runExport('caPack')}>
              CA pack…
            </Button>
          </div>
        }
      >
        {kind === 'sales' ? 'Sales register' : 'Purchase register'}
      </SectionTitle>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title={`No ${kind} vouchers in this period`} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="r w-24">Vouchers</th>
                <th className="r w-40">Taxable value</th>
                <th className="r w-36">GST</th>
                <th className="r w-40">Invoice total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month}>
                  <td>{monthLabel(r.month)}</td>
                  <td className="r num">{r.vouchers}</td>
                  <td className="r"><Money paise={r.taxable} /></td>
                  <td className="r"><Money paise={r.tax} /></td>
                  <td className="r"><Money paise={r.total} /></td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="r num">{rows.reduce((s, r) => s + r.vouchers, 0)}</td>
                <td className="r"><Money paise={rows.reduce((s, r) => s + r.taxable, 0)} /></td>
                <td className="r"><Money paise={rows.reduce((s, r) => s + r.tax, 0)} /></td>
                <td className="r"><Money paise={rows.reduce((s, r) => s + r.total, 0)} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
