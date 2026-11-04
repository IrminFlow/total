import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { addDaysISO, toDisplayDate } from '@shared/dates'
import { cfApi } from '../../lib/cashFinanceClient'
import { confirmDialog } from '../../lib/dialogs'
import { useSession, useToasts } from '../../state/stores'
import { useCapabilityRefused } from '../../lib/capabilities'
import { Banner, Button } from '../../components/ui'

/** The one forex write kept after the 1.0 cleanup (review of #195): a revaluation journal posted
 *  without "Reverse it on the next day" can still be reversed — here, on that journal's view.
 *  A hand-made reversal would be counted by bill-wise ageing (NOT_FX_REVALUATION ignores only real
 *  revaluation vouchers), so Outstandings would stop agreeing with the trial balance. Shown only for
 *  a revaluation without a live reversal; the reversal is dated the next day (`fx:reverse`,
 *  audited as before; the server refuses it inside the lock or for a viewer). */
export function RevaluationReverseBanner({ voucherId }: { voucherId: number }): React.JSX.Element | null {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const role = useSession((s) => s.user?.role)
  const cannotPost = useCapabilityRefused('canPost')
  const { data } = useQuery({ queryKey: ['fxRevaluationOf', voucherId], queryFn: () => cfApi.fx.revaluationOf(voucherId) })
  // A viewer (or a sign-in the owner barred from posting) would only be refused by main.
  if (!data || data.reversed || role === 'viewer' || cannotPost) return null
  const on = addDaysISO(data.asOf, 1)
  const reverse = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Reverse the revaluation',
      message: `Post the reversal of this revaluation (as on ${toDisplayDate(data.asOf)}) on ${toDisplayDate(on)}? The two journals then go to the bin together.`,
      confirmLabel: 'Reverse'
    })
    if (!ok) return
    setBusy(true)
    try {
      await cfApi.fx.reverse(data.id)
      // A new journal: every open report / list reads it (as a voucher save does).
      await queryClient.invalidateQueries()
      toast.push('success', `Reversal posted on ${toDisplayDate(on)}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Banner
      tone="info"
      className="mb-section"
      testId="fx-revaluation-banner"
      action={<Button size="sm" disabled={busy} data-testid="btn-fx-reverse" onClick={() => void reverse()}>Reverse…</Button>}
    >
      Forex revaluation as on {toDisplayDate(data.asOf)}, not reversed yet. Reverse it here (the day after) rather than by hand, so
      bill-wise outstandings keep agreeing with the books.
    </Banner>
  )
}
