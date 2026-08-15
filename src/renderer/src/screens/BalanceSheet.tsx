import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession } from '../state/stores'
import { Money, Panel, SectionTitle } from '../components/ui'
import { StatementTree } from '../components/StatementTree'
import { toDisplayDate } from '@shared/dates'

export function BalanceSheetScreen(): React.JSX.Element {
  const { to } = useSession()
  const { data } = useQuery({ queryKey: ['balanceSheet', to], queryFn: () => api.reports.balanceSheet(to) })
  if (!data) return <p className="text-muted">Loading…</p>

  const balanced = data.totalAssets === data.totalLiabilities

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle right={<span className="num text-[12px] text-muted">as on {toDisplayDate(data.asOn)}</span>}>
        Balance sheet
      </SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Liabilities</p>
          <StatementTree nodes={data.liabilities} />
          <div className="mt-2 flex justify-between border-t border-ink px-2 pt-1.5 font-semibold" style={{ borderBottom: '3px double var(--color-ink)' }}>
            <span>Total</span>
            <Money paise={data.totalLiabilities} />
          </div>
        </Panel>
        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Assets</p>
          <StatementTree nodes={data.assets} />
          <div className="mt-2 flex justify-between border-t border-ink px-2 pt-1.5 font-semibold" style={{ borderBottom: '3px double var(--color-ink)' }}>
            <span>Total</span>
            <Money paise={data.totalAssets} />
          </div>
        </Panel>
      </div>
      {!balanced && (
        <p className="mt-3 text-[12.5px] text-amber">
          The two sides differ by {<Money paise={Math.abs(data.totalAssets - data.totalLiabilities)} />} — usually an opening balance entered on one side only.
        </p>
      )}
    </div>
  )
}
