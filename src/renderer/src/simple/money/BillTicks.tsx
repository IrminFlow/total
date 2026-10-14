import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import type { MoneyOpenBill } from '@shared/simple/money'
import { useT } from '../../lib/i18n'
import { FieldError } from '../../components/ui'

/**
 * WP 9.4 — a customer's / supplier's open bills, oldest first (the Outstandings allocation as on
 * the entry's date), with the ones the amount pays ticked: untouched = oldest first (what
 * simple:post does by itself), a tick or untick makes it the user's list. What each bill gets
 * and what is left over come from shared/simple/money.ts `billAllocation` (the same allocation
 * simple:post runs). Below: "Is this for a bill you haven't made yet?" (the advance answer).
 */
export function BillTicks({
  side,
  bills,
  ticked,
  gets,
  leftOver,
  advance,
  showAdvance,
  error,
  onToggle,
  onAdvance
}: {
  side: 'in' | 'out'
  bills: MoneyOpenBill[]
  /** Bill names shown ticked. */
  ticked: readonly string[]
  /** What each ticked bill gets from this amount. */
  gets: ReadonlyMap<string, number>
  /** What the bills don't take (paise). */
  leftOver: number
  advance: boolean
  showAdvance: boolean
  error: string | null
  onToggle: (name: string, on: boolean) => void
  onAdvance: (on: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const money = (p: number): string => formatPaise(p, { symbol: true })
  return (
    <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={side === 'in' ? t('simple.money.billsIn') : t('simple.money.billsOut')} data-testid="money-bills">
      <h2 className="mb-1 text-subtitle font-semibold text-ink">{side === 'in' ? t('simple.money.billsIn') : t('simple.money.billsOut')}</h2>
      {bills.length === 0 ? (
        <p className="text-detail text-muted" data-testid="money-no-bills">{t('simple.money.noBills')}</p>
      ) : (
        <>
          <p className="mb-2 text-small text-muted">{t('simple.money.billsHint')}</p>
          <ul className="divide-y divide-line" data-testid="money-bill-list">
            {bills.map((b, i) => {
              const on = ticked.includes(b.name)
              const got = gets.get(b.name)
              return (
                <li key={`${b.name}-${i}`} className="flex items-center gap-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => onToggle(b.name, e.target.checked)}
                    data-testid={`money-bill-${i}`}
                    data-bill={b.name}
                    aria-label={t('simple.money.billName', { bill: b.name })}
                    className="h-4 w-4 accent-amber"
                  />
                  <span className="min-w-0 flex-1 text-body text-ink">
                    {t('simple.money.billName', { bill: b.name })}{' '}
                    <span className="text-small text-muted">
                      {t('simple.money.billDated', { date: toPlainDate(b.date) })}
                      {b.overdueDays > 0 && ` · ${t('simple.money.billOverdue', { days: b.overdueDays })}`}
                    </span>
                  </span>
                  <span className="num text-detail text-muted">{t('simple.money.billDue', { amount: money(b.pending) })}</span>
                  <span className="num w-32 text-right text-detail font-medium text-ink" data-testid={`money-bill-gets-${i}`} data-paise={got ?? 0}>
                    {got ? t('simple.money.billGets', { amount: money(got) }) : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {leftOver > 0 && bills.length > 0 && (
        <p className="mt-2 text-detail text-ink" data-testid="money-left-over">
          {t('simple.money.leftOver', { amount: money(leftOver) })}
        </p>
      )}
      <FieldError name="bills" error={error} />
      {showAdvance && (
        <div className="mt-3 border-t border-line pt-3" data-testid="money-advance">
          <p className="mb-2 text-body text-ink">{side === 'in' ? t('simple.money.advanceIn') : t('simple.money.advanceOut')}</p>
          <div role="radiogroup" aria-label={side === 'in' ? t('simple.money.advanceIn') : t('simple.money.advanceOut')} className="flex flex-wrap gap-2">
            {[true, false].map((v) => (
              <button
                key={String(v)}
                type="button"
                role="radio"
                aria-checked={advance === v}
                data-testid={`money-advance-${v ? 'yes' : 'no'}`}
                onClick={() => onAdvance(v)}
                className={`rounded-md border px-3 py-1 text-detail ${advance === v ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'}`}
              >
                {v ? t('simple.money.advanceYes') : t('simple.money.advanceNo')}
              </button>
            ))}
          </div>
          {!advance && <p className="mt-1 text-small text-muted">{t('simple.money.advanceHint')}</p>}
        </div>
      )}
    </section>
  )
}
