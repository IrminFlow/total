import { useMemo, useState } from 'react'
import { slabsOn } from '@shared/gst/rateTable'
import type { SellForm } from '@shared/simple/sell'
import { useT } from '../../lib/i18n'
import { AmountInput, Field, FieldError, TextInput } from '../../components/ui'

/**
 * WP 9.2 — "Just an amount" (a services business, or stock switched off): the amount, what it was
 * for, and — only when the bill charges GST (a regular registration on the bill's date, WP 8.0) —
 * the GST rate, picked from the dated slab table (shared/gst/rateTable.ts); never typed freely.
 */
export function AmountLine({
  form,
  regular,
  charges,
  amountError,
  rateError,
  onChange
}: {
  form: SellForm
  regular: boolean
  charges: boolean
  amountError: string | null
  rateError: string | null
  onChange: (patch: Partial<SellForm>) => void
}): React.JSX.Element {
  const t = useT()
  const slabs = useMemo(() => slabsOn(form.date), [form.date])
  const [otherOpen, setOtherOpen] = useState(false)
  const label = charges ? (form.ratesIncludeGst ? t('simple.sell.amountIncl') : t('simple.sell.amountExcl')) : t('simple.sell.amount')
  const picked = form.gstRate
  const pickedSpecial = picked != null && slabs.some((s) => s.rate === picked && !s.common)

  const chip = (rate: number, text: string): React.JSX.Element => (
    <button
      key={rate}
      type="button"
      role="radio"
      aria-checked={picked === rate}
      data-testid={`sell-gst-rate-${rate}`}
      onClick={() => onChange({ gstRate: rate })}
      className={`rounded-md border px-3 py-1.5 text-detail transition-colors ${
        picked === rate ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
      }`}
    >
      {text}
    </button>
  )

  return (
    <div className="flex flex-col gap-3" data-testid="sell-amount-line">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
        <Field label={label} name="amount" error={amountError}>
          <AmountInput paise={form.amount} onPaise={(p) => onChange({ amount: p })} testId="input-sell-amount" />
        </Field>
        <Field label={t('simple.sell.whatFor')}>
          <TextInput value={form.note} placeholder={t('simple.sell.whatForPlaceholder')} onChange={(e) => onChange({ note: e.target.value })} data-testid="input-sell-note" />
        </Field>
      </div>
      {regular && charges && (
        <div data-testid="sell-gst">
          <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.sell.gstRate')}</span>
          <p className="mb-2 text-small text-muted">{t('simple.sell.gstRateWhat')}</p>
          <div role="radiogroup" aria-label={t('simple.sell.gstRate')} className="flex flex-wrap gap-2">
            {slabs.filter((s) => s.common).map((s) => chip(s.rate, s.rate === 0 ? t('simple.sell.gstNil') : t('simple.sell.gstChip', { rate: s.rate })))}
            {slabs.some((s) => !s.common) && (
              <button
                type="button"
                aria-expanded={otherOpen || pickedSpecial}
                data-testid="sell-gst-rate-other"
                onClick={() => setOtherOpen((o) => !o)}
                className="rounded-md border border-dashed border-line px-3 py-1.5 text-detail text-muted hover:border-amber/60"
              >
                {t('simple.sell.otherRates')}
              </button>
            )}
          </div>
          {(otherOpen || pickedSpecial) && (
            <div className="mt-2 flex flex-wrap gap-2">{slabs.filter((s) => !s.common).map((s) => chip(s.rate, t('simple.sell.gstChip', { rate: s.rate })))}</div>
          )}
          <FieldError name="gstRate" error={rateError} />
        </div>
      )}
    </div>
  )
}
