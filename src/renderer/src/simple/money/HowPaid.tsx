import type { MessageKey } from '@shared/i18n'
import type { MoneyHow } from '@shared/simple/intents'
import { MONEY_HOWS, type MoneySetup } from '@shared/simple/money'
import { useT } from '../../lib/i18n'
import { Field, FieldError, Select, TextInput } from '../../components/ui'

const HOW_TEXT: Record<MoneyHow, MessageKey> = {
  cash: 'simple.money.how.cash',
  upi: 'simple.money.how.upi',
  bank: 'simple.money.how.bank',
  card: 'simple.money.how.card'
}

/**
 * WP 9.4 — "Received into" / "Paid from": Cash, UPI, Bank transfer or Card, then which account
 * (the default per way comes from simple:money:setup — the WP 5.6 memory, else the counter's
 * accounts / first bank) and an optional cheque / UPI reference.
 */
export function HowPaid({
  side,
  how,
  accountId,
  reference,
  setup,
  error,
  onChange
}: {
  side: 'in' | 'out'
  how: MoneyHow
  accountId: number | null
  reference: string
  setup: MoneySetup | null
  error: string | null
  onChange: (patch: { how?: MoneyHow; accountId?: number | null; reference?: string }) => void
}): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed table above
  const field = side === 'in' ? 'into' : 'from' // i18n-technical: form field paths
  const title = side === 'in' ? t('simple.money.into') : t('simple.money.from')
  const defaults = side === 'in' ? setup?.defaultsIn : setup?.defaultsOut
  const memoryId = side === 'in' ? setup?.memoryIn : setup?.memoryOut
  const accounts = (setup?.moneyAccounts ?? []).filter((a) => (how === 'cash' ? a.kind === 'cash' : a.kind === 'bank'))
  const chosen = accountId ?? defaults?.[how] ?? null
  const fromMemory = how !== 'cash' && accountId == null && memoryId != null && chosen === defaults?.[how]
  return (
    <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={title} data-testid={`money-how-${side}`}>
      <h2 className="mb-3 text-subtitle font-semibold text-ink">{title}</h2>
      <div role="radiogroup" aria-label={title} className="flex flex-wrap gap-2">
        {MONEY_HOWS.map((h) => (
          <button
            key={h}
            type="button"
            role="radio"
            aria-checked={how === h}
            data-testid={`money-how-${h}`}
            onClick={() => onChange({ how: h, accountId: null })}
            className={`rounded-md border px-3 py-1.5 text-detail transition-colors ${
              how === h ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
            }`}
          >
            {lbl(HOW_TEXT[h])}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        {accounts.length > 0 ? (
          <Field label={t('simple.money.account')} hint={fromMemory ? t('simple.money.fromMemory') : undefined}>
            <Select value={chosen ?? ''} onChange={(e) => onChange({ accountId: Number(e.target.value) })} data-testid="select-money-account">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="self-end text-small text-muted" data-testid="money-no-account">{t('simple.money.noAccount')}</p>
        )}
        {how !== 'cash' && (
          <Field label={t('simple.money.reference')}>
            <TextInput value={reference} placeholder={t('simple.money.referencePlaceholder')} onChange={(e) => onChange({ reference: e.target.value })} data-testid="input-money-reference" />
          </Field>
        )}
      </div>
      <FieldError name={field} error={error} />
    </section>
  )
}
