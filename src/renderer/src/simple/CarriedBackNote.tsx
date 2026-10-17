import { useEffect, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import type { CarryDropped } from '@shared/simple/carryBack'
import type { CarriedBack } from '../lib/handoff'
import { useT } from '../lib/i18n'

const DROPPED_TEXT: Record<CarryDropped, MessageKey> = {
  number: 'simple.handoff.dropped.number',
  account: 'simple.handoff.dropped.account',
  extraLines: 'simple.handoff.dropped.extraLines',
  tds: 'simple.handoff.dropped.tds',
  tcs: 'simple.handoff.dropped.tcs',
  costCentres: 'simple.handoff.dropped.costCentres',
  transport: 'simple.handoff.dropped.transport',
  currency: 'simple.handoff.dropped.currency',
  placeOfSupply: 'simple.handoff.dropped.placeOfSupply',
  optional: 'simple.handoff.dropped.optional',
  dueDate: 'simple.handoff.dropped.dueDate',
  billName: 'simple.handoff.dropped.billName',
  billRefs: 'simple.handoff.dropped.billRefs',
  billSplit: 'simple.handoff.dropped.billSplit',
  godowns: 'simple.handoff.dropped.godowns',
  serials: 'simple.handoff.dropped.serials',
  cheque: 'simple.handoff.dropped.cheque',
  rounding: 'simple.handoff.dropped.rounding',
  links: 'simple.handoff.dropped.links'
}

/**
 * WP 9.10 follow-up — above a simple flow that "Back to simple" brought the full editor's changes
 * back into (lib/handoff.ts useCarriedBack): the fields the editor held that this form has no place
 * for. Nothing when everything came along. Those details are gone from the screen (no discard
 * question was asked), so the note is a warning that STAYS — no timer — until the user dismisses it
 * or saves (`hidden`, which ends it for good: a new entry after the save is not the carried one).
 */
export function CarriedBackNote({ dropped, hidden = false }: { dropped: CarriedBack; hidden?: boolean }): React.JSX.Element | null {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed table above
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (hidden) setClosed(true)
  }, [hidden])
  const show = (dropped === 'refused' || (!!dropped && dropped.length > 0)) && !closed && !hidden
  if (!show) return null
  return (
    <div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-amber/60 bg-amberbar/10 px-4 py-3 text-ink" data-testid="carried-back-note">
      <div className="min-w-0 flex-1">
        {dropped === 'refused' ? (
          <p className="font-medium">{t('simple.handoff.notCarriedBack')}</p>
        ) : (
          <>
            <p className="font-medium">{t('simple.handoff.carriedTitle')}</p>
            <p className="mt-1 text-detail">{t('simple.handoff.carriedDropped', { names: dropped!.map((d) => lbl(DROPPED_TEXT[d])).join(', ') })}</p>
          </>
        )}
      </div>
      <button type="button" className="shrink-0 rounded-md border border-line px-2.5 py-1 text-detail hover:bg-panel2" data-testid="carried-back-note-dismiss" onClick={() => setClosed(true)}>
        {t('simple.handoff.carriedGotIt')}
      </button>
    </div>
  )
}
