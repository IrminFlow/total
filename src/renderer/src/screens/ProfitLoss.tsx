import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession } from '../state/stores'
import { Money, Panel, SectionTitle } from '../components/ui'
import { StatementTree } from '../components/StatementTree'
import { toDisplayDate } from '@shared/dates'

export function ProfitLossScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const { data } = useQuery({ queryKey: ['pnl', from, to], queryFn: () => api.reports.profitLoss(from, to) })
  if (!data) return <p className="text-muted">Loading…</p>

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <span className="num text-[12px] text-muted">
            {toDisplayDate(from)} → {toDisplayDate(to)}
          </span>
        }
      >
        Profit &amp; Loss
      </SectionTitle>

      <div className="grid grid-cols-2 gap-3">
        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Expenses</p>
          {data.openingStock !== 0 && <FlatRow name="Opening stock" paise={data.openingStock} />}
          <StatementTree nodes={data.tradingExpenses} />
          {data.grossProfit > 0 && <FlatRow name="Gross profit c/o" paise={data.grossProfit} strong />}
          <div className="my-2 border-t border-line" />
          <StatementTree nodes={data.indirectExpenses} />
          {data.netProfit > 0 && <FlatRow name="Net profit" paise={data.netProfit} strong tone="dr" />}
        </Panel>

        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Incomes</p>
          <StatementTree nodes={data.tradingIncomes} />
          {data.closingStock !== 0 && <FlatRow name="Closing stock" paise={data.closingStock} />}
          {data.grossProfit < 0 && <FlatRow name="Gross loss c/o" paise={-data.grossProfit} strong />}
          <div className="my-2 border-t border-line" />
          <StatementTree nodes={data.indirectIncomes} />
          {data.grossProfit > 0 && <FlatRow name="Gross profit b/f" paise={data.grossProfit} />}
          {data.netProfit < 0 && <FlatRow name="Net loss" paise={-data.netProfit} strong tone="cr" />}
        </Panel>
      </div>

      <Panel className="mt-3 flex items-center justify-between px-5 py-3">
        <span className="text-[13.5px] font-medium">{data.netProfit >= 0 ? 'Net profit for the period' : 'Net loss for the period'}</span>
        <Money paise={Math.abs(data.netProfit)} className={`text-[16px] font-semibold ${data.netProfit >= 0 ? 'text-dr' : 'text-cr'}`} />
      </Panel>
    </div>
  )
}

function FlatRow({ name, paise, strong, tone }: { name: string; paise: number; strong?: boolean; tone?: 'dr' | 'cr' }): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between px-2 py-1 ${strong ? 'font-medium' : ''}`}>
      <span className={`text-[13px] ${tone === 'dr' ? 'text-dr' : tone === 'cr' ? 'text-cr' : ''}`}>{name}</span>
      <Money paise={paise} className="text-[13px]" />
    </div>
  )
}
