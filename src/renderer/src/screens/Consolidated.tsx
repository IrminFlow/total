import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, ScrollList, SectionTitle, SkeletonRows } from '../components/ui'
import { csvReport } from '../lib/reportExport'
import { toDisplayDate } from '@shared/dates'
import { plainRupees } from '@shared/money'

type Kind = 'tb' | 'pnl'

export function ConsolidatedScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const { data: registry } = useQuery({ queryKey: ['company-registry'], queryFn: api.company.list })
  const companies = registry?.companies ?? []

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [kind, setKind] = useState<Kind>('tb')
  const [ranOnce, setRanOnce] = useState(false)

  const slugs = useMemo(() => companies.map((c) => c.slug).filter((s) => selected.has(s)), [companies, selected])

  const { data, error, refetch, isFetching } = useQuery({
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
    // refetch() never throws — it resolves with the failure inside the result — so surface
    // the error from the query result (and it stays rendered below via `error`).
    const result = await refetch()
    if (result.error) toast.push('error', result.error.message)
  }

  const exportCsv = async (): Promise<void> => {
    if (!data) return
    const header = ['Name', 'Group', ...data.columns, 'Total']
    const rows = data.rows.map((r) => [
      r.name,
      r.group,
      ...r.perCompany.map((v) => (v == null ? '' : plainRupees(v))),
      plainRupees(r.total)
    ])
    await csvReport(header, rows, `consolidated-${kind}`, toast)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <div className="flex items-center gap-3">
            <div className="flex overflow-hidden rounded-md border border-line">
              <button
                data-testid="tab-consolidated-tb"
                className={`px-3 py-1 text-small transition-colors ${
                  kind === 'tb' ? 'bg-accentbar/20 font-medium text-ink' : 'text-muted hover:text-ink'
                }`}
                onClick={() => setKind('tb')}
              >
                Trial balance
              </button>
              <button
                data-testid="tab-consolidated-pnl"
                className={`border-l border-line px-3 py-1 text-small transition-colors ${
                  kind === 'pnl' ? 'bg-accentbar/20 font-medium text-ink' : 'text-muted hover:text-ink'
                }`}
                onClick={() => setKind('pnl')}
              >
                Profit &amp; loss
              </button>
            </div>
            <span className="num text-small text-muted">
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
          <ScrollList maxH="40vh" className="flex flex-col gap-1.5">
            {companies.map((c) => (
              <label key={c.slug} className="flex items-center gap-2 text-detail">
                <input
                  type="checkbox"
                  data-testid={`check-consolidated-${c.slug}`}
                  checked={selected.has(c.slug)}
                  onChange={() => toggle(c.slug)}
                />
                {c.name}
                <span className="num text-caption text-muted">{c.slug}</span>
              </label>
            ))}
          </ScrollList>
        )}
        <div className="mt-4 flex items-center gap-2">
          <Button data-testid="btn-consolidated-run" variant="primary" onClick={() => void run()} disabled={isFetching}>
            {isFetching ? 'Running…' : 'Run'}
          </Button>
          {data && (
            <Button data-testid="btn-consolidated-csv" onClick={() => void exportCsv()}>
              Export CSV
            </Button>
          )}
        </div>
      </Panel>

      {ranOnce && error && (
        <div className="mb-4 rounded-md border border-cr/50 bg-cr/10 px-3 py-2 text-body-sm text-cr">
          Couldn&apos;t run the consolidation: {error.message}
        </div>
      )}

      {data && data.warnings.length > 0 && (
        <div className="mb-4 rounded-md border border-accentbar/50 bg-accentbar/10 px-3 py-2 text-body-sm text-ink">
          {data.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      {isFetching && (
        <Panel>
          <SkeletonRows />
        </Panel>
      )}

      {!isFetching && ranOnce && data && (
        <Panel>
          {data.rows.length === 0 ? (
            <EmptyState title="No balances" hint="Nothing to show for the selected companies and period" />
          ) : (
            <div className="overflow-x-auto">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Group</th>
                    {data.columns.map((col) => (
                      <th scope="col" key={col} className="r w-32">
                        {col}
                      </th>
                    ))}
                    <th scope="col" className="r w-32">Total</th>
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
