import { useQuery } from '@tanstack/react-query'
import { formatFc } from '@shared/forex'
import { cfApi } from '../lib/cashFinanceClient'

/** Review of #195: a ledger whose opening was entered in a foreign currency on the old Forex screen
 *  (fx_ledger_currency.opening_fc) keeps that foreign amount — nothing can change it any more. The
 *  rate is not stored (rupee opening ÷ foreign amount), so editing the rupee opening changes the
 *  implied rate; the form says so. Renders nothing
 *  for any other ledger or while the opening is unchanged. */
export function ForeignOpeningNote({ ledgerId, changed }: { ledgerId: number; changed: boolean }): React.JSX.Element | null {
  const { data } = useQuery({ queryKey: ['fxForeignOpening', ledgerId], queryFn: () => cfApi.fx.foreignOpening(ledgerId) })
  if (!data || !changed) return null
  return (
    <p className="mt-1 text-hint text-amber" data-testid="ledger-foreign-opening-note" role="note">
      Its foreign opening of {formatFc(data.openingFc, data.currencyCode)} (entered on the old Forex screen) stays fixed — Total can
      no longer change it — so the rate it implies follows this rupee opening, and so do the foreign opening bills read at that rate.
    </p>
  )
}
