// WP 6.4 — the Compliance card's "Party tasks" row: open tasks on parties that are overdue, due
// today or due this week, from its own channel (dashboard:tasksDue) so the dashboard series stays
// untouched. Renders nothing when no task is due within the week.
import { useQuery } from '@tanstack/react-query'
import { todayISO } from '@shared/dates'
import { partyNotesApi } from '../../lib/workspaceClient'
import { useNav } from '../../state/stores'
import { Badge } from '../../components/ui'
import { drillRowProps } from '../../components/links'

export function TasksDueChip(): React.JSX.Element | null {
  const nav = useNav()
  const today = todayISO()
  const { data } = useQuery({ queryKey: ['dashboard', 'tasksDue', today], queryFn: () => partyNotesApi.tasksDue(today) })
  if (!data || data.total === 0) return null
  const now = data.overdue + data.today
  return (
    <div
      data-testid="dash-tasks-due"
      {...drillRowProps(() => nav.go({ name: 'receivables', tab: 'control' }))}
      className="flex w-full cursor-pointer items-center justify-between gap-2 border-b border-line/40 px-4 py-2 text-left hover:bg-panel2 focus-visible:bg-panel2 focus-visible:outline-none"
    >
      <span className="text-body-sm text-ink">Party tasks</span>
      <span className="flex flex-wrap gap-1">
        {now > 0 && (
          <Badge tone={data.overdue > 0 ? 'danger' : 'amber'} testId="chip-tasks-due">
            {now} due{data.overdue > 0 ? ` · ${data.overdue} overdue` : ' today'}
          </Badge>
        )}
        {data.week > 0 && <Badge tone="info" testId="chip-tasks-week">{data.week} this week</Badge>}
      </span>
    </div>
  )
}
