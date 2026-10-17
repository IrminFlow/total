import type { MessageKey } from '@shared/i18n'
import type { CarryDropped } from '@shared/simple/carryBack'
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
  rounding: 'simple.handoff.dropped.rounding'
}

/**
 * WP 9.10 follow-up — above a simple flow that "Back to simple" brought the full editor's changes
 * back into (lib/handoff.ts useCarriedBack): the fields the editor held that this form has no place
 * for. Nothing when everything came along.
 */
export function CarriedBackNote({ dropped }: { dropped: CarryDropped[] | null }): React.JSX.Element | null {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed table above
  if (!dropped || dropped.length === 0) return null
  return (
    <div role="note" className="mb-4 rounded-md border border-line bg-panel2 px-3 py-2 text-detail text-ink" data-testid="carried-back-note">
      <p className="font-medium">{t('simple.handoff.carriedTitle')}</p>
      <p className="mt-1">{t('simple.handoff.carriedDropped', { names: dropped.map((d) => lbl(DROPPED_TEXT[d])).join(', ') })}</p>
    </div>
  )
}
