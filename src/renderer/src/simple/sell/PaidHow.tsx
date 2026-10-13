import type { MessageKey } from '@shared/i18n'
import type { MoneyHow } from '@shared/simple/intents'
import { PART_HOWS, paidChoicesFor, type PaidChoice, type SellForm, type SellSetup } from '@shared/simple/sell'
import { useT } from '../../lib/i18n'
import { AmountInput, Field, FieldError, Select } from '../../components/ui'

const PAID_TEXT: Record<PaidChoice, MessageKey> = {
  cash: 'simple.sell.paid.cash',
  upi: 'simple.sell.paid.upi',
  card: 'simple.sell.paid.card',
  bank: 'simple.sell.paid.bank',
  credit: 'simple.sell.paid.credit',
  part: 'simple.sell.paid.part'
}

/**
 * WP 9.2 — "Paid how?": Cash / UPI / Card / Bank transfer / On credit (udhaar) / Partly paid (how
 * much now, and how). A walk-in "Cash customer" pays in full, so the credit choices wait for a
 * named customer. The account the money goes into defaults per way of paying (main: WP 5.6 memory,
 * else the counter's accounts) and can be changed. What stays due is said by the preview line
 * (simple:preview), never worked out here.
 */
export function PaidHow({
  form,
  setup,
  error,
  onChange
}: {
  form: SellForm
  setup: SellSetup | null
  error: string | null
  onChange: (patch: Partial<SellForm>) => void
}): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed table above
  const walkIn = form.customerId == null
  const how: MoneyHow | null = form.paid === 'credit' ? null : form.paid === 'part' ? form.partHow : form.paid
  const accounts = (setup?.moneyAccounts ?? []).filter((a) => (how === 'cash' ? a.kind === 'cash' : a.kind === 'bank'))
  const chosen = how ? (form.accountId ?? setup?.defaults[how] ?? null) : null
  const fromMemory = how != null && how !== 'cash' && form.accountId == null && setup?.memoryId != null && chosen === setup.defaults[how]

  return (
    <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.sell.paidHow')} data-testid="sell-paid-how">
      <h2 className="mb-3 text-subtitle font-semibold text-ink">{t('simple.sell.paidHow')}</h2>
      <div role="radiogroup" aria-label={t('simple.sell.paidHow')} className="flex flex-wrap gap-2">
        {paidChoicesFor(walkIn).map(({ value, disabled }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={form.paid === value}
            disabled={disabled}
            data-testid={`sell-paid-${value}`}
            onClick={() => onChange({ paid: value, accountId: null })}
            className={`rounded-md border px-3 py-1.5 text-detail transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              form.paid === value ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
            }`}
          >
            {lbl(PAID_TEXT[value])}
          </button>
        ))}
      </div>
      {walkIn && <p className="mt-2 text-small text-muted" data-testid="sell-walk-in-hint">{t('simple.sell.walkInPaysNow')}</p>}

      {form.paid === 'part' && (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
          <Field label={t('simple.sell.partAmount')}>
            <AmountInput paise={form.partAmount} onPaise={(p) => onChange({ partAmount: p })} testId="input-sell-part-amount" />
          </Field>
          <div>
            <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.sell.partHow')}</span>
            <div role="radiogroup" aria-label={t('simple.sell.partHow')} className="flex flex-wrap gap-2">
              {PART_HOWS.map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={form.partHow === h}
                  data-testid={`sell-part-how-${h}`}
                  onClick={() => onChange({ partHow: h, accountId: null })}
                  className={`rounded-md border px-3 py-1 text-detail ${form.partHow === h ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'}`}
                >
                  {lbl(PAID_TEXT[h])}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {how != null && (
        <div className="mt-3 max-w-sm">
          {accounts.length > 0 ? (
            <Field label={t('simple.sell.goesInto')} hint={fromMemory ? t('simple.sell.fromMemory') : undefined}>
              <Select value={chosen ?? ''} onChange={(e) => onChange({ accountId: Number(e.target.value) })} data-testid="select-sell-account">
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="text-small text-muted" data-testid="sell-no-account">{t('simple.sell.noAccount')}</p>
          )}
        </div>
      )}
      <FieldError name="payment" error={error} />
    </section>
  )
}
