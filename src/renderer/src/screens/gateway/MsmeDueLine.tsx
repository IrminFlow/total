// Dashboard (WP 4.3, additive): "MSME due this week" under the Ageing card's payables — micro /
// small supplier dues whose MSMED Act s.15 deadline falls this week (and those already past it).
import { useQuery } from '@tanstack/react-query'
import { todayISO } from '@shared/dates'
import { formatPaise, formatPaiseCompact } from '@shared/money'
import { payablesApi } from '../../lib/payablesClient'
import { useNav } from '../../state/stores'

export function MsmeDueLine(): React.JSX.Element | null {
  const nav = useNav()
  const today = todayISO()
  const { data } = useQuery({ queryKey: ['dashboard', 'msmeDue', today], queryFn: () => payablesApi.msmeDue(today) })
  if (!data || data.dueThisWeekBills + data.overdueBills === 0) return null
  return (
    <button
      type="button"
      data-testid="dash-msme-due"
      onClick={() => nav.go({ name: 'payables', tab: 'msme' })}
      className="-mt-1 flex items-baseline justify-between rounded text-left text-caption hover:underline"
      title="Micro / small suppliers: MSMED Act s.15 deadline (15 days, or the period agreed in writing up to 45)"
    >
      <span className="text-muted">MSME due this week</span>
      <span className="num">
        <span className="text-amber" title={formatPaise(data.dueThisWeek, { symbol: true })}>
          {formatPaiseCompact(data.dueThisWeek)}
        </span>
        {data.overdue > 0 && (
          <span className="ml-2 text-cr" title={`${formatPaise(data.overdue, { symbol: true })} past the s.15 period`}>
            {formatPaiseCompact(data.overdue)} late
          </span>
        )}
      </span>
    </button>
  )
}
