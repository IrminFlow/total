// WP 4.4 — year-end close warnings for cash and finance (warn-only, additive to YearEnd.tsx):
// EMIs due in the year but not posted, foreign-currency balances not revalued on 31 March, and
// budget lines (department / cost-centre lines first) over budget for the year.
import { useQuery } from '@tanstack/react-query'
import { fyFromStartYear, toDisplayDate } from '@shared/dates'
import { formatFc } from '@shared/forex'
import { cfApi } from '../../lib/cashFinanceClient'
import { useNav } from '../../state/stores'
import { Banner, Button, Money } from '../../components/ui'

export function CashFinanceCloseWarnings({ fyStartYear, closed }: { fyStartYear: number; closed: boolean }): React.JSX.Element | null {
  const nav = useNav()
  const { data } = useQuery({ queryKey: ['yearEndPreview', fyStartYear, 'cashFinance'], queryFn: () => cfApi.checks.closeWarnings(fyStartYear) })
  if (!data || closed) return null
  const fy = fyFromStartYear(fyStartYear)
  return (
    <>
      {data.unpostedEmis.length > 0 && (
        <Banner
          tone="warning"
          className="mb-section"
          testId="year-end-unposted-emis"
          title={`Loan instalments due in FY ${fy.label} are not posted`}
          action={<Button size="sm" onClick={() => nav.go({ name: 'loans' })}>Open loans</Button>}
        >
          {data.unpostedEmis.map((e) => (
            <span key={e.loanId} className="mr-3 inline-block">
              {e.loanName}: {e.count} instalment{e.count === 1 ? '' : 's'}, <Money paise={e.amount} />
            </span>
          ))}
          The year’s interest and the loan balance are understated until they are posted.
        </Banner>
      )}
      {data.unrevalued.length > 0 && (
        <Banner
          tone="warning"
          className="mb-section"
          testId="year-end-unrevalued"
          title={`Foreign-currency balances not revalued on ${toDisplayDate(fy.to)}`}
          action={<Button size="sm" onClick={() => nav.go({ name: 'forex' })}>Open forex</Button>}
        >
          {data.unrevalued.map((u) => (
            <span key={u.currencyCode} className="mr-3 inline-block">
              {formatFc(u.fcBalance, u.currencyCode)} on {u.ledgers} ledger{u.ledgers === 1 ? '' : 's'}
            </span>
          ))}
          Monetary items should be restated at the closing rate (AS 11 / Ind AS 21).
        </Banner>
      )}
      {data.overBudget.length > 0 && (
        <Banner
          tone="info"
          className="mb-section"
          testId="year-end-over-budget"
          title={`${data.overBudget.length} budget line${data.overBudget.length === 1 ? ' is' : 's are'} over budget for the year`}
          action={<Button size="sm" onClick={() => nav.go({ name: 'budgets' })}>Open budgets</Button>}
        >
          {data.overBudget.slice(0, 5).map((o) => (
            <span key={`${o.budgetId}-${o.lineId}`} className="mr-3 inline-block">
              {o.costCentreName ? `${o.costCentreName} · ` : ''}{o.targetName}: <Money paise={o.actual} /> against <Money paise={o.budget} />
            </span>
          ))}
        </Banner>
      )}
    </>
  )
}
