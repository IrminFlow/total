import { useState } from 'react'
import { DEDUCTEE_TYPE_LABELS } from '@shared/tds'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import type { TdsSuggestion } from '../../lib/client'
import { AmountInput, Button, Money, Select, TextInput } from '../../components/ui'
import { confirmDialog } from '../../lib/dialogs'

const rs = (p: number): string => formatPaise(p, { symbol: true })

/** Why TDS applies (or doesn't) in words — the banner's reason line. Exported for tests. */
export function tdsReasonText(s: TdsSuggestion): string {
  if (s.payment) {
    if (s.payment.deductedAtCredit) return 'TDS was deducted when the bills were booked — nothing to deduct on this payment'
    const parts: string[] = []
    if (s.payment.undeductedBillsPaise > 0) parts.push(`${rs(Math.min(s.payment.undeductedBillsPaise, s.basePaise ?? s.payment.undeductedBillsPaise))} of bills not deducted when booked`)
    if (s.payment.advancePaise > 0) parts.push(`${rs(s.payment.advancePaise)} paid in advance of the bill`)
    if (parts.length > 0) return `Deduct on payment: ${parts.join(' + ')} (TDS is due at credit or payment, whichever is earlier)`
  }
  const t = s.threshold
  const period = t.basis === 'month' ? 'month' : 'year'
  switch (t.reason) {
    case 'single':
      return `Single payment above ${rs(t.singlePaise)}`
    case 'aggregate':
      return `Aggregate ${rs(t.priorPaise + (s.basePaise ?? 0))} this ${period} crosses ${rs(t.aggregateLimitPaise)}`
    case 'none':
      return 'This section has no threshold'
    default:
      return t.aggregateLimitPaise > 0
        ? `Below threshold — ${rs(t.priorPaise)} so far against ${rs(t.aggregateLimitPaise)} a ${period}; applying anyway is your call`
        : 'Below threshold; applying anyway is your call'
  }
}

/** The "TDS u/s … deduct ₹X" banner both entry modes show under their lines: reason, section
 *  choice, certificate, a manual amount (confirmed) and "Not applicable". */
export function TdsBanner({
  suggestion,
  onApply,
  onDismiss,
  blockedReason,
  onChooseSection,
  onApplyManual,
  onNotApplicable
}: {
  suggestion: TdsSuggestion
  onApply: () => void
  onDismiss: () => void
  /** Non-null = Apply is disabled, with this explanation. */
  blockedReason: string | null
  onChooseSection?: (sectionId: number) => void
  onApplyManual?: (tdsPaise: number) => void
  onNotApplicable?: (reason: string) => void
}): React.JSX.Element {
  const s = suggestion
  const nothingToDeduct = s.tdsPaise <= 0
  const [mode, setMode] = useState<'idle' | 'manual' | 'na'>('idle')
  const [manual, setManual] = useState<number | null>(null)
  const [reason, setReason] = useState('Not a sum liable to TDS')
  const candidates = s.candidates ?? []

  const applyManual = async (): Promise<void> => {
    if (manual == null || manual <= 0 || !onApplyManual) return
    const ok = await confirmDialog({
      title: 'Manual TDS amount',
      message: `Deduct ${rs(manual)} instead of the rate table's ${rs(s.tdsPaise)}? A manual deduction is saved as such and isn't checked against the rate.`,
      confirmLabel: 'Deduct manually'
    })
    if (ok) {
      onApplyManual(manual)
      setMode('idle')
    }
  }

  return (
    <div data-testid="banner-tds" className="mt-3 rounded-md border border-amber/40 bg-amberbar/10 px-3 py-2 text-body-sm text-amber">
      <div className="flex items-center justify-between gap-3">
        <span>
          TDS u/s {s.reference !== s.code ? `${s.code} (${s.reference})` : s.code}: deduct{' '}
          <Money paise={s.tdsPaise} className="text-amber" /> <span className="text-muted">at {s.rate}%</span>
          {s.basePaise != null && <span className="text-muted"> on {rs(s.basePaise)}</span>}
          {s.basis === 'no_pan' && <span className="ml-2 text-cr">PAN missing — {s.rate}% rate</span>}
          {s.deducteeType && <span className="ml-2 text-muted">· {DEDUCTEE_TYPE_LABELS[s.deducteeType]}</span>}
          {s.sectionFrom === 'ledger' && <span className="ml-2 text-muted">· section from the debited ledger</span>}
          {s.payableLedgerId == null && <span className="ml-2 text-muted">· {s.payableLedgerName} is created when you save</span>}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {candidates.length > 1 && onChooseSection && (
            <Select
              aria-label="TDS section"
              data-testid="select-tds-section"
              className="w-28"
              value={s.sectionId}
              onChange={(e) => onChooseSection(Number(e.target.value))}
            >
              {candidates.map((c) => (
                <option key={c.sectionId} value={c.sectionId}>
                  {c.code}
                  {c.from === 'party' ? ' (party)' : c.from === 'ledger' ? ' (ledger)' : ''}
                </option>
              ))}
            </Select>
          )}
          {onNotApplicable && (
            <Button data-testid="btn-tds-na" onClick={() => setMode(mode === 'na' ? 'idle' : 'na')}>
              Not applicable
            </Button>
          )}
          {onApplyManual && (
            <Button data-testid="btn-tds-manual" onClick={() => setMode(mode === 'manual' ? 'idle' : 'manual')}>
              Manual…
            </Button>
          )}
          <Button onClick={onDismiss}>Dismiss</Button>
          <Button data-testid="btn-tds-apply" variant="primary" disabled={!!blockedReason || nothingToDeduct} onClick={onApply}>
            Apply
          </Button>
        </div>
      </div>
      <p className="mt-1 text-muted" data-testid="banner-tds-reason">
        {tdsReasonText(s)}
        {s.certificate && (
          <span data-testid="banner-tds-certificate">
            {' '}· lower-deduction certificate {s.certificate.certificateNo} at {s.certificate.rateBp / 100}%
            {s.certificate.validTo ? `, valid to ${toDisplayDate(s.certificate.validTo)}` : ''}
          </span>
        )}
      </p>
      {mode === 'manual' && (
        <div className="mt-2 flex items-center gap-2 text-ink">
          <span className="text-muted">Deduct</span>
          <div className="w-36">
            <AmountInput paise={manual} onPaise={setManual} testId="input-tds-manual" ariaLabel="Manual TDS amount" onEnter={() => void applyManual()} />
          </div>
          <Button data-testid="btn-tds-manual-apply" disabled={manual == null || manual <= 0 || !!blockedReason} onClick={() => void applyManual()}>
            Apply manual amount
          </Button>
        </div>
      )}
      {mode === 'na' && onNotApplicable && (
        <div className="mt-2 flex items-center gap-2 text-ink">
          <span className="text-muted">Reason</span>
          <TextInput className="w-72" aria-label="Why TDS is not applicable" data-testid="input-tds-na-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button
            data-testid="btn-tds-na-confirm"
            disabled={!reason.trim()}
            onClick={() => {
              onNotApplicable(reason.trim().slice(0, 200))
              setMode('idle')
            }}
          >
            Mark not applicable
          </Button>
        </div>
      )}
      {blockedReason && <p className="mt-1.5 text-cr">{blockedReason}</p>}
    </div>
  )
}

/** Shown instead of the banner while the voucher is marked "Not applicable" (saved on save). */
export function TdsNotApplicableNote({ reason, onUndo }: { reason: string; onUndo: () => void }): React.JSX.Element {
  return (
    <div data-testid="banner-tds-na" className="mt-3 flex items-center justify-between gap-3 rounded-md border border-line bg-panel2 px-3 py-2 text-body-sm text-muted">
      <span>TDS marked not applicable: {reason}</span>
      <Button size="sm" variant="ghost" data-testid="btn-tds-na-undo" onClick={onUndo}>
        Undo
      </Button>
    </div>
  )
}
