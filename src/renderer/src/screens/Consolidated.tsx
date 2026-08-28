import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Field, Money, Panel, ScrollList, SectionTitle, SkeletonRows, TextInput } from '../components/ui'
import { csvReport } from '../lib/reportExport'
import { toDisplayDate } from '@shared/dates'
import { plainRupees } from '@shared/money'
import { ReportToolbar } from '../components/ReportToolbar'
import { TabBar } from '../components/TabBar'

type Kind = 'tb' | 'pnl'

export function ConsolidatedScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const { data: registry } = useQuery({ queryKey: ['company-registry'], queryFn: api.company.list })
  const companies = registry?.companies ?? []

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [kind, setKind] = useState<Kind>('tb')
  const [ranOnce, setRanOnce] = useState(false)
  const [translationRates,setTranslationRates]=useState<Record<string,number>>({})
  const [eliminations,setEliminations]=useState<{name:string;group:string;amount:number;reason:string}[]>([])
  const [elimName,setElimName]=useState('');const [elimGroup,setElimGroup]=useState('Inter-company');const [elimAmount,setElimAmount]=useState('');const [elimReason,setElimReason]=useState('')

  const slugs = useMemo(() => companies.map((c) => c.slug).filter((s) => selected.has(s)), [companies, selected])

  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ['consolidated', slugs, kind, from, to,translationRates,eliminations],
    queryFn: () => api.consolidated.run(slugs, kind, from, to,translationRates,eliminations),
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
    <div className="mx-auto max-w-5xl">
      <SectionTitle>Consolidated reports</SectionTitle>
      <ReportToolbar
        ariaLabel="Consolidated report controls"
        className="mb-4"
        status={`${slugs.length} ${slugs.length === 1 ? 'company' : 'companies'} selected`}
        period={
          <span className="num text-[12px] text-muted">
            {toDisplayDate(from)} to {toDisplayDate(to)}
          </span>
        }
        view={
          <TabBar
            screen="consolidated"
            tabs={[
              { id: 'tb', label: 'Trial balance' },
              { id: 'pnl', label: 'Profit & loss' },
            ]}
            active={kind}
            onSelect={setKind}
          />
        }
        actions={
          data ? (
            <Button data-testid="btn-consolidated-csv" onClick={() => void exportCsv()}>
              Export CSV
            </Button>
          ) : null
        }
      />

      <Panel className="mb-4">
        {companies.length === 0 ? (
          <EmptyState title="No companies yet" hint="Create at least one company to consolidate" />
        ) : (
          <ScrollList maxH="40vh" className="flex flex-col gap-1.5">
            {companies.map((c) => (
              <div key={c.slug} className="grid grid-cols-[1fr_150px] items-center gap-3 text-[13px]"><label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid={`check-consolidated-${c.slug}`}
                  checked={selected.has(c.slug)}
                  onChange={() => toggle(c.slug)}
                />
                {c.name}
                <span className="num text-[11px] text-muted">{c.slug}</span>
              </label>{selected.has(c.slug)&&<Field label="Translation rate"><TextInput data-testid={`input-consolidated-rate-${c.slug}`} type="number" min="0.000001" step="0.0001" value={translationRates[c.slug]??1} onChange={(e)=>setTranslationRates((prev)=>({...prev,[c.slug]:Number(e.target.value)||1}))}/></Field>}</div>
            ))}
          </ScrollList>
        )}
        <div className="mt-4 border-t border-line pt-3"><p className="mb-2 text-[11px] font-semibold">Reviewed eliminations</p><div className="grid grid-cols-[1fr_150px_150px_1fr_auto] items-end gap-2"><Field label="Line name"><TextInput value={elimName} onChange={(e)=>setElimName(e.target.value)}/></Field><Field label="Group"><TextInput value={elimGroup} onChange={(e)=>setElimGroup(e.target.value)}/></Field><Field label="Signed ₹ adjustment"><TextInput type="number" value={elimAmount} onChange={(e)=>setElimAmount(e.target.value)}/></Field><Field label="Reason"><TextInput value={elimReason} onChange={(e)=>setElimReason(e.target.value)}/></Field><Button disabled={!elimName.trim()||!elimReason.trim()||!elimAmount} onClick={()=>{setEliminations((prev)=>[...prev,{name:elimName.trim(),group:elimGroup.trim()||'Inter-company',amount:Math.round(Number(elimAmount)*100),reason:elimReason.trim()}]);setElimName('');setElimAmount('');setElimReason('')}}>Add</Button></div>{eliminations.map((row,index)=><div key={`${row.name}-${index}`} className="mt-2 flex items-center justify-between rounded border border-line px-3 py-2 text-[10.5px]"><span><b>{row.name}</b> · {row.reason}</span><span className="flex items-center gap-3"><Money paise={row.amount} signed/><button className="text-cr" onClick={()=>setEliminations((prev)=>prev.filter((_,i)=>i!==index))}>Remove</button></span></div>)}</div>
        <div className="mt-4 flex items-center gap-2">
          <Button data-testid="btn-consolidated-run" variant="primary" onClick={() => void run()} disabled={isFetching}>
            {isFetching ? 'Running…' : 'Run'}
          </Button>
        </div>
      </Panel>

      {ranOnce && error && (
        <div className="mb-4 rounded-md border border-cr/50 bg-cr/10 px-3 py-2 text-[12.5px] text-cr">
          Couldn&apos;t run the consolidation: {error.message}
        </div>
      )}

      {data && data.warnings.length > 0 && (
        <div className="mb-4 rounded-md border border-amberbar/50 bg-amberbar/10 px-3 py-2 text-[12.5px] text-ink">
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
          {(data.eliminationCount??0)>0&&<p className="mb-3 text-[10.5px] text-muted">Includes {data.eliminationCount} reviewed elimination entr{data.eliminationCount===1?'y':'ies'} in a separate column. Translation rates are retained in the export context.</p>}
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
                          {v == null ? <span className="text-muted">-</span> : <Money paise={v} signed />}
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
