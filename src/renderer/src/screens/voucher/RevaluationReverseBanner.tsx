import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { addDaysISO, toDisplayDate } from '@shared/dates'
import { api } from '../../lib/client'
import { cfApi } from '../../lib/cashFinanceClient'
import { confirmDialog } from '../../lib/dialogs'
import { useSession, useToasts } from '../../state/stores'
import { useCapabilityRefused } from '../../lib/capabilities'
import { Banner, Button, DateInput } from '../../components/ui'

/** The reversal's default date: the day after the revaluation, or — when the books are locked up
 *  to or past that day — the first day after the lock (a locked date would only be refused). */
export function defaultReversalDate(asOf: string, lock: string | null | undefined): string {
  const dayAfter = addDaysISO(asOf, 1)
  return lock && lock >= dayAfter ? addDaysISO(lock, 1) : dayAfter
}

/** The one forex write kept after the 1.0 cleanup (review of #195): a revaluation journal posted
 *  without "Reverse it on the next day" can still be reversed — here, on that journal's view.
 *  A hand-made reversal would be counted by bill-wise ageing (NOT_FX_REVALUATION ignores only real
 *  revaluation vouchers), so Outstandings would stop agreeing with the trial balance. Shown only for
 *  a live revaluation without a live reversal, and not to a viewer or a sign-in barred from posting.
 *  The reversal is dated as chosen (default `defaultReversalDate`; `fx:reverse`, audited as before;
 *  the server still refuses a locked date or one not after the revaluation). */
export function RevaluationReverseBanner({ voucherId }: { voucherId: number }): React.JSX.Element | null {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const role = useSession((s) => s.user?.role)
  const cannotPost = useCapabilityRefused('canPost')
  const { data } = useQuery({ queryKey: ['fxRevaluationOf', voucherId], queryFn: () => cfApi.fx.revaluationOf(voucherId) })
  const { data: lock } = useQuery({ queryKey: ['lockDate'], queryFn: api.company.lockGet, enabled: !!data && !data.reversed })
  // A viewer (or a sign-in the owner barred from posting) would only be refused by main.
  if (!data || data.reversed || role === 'viewer' || cannotPost) return null
  const on = picked ?? defaultReversalDate(data.asOf, lock?.date)
  const reverse = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Reverse the revaluation',
      message: `Post the reversal of this revaluation (as on ${toDisplayDate(data.asOf)}) on ${toDisplayDate(on)}? The two journals then go to the bin together.`,
      confirmLabel: 'Reverse'
    })
    if (!ok) return
    setBusy(true)
    try {
      await cfApi.fx.reverse(data.id, on)
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
      action={
        <span className="flex items-center gap-2">
          <DateInput value={on} context={on} onChange={setPicked} testId="input-fx-reverse-date" ariaLabel="Reversal date" className="w-28" />
          <Button size="sm" disabled={busy} data-testid="btn-fx-reverse" onClick={() => void reverse()}>Reverse…</Button>
        </span>
      }
    >
      Forex revaluation as on {toDisplayDate(data.asOf)}, not reversed yet. Reverse it here rather than by hand, so bill-wise
      outstandings keep agreeing with the books.
    </Banner>
  )
}
