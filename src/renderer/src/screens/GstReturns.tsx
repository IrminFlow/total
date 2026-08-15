import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, Money, Panel, SectionTitle, Select } from '../components/ui'
import { todayISO } from '@shared/dates'

interface MonthChoice {
  key: string // YYYY-MM
  label: string
  from: string
  to: string
  period: string // MMYYYY
}

function useMonths(): MonthChoice[] {
  const { from, to } = useSession()
  return useMemo(() => {
    const months: MonthChoice[] = []
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    let [y, m] = from.split('-').map(Number) as [number, number]
    const [ey, em] = to.split('-').map(Number) as [number, number]
    while (y < ey || (y === ey && m <= em)) {
      const mm = m.toString().padStart(2, '0')
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
      months.push({
        key: `${y}-${mm}`,
        label: `${names[m - 1]} ${y}`,
        from: `${y}-${mm}-01`,
        to: `${y}-${mm}-${lastDay}`,
        period: `${mm}${y}`
      })
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
    return months
  }, [from, to])
}

function MonthBar({ months, value, onChange }: { months: MonthChoice[]; value: string; onChange: (key: string) => void }): React.JSX.Element {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-48">
      {months.map((m) => (
        <option key={m.key} value={m.key}>
          {m.label}
        </option>
      ))}
    </Select>
  )
}

function useDefaultMonth(months: MonthChoice[]): [string, (k: string) => void] {
  const current = todayISO().slice(0, 7)
  const fallback = months.find((m) => m.key === current)?.key ?? months[months.length - 1]?.key ?? current
  const [key, setKey] = useState(fallback)
  return [months.some((m) => m.key === key) ? key : fallback, setKey]
}

export function Gstr1Screen(): React.JSX.Element {
  const months = useMonths()
  const [monthKey, setMonthKey] = useDefaultMonth(months)
  const month = months.find((m) => m.key === monthKey)!
  const { info } = useSession()
  const toast = useToasts()
  const { data } = useQuery({
    queryKey: ['gstr1', month.key],
    queryFn: () => api.gst.gstr1(month.from, month.to, month.period)
  })

  const doExport = async (): Promise<void> => {
    try {
      const r = await api.gst.exportGstr1(month.from, month.to, month.period)
      toast.push('success', `GSTR-1 JSON ready to upload — ${r.jsonPath.split('/').pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <MonthBar months={months} value={monthKey} onChange={setMonthKey} />
            <Button variant="primary" onClick={() => void doExport()} disabled={!info?.gstin}>
              Export portal JSON
            </Button>
          </div>
        }
      >
        GSTR-1 · Outward supplies
      </SectionTitle>

      {!info?.gstin && (
        <p className="mb-3 text-[12.5px] text-amber">
          Add the company GSTIN under Company details to enable portal export.
        </p>
      )}

      <Panel>
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Section</th>
              <th className="r w-16">Docs</th>
              <th className="r w-32">Taxable</th>
              <th className="r w-28">IGST</th>
              <th className="r w-28">CGST</th>
              <th className="r w-28">SGST</th>
              <th className="r w-24">Cess</th>
            </tr>
          </thead>
          <tbody>
            {(data?.summary ?? []).map((s) => (
              <tr key={s.section} className={s.docs === 0 ? 'opacity-40' : ''}>
                <td>{s.label}</td>
                <td className="r num">{s.docs}</td>
                <td className="r"><Money paise={s.taxable} /></td>
                <td className="r"><Money paise={s.igst} /></td>
                <td className="r"><Money paise={s.cgst} /></td>
                <td className="r"><Money paise={s.sgst} /></td>
                <td className="r"><Money paise={s.cess} /></td>
              </tr>
            ))}
            {data && (
              <tr className="total-row">
                <td>Total</td>
                <td className="r num">{data.summary.reduce((s, x) => s + x.docs, 0)}</td>
                <td className="r"><Money paise={data.summary.reduce((s, x) => s + x.taxable, 0)} /></td>
                <td className="r"><Money paise={data.summary.reduce((s, x) => s + x.igst, 0)} /></td>
                <td className="r"><Money paise={data.summary.reduce((s, x) => s + x.cgst, 0)} /></td>
                <td className="r"><Money paise={data.summary.reduce((s, x) => s + x.sgst, 0)} /></td>
                <td className="r"><Money paise={data.summary.reduce((s, x) => s + x.cess, 0)} /></td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
      <p className="mt-3 text-[12px] text-muted">
        The exported JSON matches the GST offline-tool schema — upload it on the portal under Returns → GSTR-1 → Prepare offline. A CSV summary lands beside it in exports/.
      </p>
    </div>
  )
}

export function Gstr3bScreen(): React.JSX.Element {
  const months = useMonths()
  const [monthKey, setMonthKey] = useDefaultMonth(months)
  const month = months.find((m) => m.key === monthKey)!
  const { info } = useSession()
  const toast = useToasts()
  const { data } = useQuery({
    queryKey: ['gstr3b', month.key],
    queryFn: () => api.gst.gstr3b(month.from, month.to, month.period)
  })

  const doExport = async (): Promise<void> => {
    try {
      const r = await api.gst.exportGstr3b(month.from, month.to, month.period)
      toast.push('success', `GSTR-3B JSON saved — ${r.jsonPath.split('/').pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const row = (label: string, v: { taxable?: number; igst: number; cgst: number; sgst: number; cess: number } | undefined): React.JSX.Element => (
    <tr>
      <td>{label}</td>
      <td className="r">{v?.taxable != null ? <Money paise={v.taxable} /> : '–'}</td>
      <td className="r"><Money paise={v?.igst ?? 0} /></td>
      <td className="r"><Money paise={v?.cgst ?? 0} /></td>
      <td className="r"><Money paise={v?.sgst ?? 0} /></td>
      <td className="r"><Money paise={v?.cess ?? 0} /></td>
    </tr>
  )

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <MonthBar months={months} value={monthKey} onChange={setMonthKey} />
            <Button variant="primary" onClick={() => void doExport()} disabled={!info?.gstin}>
              Export JSON
            </Button>
          </div>
        }
      >
        GSTR-3B · Summary return
      </SectionTitle>

      <Panel>
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Table</th>
              <th className="r w-32">Taxable</th>
              <th className="r w-28">IGST</th>
              <th className="r w-28">CGST</th>
              <th className="r w-28">SGST</th>
              <th className="r w-24">Cess</th>
            </tr>
          </thead>
          <tbody>
            {row('3.1(a) Outward taxable supplies', data?.outward)}
            {row('3.1(c) Nil-rated / exempt', data ? { taxable: data.nilExempt.taxable, igst: 0, cgst: 0, sgst: 0, cess: 0 } : undefined)}
            {row('4 Eligible ITC (all other)', data?.itc)}
            {data && (
              <tr className="total-row">
                <td>Net tax payable (cash)</td>
                <td className="r">–</td>
                <td className="r"><Money paise={data.netPayable.igst} /></td>
                <td className="r"><Money paise={data.netPayable.cgst} /></td>
                <td className="r"><Money paise={data.netPayable.sgst} /></td>
                <td className="r"><Money paise={data.netPayable.cess} /></td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
      <p className="mt-3 text-[12px] text-muted">
        Net payable assumes full ITC set-off per head. Cross-head set-off order (IGST first) is applied on the portal at payment time.
      </p>
    </div>
  )
}
