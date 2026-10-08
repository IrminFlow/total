// WP 4.2 — the Compliance card's "Promised payments" row: payments customers promised for this
// week (bill follow-ups on bills still open), from its own channel (report:dashboardPromised) so
// the dashboard series stays untouched. Renders nothing when there's nothing promised or broken.
import { useQuery } from '@tanstack/react-query'
import { formatPaiseCompact, formatPaise } from '@shared/money'
import { todayISO } from '@shared/dates'
import { receivablesApi } from '../../lib/receivablesClient'
import { useNav } from '../../state/stores'
import { Badge } from '../../components/ui'
import { drillRowProps } from '../../components/links'

export function PromisedChip(): React.JSX.Element | null {
  const nav = useNav()
  const today = todayISO()
  const { data } = useQuery({ queryKey: ['dashboard', 'promised', today], queryFn: () => receivablesApi.dashboardPromised(today) })
  if (!data || (data.count === 0 && data.overdueCount === 0)) return null
  return (
    <div
      data-testid="dash-promised"
      {...drillRowProps(() => nav.go({ name: 'receivables', tab: 'control' }))}
      className="flex w-full cursor-pointer items-center justify-between gap-2 border-b border-line/40 px-4 py-2 text-left hover:bg-panel2 focus-visible:bg-panel2 focus-visible:outline-none"
    >
      <span className="text-body-sm text-ink">Promised payments</span>
      <span className="flex flex-wrap gap-1">
        {data.count > 0 && (
          <Badge tone="amber" testId="chip-promised-week">
            <span title={formatPaise(data.amount, { symbol: true })}>{data.count} this week · {formatPaiseCompact(data.amount)}</span>
          </Badge>
        )}
        {data.overdueCount > 0 && <Badge tone="danger" testId="chip-promised-broken">{data.overdueCount} broken</Badge>}
      </span>
    </div>
  )
}
