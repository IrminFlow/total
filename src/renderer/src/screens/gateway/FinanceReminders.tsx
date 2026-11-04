// WP 4.4 — rows the Gateway's compliance card adds for cash and finance: loan EMIs due within a
// week (or overdue, not yet posted). Self-fetching and additive, so the card itself only gains
// one line.
import { useQuery } from '@tanstack/react-query'
import { formatPaise } from '@shared/money'
import { todayISO } from '@shared/dates'
import { cfApi } from '../../lib/cashFinanceClient'
import { useNav } from '../../state/stores'
import { Badge } from '../../components/ui'
import { drillRowProps } from '../../components/links'

const rowCls =
  'flex w-full cursor-pointer flex-col gap-1 border-b border-line/40 px-4 py-2 text-left hover:bg-panel2 focus-visible:bg-panel2 focus-visible:outline-none'

function dueText(date: string, today: string): string {
  const d = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000)
  return d < 0 ? `${-d} day${d === -1 ? '' : 's'} overdue` : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`
}

export function FinanceReminderRows(): React.JSX.Element | null {
  const nav = useNav()
  const today = todayISO()
  const { data } = useQuery({ queryKey: ['dashboard', 'financeReminders', today], queryFn: cfApi.checks.reminders })
  if (!data || data.emis.length === 0) return null
  return (
    <>
      {data.emis.length > 0 && (
        <div data-testid="dash-emis" {...drillRowProps(() => nav.go({ name: 'loans', loanId: data.emis[0]!.loanId }))} className={rowCls}>
          <span className="text-body-sm text-ink">Loan EMIs</span>
          <span className="flex flex-col gap-0.5">
            {data.emis.slice(0, 3).map((e) => (
              <span key={e.scheduleId} className="flex items-center justify-between gap-2 text-caption">
                <span className="min-w-0 truncate">{e.loanName}</span>
                <span className="flex items-center gap-2">
                  <span className="num text-ink">{formatPaise(e.payment)}</span>
                  <Badge tone={e.overdue ? 'danger' : 'amber'} testId="chip-emi">{dueText(e.dueDate, today)}</Badge>
                </span>
              </span>
            ))}
            {data.emis.length > 3 && <span className="text-caption text-muted">+{data.emis.length - 3} more</span>}
          </span>
        </div>
      )}
    </>
  )
}
