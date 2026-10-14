import type { MessageKey } from '@shared/i18n'
import type { MoneyHow } from '@shared/simple/intents'
import { BUY_PAID_CHOICES, BUY_PART_HOWS, type BuyForm, type BuyPaidChoice, type BuySetup } from '@shared/simple/buy'
import { useT } from '../../lib/i18n'
import { AmountInput, Field, FieldError, Select } from '../../components/ui'

const PAID_TEXT: Record<BuyPaidChoice, MessageKey> = {
  cash: 'simple.buy.paid.cash',
  upi: 'simple.buy.paid.upi',
  card: 'simple.buy.paid.card',
  bank: 'simple.buy.paid.bank',
  credit: 'simple.buy.paid.notYet',
  part: 'simple.buy.paid.part'
}

/**
 * WP 9.3 — "Paid now?": Cash / UPI / Card / Bank transfer / Not yet / Partly (how much now, and
 * how). The payment is saved with the bill, against it, in the same intent. The account the money
 * came from defaults per way of paying (main: WP 5.6 memory "Pay from", else the counter's
 * accounts) and can be changed. What stays to pay is said by the preview line (simple:preview).
 */
export function PaidNow({
  form,
  setup,
  error,
  onChange
}: {
  form: BuyForm
  setup: BuySetup | null
  error: string | null
  onChange: (patch: Partial<BuyForm>) => void
}): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed table above
  const how: MoneyHow | null = form.paid === 'credit' ? null : form.paid === 'part' ? form.partHow : form.paid
  const accounts = (setup?.moneyAccounts ?? []).filter((a) => (how === 'cash' ? a.kind === 'cash' : a.kind === 'bank'))
  const chosen = how ? (form.accountId ?? setup?.defaults[how] ?? null) : null
  const fromMemory = how != null && how !== 'cash' && form.accountId == null && setup?.memoryId != null && chosen === setup.defaults[how]

  return (
    <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.buy.paidNow')} data-testid="buy-paid-now">
      <h2 className="mb-3 text-subtitle font-semibold text-ink">{t('simple.buy.paidNow')}</h2>
      <div role="radiogroup" aria-label={t('simple.buy.paidNow')} className="flex flex-wrap gap-2">
        {BUY_PAID_CHOICES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={form.paid === value}
            data-testid={`buy-paid-${value}`}
            onClick={() => onChange({ paid: value, accountId: null })}
            className={`rounded-md border px-3 py-1.5 text-detail transition-colors ${
              form.paid === value ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
            }`}
          >
            {lbl(PAID_TEXT[value])}
          </button>
        ))}
      </div>
      {form.paid === 'credit' && <p className="mt-2 text-small text-muted" data-testid="buy-not-yet-hint">{t('simple.buy.notYetHint')}</p>}

      {form.paid === 'part' && (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
          <Field label={t('simple.buy.partAmount')}>
            <AmountInput paise={form.partAmount} onPaise={(p) => onChange({ partAmount: p })} testId="input-buy-part-amount" />
          </Field>
          <div>
            <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{t('simple.buy.partHow')}</span>
            <div role="radiogroup" aria-label={t('simple.buy.partHow')} className="flex flex-wrap gap-2">
              {BUY_PART_HOWS.map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={form.partHow === h}
                  data-testid={`buy-part-how-${h}`}
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
            <Field label={t('simple.buy.paidFrom')} hint={fromMemory ? t('simple.buy.fromMemory') : undefined}>
              <Select value={chosen ?? ''} onChange={(e) => onChange({ accountId: Number(e.target.value) })} data-testid="select-buy-account">
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="text-small text-muted" data-testid="buy-no-account">{t('simple.buy.noAccount')}</p>
          )}
        </div>
      )}
      <FieldError name="payment" error={error} />
    </section>
  )
}
