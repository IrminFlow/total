/**
 * "You were part-way through an entry when Total closed" (roadmap #250).
 *
 * Offered rather than restored automatically: the entry screen may already have something in it,
 * and silently replacing what somebody is typing with what they were typing yesterday is worse
 * than losing yesterday's. Discard is right beside it, because the second most annoying thing
 * after losing an entry is being asked about one you no longer want.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { nextDraftId, useNav, type VoucherDraft } from '../../state/stores'
import { Button } from '../../components/ui'
import { toDisplayDateTime } from '@shared/dates'
import { draftWorthKeeping } from '../../lib/useCrashDraft'

export function RecoveredDraft({ suppressed }: { suppressed: boolean }): React.JSX.Element | null {
  const nav = useNav()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['voucherDraft'], queryFn: api.drafts.get, enabled: !suppressed })

  if (suppressed || !data) return null
  const draft = data.payload as VoucherDraft
  // The payload is whatever an older build wrote; anything that does not look like an entry worth
  // restoring is quietly ignored rather than offered as a mystery.
  if (!draft || typeof draft !== 'object' || !draftWorthKeeping(draft)) return null

  const lines = draft.lines?.length ?? 0
  const forget = async (): Promise<void> => {
    await api.drafts.clear()
    await queryClient.invalidateQueries({ queryKey: ['voucherDraft'] })
  }

  return (
    <div
      className="mb-4 flex items-center justify-between gap-4 rounded-md border border-amber/40 bg-amber/10 px-4 py-2.5"
      data-testid="recovered-draft"
    >
      <p className="text-body-sm text-ink">
        An entry from {toDisplayDateTime(new Date(`${data.savedAt.replace(' ', 'T')}Z`))} was never saved
        {lines > 0 ? ` — ${lines} line${lines === 1 ? '' : 's'}` : ''}. Total closed before it went into the books.
      </p>
      <div className="flex shrink-0 gap-2">
        <Button
          data-testid="btn-recover-draft"
          onClick={() => {
            nav.go({ name: 'voucher-entry', draft, draftId: nextDraftId() })
            void forget()
          }}
        >
          Restore it
        </Button>
        <Button data-testid="btn-discard-draft" onClick={() => void forget()}>
          Discard
        </Button>
      </div>
    </div>
  )
}
