import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, Select } from '../components/ui'
import { useLedgers } from '../components/pickers'
import { fyOf, fyFromStartYear, todayISO } from '@shared/dates'
import { tdsQuarterOf } from '@shared/tds'

const QUARTERS = [1, 2, 3, 4] as const

export function TdsScreen(): React.JSX.Element {
  const { info } = useSession()
  const toast = useToasts()
  const ledgers = useLedgers()
  const currentFy = fyOf(todayISO())
  const [fyStartYear, setFyStartYear] = useState(currentFy.startYear)
  const [quarter, setQuarter] = useState<1 | 2 | 3 | 4>(tdsQuarterOf(todayISO()).q)

  const years: number[] = []
  for (let y = currentFy.startYear; y >= (info?.booksFrom ?? currentFy.startYear); y--) years.push(y)
  const fy = fyFromStartYear(fyStartYear)

  const { data: summary } = useQuery({
    queryKey: ['tdsSummary', fyStartYear],
    queryFn: () => api.tds.summary(fyStartYear)
  })

  // The summary endpoint aggregates section × quarter (deductee count, not per-deductee rows) —
  // there's no per-deductee/PAN breakdown API yet, so the missing-PAN warning surfaces at the
  // ledger-master level instead of per transaction row.
  const flaggedNoPan = useMemo(() => ledgers.filter((l) => l.tdsSectionId != null && !l.pan), [ledgers])

  const qLabel = `Q${quarter} FY${fy.label}`
  const rows = (summary ?? []).filter((r) => r.quarter === qLabel)
  const totals = rows.reduce(
    (acc, r) => ({ deductees: acc.deductees + r.deductees, base: acc.base + r.base, tds: acc.tds + r.tds }),
    { deductees: 0, base: 0, tds: 0 }
  )

  const doExport = async (): Promise<void> => {
    try {
      const r = await api.tds.export26q(fyStartYear, quarter)
      toast.push('success', `26Q CSV ready (${r.path.split('/').pop()}) — import into NSDL's RPU manually, this is not a filed FVU`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <Select value={fyStartYear} onChange={(e) => setFyStartYear(Number(e.target.value))} className="w-36">
              {years.map((y) => (
                <option key={y} value={y}>
                  FY {fyFromStartYear(y).label}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => void doExport()}>
              Export 26Q CSV
            </Button>
          </div>
        }
      >
        TDS
      </SectionTitle>

      <div className="mb-3 flex gap-1">
        {QUARTERS.map((q) => (
          <button
            key={q}
            onClick={() => setQuarter(q)}
            className={`rounded-md px-3 py-1 text-[12.5px] ${
              quarter === q ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'
            }`}
          >
            Q{q}
          </button>
        ))}
      </div>

      {flaggedNoPan.length > 0 && (
        <div className="mb-3 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-[12.5px] text-amber">
          {flaggedNoPan.length} part{flaggedNoPan.length > 1 ? 'ies' : 'y'} flagged for TDS with no PAN on file — the
          higher 20% rate applies: {flaggedNoPan.map((l) => l.name).join(', ')}
        </div>
      )}

      <Panel>
        {rows.length === 0 ? (
          <EmptyState title={`No TDS deductions in ${qLabel}`} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Section</th>
                <th className="r w-32">Deductees</th>
                <th className="r w-36">Base</th>
                <th className="r w-36">TDS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sectionCode}>
                  <td className="num">{r.sectionCode}</td>
                  <td className="r num">{r.deductees}</td>
                  <td className="r"><Money paise={r.base} /></td>
                  <td className="r"><Money paise={r.tds} /></td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="r num">{totals.deductees}</td>
                <td className="r"><Money paise={totals.base} /></td>
                <td className="r"><Money paise={totals.tds} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-[11.5px] text-muted">
        {qLabel} · The 26Q CSV lists deductee, PAN, section, voucher and amounts for manual import into NSDL's Return
        Preparation Utility — it is not a ready-to-file FVU.
      </p>
    </div>
  )
}
