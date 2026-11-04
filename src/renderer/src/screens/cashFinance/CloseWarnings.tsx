// WP 4.4 — year-end close warning for cash and finance (warn-only, additive to YearEnd.tsx):
// foreign-currency balances not revalued on 31 March.
import { useQuery } from '@tanstack/react-query'
import { fyFromStartYear, toDisplayDate } from '@shared/dates'
import { formatFc } from '@shared/forex'
import { cfApi } from '../../lib/cashFinanceClient'
import { useNav } from '../../state/stores'
import { Banner, Button } from '../../components/ui'

export function CashFinanceCloseWarnings({ fyStartYear, closed }: { fyStartYear: number; closed: boolean }): React.JSX.Element | null {
  const nav = useNav()
  const { data } = useQuery({ queryKey: ['yearEndPreview', fyStartYear, 'cashFinance'], queryFn: () => cfApi.checks.closeWarnings(fyStartYear) })
  if (!data || closed) return null
  const fy = fyFromStartYear(fyStartYear)
  return (
    <>
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
    </>
  )
}
