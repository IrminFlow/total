import { useState } from 'react'
import { DEDUCTEE_TYPE_LABELS } from '@shared/tds'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import type { TcsSuggestion, TdsSuggestion } from '../../lib/client'
import { AmountInput, Button, Money, Select, TextInput } from '../../components/ui'
import { confirmDialog } from '../../lib/dialogs'

const rs = (p: number): string => formatPaise(p, { symbol: true })

/** Why TCS applies (or doesn't) in words (WP 3.3). Exported for tests. */
export function tcsReasonText(s: TcsSuggestion): string {
  if (s.payment) {
    if (s.payment.deductedAtCredit) return 'TCS was collected on the invoices — nothing to collect on this receipt'
    const parts: string[] = []
    if (s.payment.undeductedBillsPaise > 0) parts.push(`${rs(Math.min(s.payment.undeductedBillsPaise, s.basePaise ?? s.payment.undeductedBillsPaise))} of sales not collected on when invoiced`)
    if (s.payment.advancePaise > 0) parts.push(`${rs(s.payment.advancePaise)} received in advance of the invoice`)
    if (parts.length > 0) return `Collect on receipt: ${parts.join(' + ')} (TCS is due at debit or receipt, whichever is earlier)`
  }
  const what = s.sectionFrom === 'goods' ? 'on the goods' : s.sectionFrom === 'ledger' ? 'on the sales ledger' : s.sectionFrom === 'party' ? 'for this buyer' : ''
  const base = s.gstInBase ? ' · base includes GST' : ''
  const t = s.threshold
  switch (t.reason) {
    case 'single':
      return `Sale above ${rs(t.singlePaise)} ${what}${base}`.trim()
    case 'aggregate':
      return `Sales of ${rs(t.priorPaise + (s.basePaise ?? 0))} this year cross ${rs(t.aggregateLimitPaise)}${base}`
    case 'none':
      return `TCS applies to every sale ${what}${base}`.replace(/\s+/g, ' ').trim()
    default:
      return t.singlePaise > 0
        ? `Below ${rs(t.singlePaise)} — no TCS is due on this sale; applying anyway is your call`
        : 'Below threshold; applying anyway is your call'
  }
}

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
 *  choice, certificate, a manual amount (confirmed) and "Not applicable". With kind 'tcs' (WP 3.3)
 *  the same banner reads "TCS u/s … collect ₹X" on sales invoices and receipts. */
export function TdsBanner({
  suggestion,
  onApply,
  onDismiss,
  blockedReason,
  onChooseSection,
  onApplyManual,
  onNotApplicable,
  kind = 'tds'
}: {
  suggestion: TdsSuggestion | TcsSuggestion
  kind?: 'tds' | 'tcs'
  onApply: () => void
  onDismiss: () => void
  /** Non-null = Apply is disabled, with this explanation. */
  blockedReason: string | null
  onChooseSection?: (sectionId: number) => void
  onApplyManual?: (tdsPaise: number) => void
  onNotApplicable?: (reason: string) => void
}): React.JSX.Element {
  const s = suggestion
  const tcs = kind === 'tcs'
  const k = kind
  const name = tcs ? 'TCS' : 'TDS'
  const verb = tcs ? 'collect' : 'deduct'
  const Verb = tcs ? 'Collect' : 'Deduct'
  const noun = tcs ? 'collection' : 'deduction'
  const nothingToDeduct = s.tdsPaise <= 0
  const [mode, setMode] = useState<'idle' | 'manual' | 'na'>('idle')
  const [manual, setManual] = useState<number | null>(null)
  const [reason, setReason] = useState(tcs ? 'Form 27C declaration (s.206C(1A)) — goods for manufacture' : 'Not a sum liable to TDS')
  const candidates = (s.candidates ?? []) as { sectionId: number; code: string; from: string }[]
  const reasonText = tcs ? tcsReasonText(s as TcsSuggestion) : tdsReasonText(s as TdsSuggestion)

  const applyManual = async (): Promise<void> => {
    if (manual == null || manual <= 0 || !onApplyManual) return
    const ok = await confirmDialog({
      title: `Manual ${name} amount`,
      message: `${Verb} ${rs(manual)} instead of the rate table's ${rs(s.tdsPaise)}? A manual ${noun} is saved as such and isn't checked against the rate.`,
      confirmLabel: `${Verb} manually`
    })
    if (ok) {
      onApplyManual(manual)
      setMode('idle')
    }
  }

  return (
    <div data-testid={`banner-${k}`} className="mt-3 rounded-md border border-amber/40 bg-amberbar/10 px-3 py-2 text-body-sm text-amber">
      <div className="flex items-center justify-between gap-3">
        <span>
          {name} u/s {s.reference !== s.code ? `${s.code} (${s.reference})` : s.code}: {verb}{' '}
          <Money paise={s.tdsPaise} className="text-amber" /> <span className="text-muted">at {s.rate}%</span>
          {s.basePaise != null && <span className="text-muted"> on {rs(s.basePaise)}</span>}
          {s.basis === 'no_pan' && <span className="ml-2 text-cr">PAN missing — {s.rate}% rate</span>}
          {!tcs && s.deducteeType && <span className="ml-2 text-muted">· {DEDUCTEE_TYPE_LABELS[s.deducteeType]}</span>}
          {s.sectionFrom === 'ledger' && <span className="ml-2 text-muted">· section from the {tcs ? 'sales' : 'debited'} ledger</span>}
          {s.sectionFrom === 'goods' && <span className="ml-2 text-muted">· section from the goods</span>}
          {s.payableLedgerId == null && <span className="ml-2 text-muted">· {s.payableLedgerName} is created when you save</span>}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {candidates.length > 1 && onChooseSection && (
            <Select
              aria-label={`${name} section`}
              data-testid={`select-${k}-section`}
              className="w-28"
              value={s.sectionId}
              onChange={(e) => onChooseSection(Number(e.target.value))}
            >
              {candidates.map((c) => (
                <option key={c.sectionId} value={c.sectionId}>
                  {c.code}
                  {c.from === 'party' ? ' (party)' : c.from === 'ledger' ? ' (ledger)' : c.from === 'goods' ? ' (goods)' : ''}
                </option>
              ))}
            </Select>
          )}
          {onNotApplicable && (
            <Button data-testid={`btn-${k}-na`} onClick={() => setMode(mode === 'na' ? 'idle' : 'na')}>
              Not applicable
            </Button>
          )}
          {onApplyManual && (
            <Button data-testid={`btn-${k}-manual`} onClick={() => setMode(mode === 'manual' ? 'idle' : 'manual')}>
              Manual…
            </Button>
          )}
          <Button onClick={onDismiss}>Dismiss</Button>
          <Button data-testid={`btn-${k}-apply`} variant="primary" disabled={!!blockedReason || nothingToDeduct} onClick={onApply}>
            Apply
          </Button>
        </div>
      </div>
      <p className="mt-1 text-muted" data-testid={`banner-${k}-reason`}>
        {reasonText}
        {s.certificate && (
          <span data-testid={`banner-${k}-certificate`}>
            {' '}· lower-{noun} certificate {s.certificate.certificateNo} at {s.certificate.rateBp / 100}%
            {s.certificate.validTo ? `, valid to ${toDisplayDate(s.certificate.validTo)}` : ''}
          </span>
        )}
      </p>
      {mode === 'manual' && (
        <div className="mt-2 flex items-center gap-2 text-ink">
          <span className="text-muted">{Verb}</span>
          <div className="w-36">
            <AmountInput paise={manual} onPaise={setManual} testId={`input-${k}-manual`} ariaLabel={`Manual ${name} amount`} onEnter={() => void applyManual()} />
          </div>
          <Button data-testid={`btn-${k}-manual-apply`} disabled={manual == null || manual <= 0 || !!blockedReason} onClick={() => void applyManual()}>
            Apply manual amount
          </Button>
        </div>
      )}
      {mode === 'na' && onNotApplicable && (
        <div className="mt-2 flex items-center gap-2 text-ink">
          <span className="text-muted">Reason</span>
          <TextInput className="w-72" aria-label={`Why ${name} is not applicable`} data-testid={`input-${k}-na-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button
            data-testid={`btn-${k}-na-confirm`}
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
export function TdsNotApplicableNote({ reason, onUndo, kind = 'tds' }: { reason: string; onUndo: () => void; kind?: 'tds' | 'tcs' }): React.JSX.Element {
  return (
    <div data-testid={`banner-${kind}-na`} className="mt-3 flex items-center justify-between gap-3 rounded-md border border-line bg-panel2 px-3 py-2 text-body-sm text-muted">
      <span>{kind === 'tcs' ? 'TCS' : 'TDS'} marked not applicable: {reason}</span>
      <Button size="sm" variant="ghost" data-testid={`btn-${kind}-na-undo`} onClick={onUndo}>
        Undo
      </Button>
    </div>
  )
}
