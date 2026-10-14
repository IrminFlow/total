import { useMemo, useState } from 'react'
import { slabsOn } from '@shared/gst/rateTable'
import type { BuyForm, BuyGst } from '@shared/simple/buy'
import { useT } from '../../lib/i18n'
import { AmountInput, Field, FieldError } from '../../components/ui'

/**
 * WP 9.3 — an expense or "just an amount" on a supplier's bill: the amount as printed (with or
 * before GST, as the form says) and — when the bill's GST is claimed, or added to the cost before
 * GST — the GST rate, picked from the dated slab table (shared/gst/rateTable.ts); never typed.
 * `shownRate` is the rate in force (picked, else the account's own).
 */
export function BuyAmount({
  form,
  gst,
  asksRate,
  shownRate,
  amountError,
  rateError,
  onChange
}: {
  form: BuyForm
  gst: BuyGst
  asksRate: boolean
  shownRate: number | null
  amountError: string | null
  rateError: string | null
  onChange: (patch: Partial<BuyForm>) => void
}): React.JSX.Element {
  const t = useT()
  const slabs = useMemo(() => slabsOn(form.date), [form.date])
  const [otherOpen, setOtherOpen] = useState(false)
  const label = gst === 'none' ? t('simple.buy.amount') : form.ratesIncludeGst ? t('simple.buy.amountIncl') : t('simple.buy.amountExcl')
  const picked = shownRate
  const pickedSpecial = picked != null && slabs.some((s) => s.rate === picked && !s.common)

  const chip = (rate: number, text: string): React.JSX.Element => (
    <button
      key={rate}
      type="button"
      role="radio"
      aria-checked={picked === rate}
      data-testid={`buy-gst-rate-${rate}`}
      onClick={() => onChange({ gstRate: rate })}
      className={`rounded-md border px-3 py-1.5 text-detail transition-colors ${
        picked === rate ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
      }`}
    >
      {text}
    </button>
  )

  return (
    <div className="flex flex-col gap-3" data-testid="buy-amount-line">
      <div className="max-w-xs">
        <Field label={label} name="amount" error={amountError}>
          <AmountInput paise={form.amount} onPaise={(p) => onChange({ amount: p })} testId="input-buy-amount" />
        </Field>
      </div>
      {asksRate && (
        <div data-testid="buy-gst">
          <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.buy.gstRate')}</span>
          <p className="mb-2 text-small text-muted">{gst === 'fold' ? t('simple.buy.gstRateFold') : t('simple.buy.gstRateWhat')}</p>
          <div role="radiogroup" aria-label={t('simple.buy.gstRate')} className="flex flex-wrap gap-2">
            {slabs.filter((s) => s.common).map((s) => chip(s.rate, s.rate === 0 ? t('simple.buy.gstNil') : t('simple.buy.gstChip', { rate: s.rate })))}
            {slabs.some((s) => !s.common) && (
              <button
                type="button"
                aria-expanded={otherOpen || pickedSpecial}
                data-testid="buy-gst-rate-other"
                onClick={() => setOtherOpen((o) => !o)}
                className="rounded-md border border-dashed border-line px-3 py-1.5 text-detail text-muted hover:border-amber/60"
              >
                {t('simple.buy.otherRates')}
              </button>
            )}
          </div>
          {(otherOpen || pickedSpecial) && (
            <div className="mt-2 flex flex-wrap gap-2">{slabs.filter((s) => !s.common).map((s) => chip(s.rate, t('simple.buy.gstChip', { rate: s.rate })))}</div>
          )}
          <FieldError name="gstRate" error={rateError} />
        </div>
      )}
    </div>
  )
}
