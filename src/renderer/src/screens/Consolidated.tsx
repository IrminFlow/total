import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle } from '../components/ui'
import { toDisplayDate } from '@shared/dates'

type Kind = 'tb' | 'pnl'

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function ConsolidatedScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const { data: registry } = useQuery({ queryKey: ['company-registry'], queryFn: api.company.list })
  const companies = registry?.companies ?? []

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [kind, setKind] = useState<Kind>('tb')
  const [ranOnce, setRanOnce] = useState(false)

  const slugs = useMemo(() => companies.map((c) => c.slug).filter((s) => selected.has(s)), [companies, selected])

  const { data, refetch, isFetching } = useQuery({
    queryKey: ['consolidated', slugs, kind, from, to],
    queryFn: () => api.consolidated.run(slugs, kind, from, to),
    enabled: false
  })

  const toggle = (slug: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  const run = async (): Promise<void> => {
    if (slugs.length === 0) {
      toast.push('error', 'Select at least one company')
      return
    }
    setRanOnce(true)
    try {
      await refetch()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  // export:csv (Task 3.6) doesn't exist yet — build the CSV in the renderer and copy it
  // to the clipboard so the user can paste straight into a spreadsheet.
  const copyCsv = async (): Promise<void> => {
    if (!data) return
    const header = ['Name', 'Group', ...data.columns, 'Total']
    const rows = data.rows.map((r) => [
      r.name,
      r.group,
      ...r.perCompany.map((v) => (v == null ? '' : (v / 100).toFixed(2))),
      (r.total / 100).toFixed(2)
    ])
    const csv = [header, ...rows].map((cells) => cells.map(csvCell).join(',')).join('\n')
    try {
      await navigator.clipboard.writeText(csv)
      toast.push('success', 'CSV copied — paste into a spreadsheet')
    } catch {
      toast.push('error', 'Could not copy to clipboard')
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-3">
            <div className="flex overflow-hidden rounded-md border border-line">
              <button
                className={`px-3 py-1 text-[12px] transition-colors ${
                  kind === 'tb' ? 'bg-amberbar/20 font-medium text-ink' : 'text-muted hover:text-ink'
                }`}
                onClick={() => setKind('tb')}
              >
                Trial balance
              </button>
              <button
                className={`border-l border-line px-3 py-1 text-[12px] transition-colors ${
                  kind === 'pnl' ? 'bg-amberbar/20 font-medium text-ink' : 'text-muted hover:text-ink'
                }`}
                onClick={() => setKind('pnl')}
              >
                Profit &amp; loss
              </button>
            </div>
            <span className="num text-[12px] text-muted">
              {toDisplayDate(from)} → {toDisplayDate(to)}
            </span>
          </div>
        }
      >
        Consolidated reports
      </SectionTitle>

      <Panel className="mb-4">
        {companies.length === 0 ? (
          <EmptyState title="No companies yet" hint="Create at least one company to consolidate" />
        ) : (
          <div className="flex flex-col gap-1.5">
            {companies.map((c) => (
              <label key={c.slug} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={selected.has(c.slug)} onChange={() => toggle(c.slug)} />
                {c.name}
                <span className="num text-[11px] text-muted">{c.slug}</span>
              </label>
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" onClick={() => void run()} disabled={isFetching}>
            {isFetching ? 'Running…' : 'Run'}
          </Button>
          {data && <Button onClick={() => void copyCsv()}>Copy CSV</Button>}
        </div>
      </Panel>

      {data && data.warnings.length > 0 && (
        <div className="mb-4 rounded-md border border-amberbar/50 bg-amberbar/10 px-3 py-2 text-[12.5px] text-ink">
          {data.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

      {ranOnce && data && (
        <Panel>
          {data.rows.length === 0 ? (
            <EmptyState title="No balances" hint="Nothing to show for the selected companies and period" />
          ) : (
            <div className="overflow-x-auto">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Group</th>
                    {data.columns.map((col) => (
                      <th key={col} className="r w-32">
                        {col}
                      </th>
                    ))}
                    <th className="r w-32">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td className="text-muted">{r.group}</td>
                      {r.perCompany.map((v, i) => (
                        <td key={data.columns[i]} className="r">
                          {v == null ? <span className="text-muted">—</span> : <Money paise={v} signed />}
                        </td>
                      ))}
                      <td className="r">
                        <Money paise={r.total} signed />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}
