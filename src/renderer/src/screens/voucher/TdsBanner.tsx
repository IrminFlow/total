import { DEDUCTEE_TYPE_LABELS } from '@shared/tds'
import { formatPaise } from '@shared/money'
import type { TdsSuggestion } from '../../lib/client'
import { Button, Money } from '../../components/ui'

/** The "TDS u/s … deduct ₹X" banner both entry modes show under their lines. */
export function TdsBanner({
  suggestion,
  onApply,
  onDismiss,
  blockedReason
}: {
  suggestion: TdsSuggestion
  onApply: () => void
  onDismiss: () => void
  /** Non-null = Apply is disabled, with this explanation. */
  blockedReason: string | null
}): React.JSX.Element {
  const s = suggestion
  const nothingToDeduct = s.tdsPaise <= 0
  return (
    <div data-testid="banner-tds" className="mt-3 rounded-md border border-amber/40 bg-amberbar/10 px-3 py-2 text-body-sm text-amber">
      <div className="flex items-center justify-between gap-3">
        <span>
          TDS u/s {s.reference !== s.code ? `${s.code} (${s.reference})` : s.code}: deduct{' '}
          <Money paise={s.tdsPaise} className="text-amber" /> <span className="text-muted">at {s.rate}%</span>
          {s.basis === 'no_pan' && <span className="ml-2 text-cr">PAN missing — {s.rate}% rate</span>}
          {s.certificate && <span className="ml-2 text-muted">lower-deduction certificate {s.certificate.certificateNo}</span>}
          {s.deducteeType && <span className="ml-2 text-muted">· {DEDUCTEE_TYPE_LABELS[s.deducteeType]}</span>}
          {s.sectionFrom === 'ledger' && <span className="ml-2 text-muted">· section from the debited ledger</span>}
          {!s.thresholdCrossed && (
            <span className="ml-2 text-muted">
              (below threshold
              {s.threshold.aggregateLimitPaise > 0 &&
                ` — ${formatPaise(s.threshold.priorPaise, { symbol: true })} so far against ${formatPaise(s.threshold.aggregateLimitPaise, { symbol: true })} a ${s.threshold.basis === 'month' ? 'month' : 'year'}`}
              ; applying anyway is your call)
            </span>
          )}
          {s.payableLedgerId == null && <span className="ml-2 text-muted">· {s.payableLedgerName} is created when you save</span>}
        </span>
        <div className="flex shrink-0 gap-2">
          <Button onClick={onDismiss}>Dismiss</Button>
          <Button data-testid="btn-tds-apply" variant="primary" disabled={!!blockedReason || nothingToDeduct} onClick={onApply}>
            Apply
          </Button>
        </div>
      </div>
      {blockedReason && <p className="mt-1.5 text-cr">{blockedReason}</p>}
    </div>
  )
}
