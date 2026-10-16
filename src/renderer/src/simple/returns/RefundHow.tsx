import type { MessageKey } from '@shared/i18n'
import { MONEY_HOW, type MoneyHow } from '@shared/simple/intents'
import type { ReturnForm, ReturnSide } from '@shared/simple/returns'
import type { SellSetup } from '@shared/simple/sell'
import { useT } from '../../lib/i18n'
import { useCanSave } from '../ViewerNote'
import { Button, Field, FieldError, Select } from '../../components/ui'

const HOW_TEXT: Record<MoneyHow, MessageKey> = {
  cash: 'simple.sell.paid.cash',
  upi: 'simple.sell.paid.upi',
  card: 'simple.sell.paid.card',
  bank: 'simple.sell.paid.bank'
}
const REFUND = 'refund' as const // i18n-technical
const CREDIT = 'credit' as const // i18n-technical

const chipCls = (on: boolean): string =>
  `rounded-md border px-3 py-1.5 text-detail transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    on ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
  }`

/**
 * WP 9.5 — "Give the money back, or keep it for the next bill?": asked only for the part of a
 * return that does not simply come off the bill (what was still due on it). Money back = Cash /
 * UPI / Card / Bank transfer from (sale) or into (purchase) a cash / bank account — defaulted as
 * the Sell screens default it — with "Add a bank account" so a new business is never stuck; kept =
 * the customer's credit (or what the supplier owes you back). A walk-in customer always gets the
 * money back.
 */
export function RefundHow({
  side,
  form,
  setup,
  walkIn,
  error,
  onChange,
  onAddBank
}: {
  side: ReturnSide
  form: ReturnForm
  setup: SellSetup | null
  walkIn: boolean
  error: string | null
  onChange: (patch: Partial<ReturnForm>) => void
  onAddBank: () => void
}): React.JSX.Element {
  const t = useT()
  // A viewer can't add accounts (main refuses it): no button that only says "not allowed".
  const mayAdd = useCanSave()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed table above
  const sale = side === 'sale' // i18n-technical
  const accounts = (setup?.moneyAccounts ?? []).filter((a) => (form.how === 'cash' ? a.kind === 'cash' : a.kind === 'bank'))
  const chosen = form.accountId ?? setup?.defaults[form.how] ?? null

  return (
    <div data-testid="return-settle">
      <h3 className="mb-2 text-body font-semibold text-ink">{sale ? t('simple.returns.refundOrCredit') : t('simple.returns.refundOrCreditBuy')}</h3>
      <div role="radiogroup" aria-label={sale ? t('simple.returns.refundOrCredit') : t('simple.returns.refundOrCreditBuy')} className="flex flex-wrap gap-2">
        <button type="button" role="radio" aria-checked={form.settle === REFUND} data-testid="return-settle-refund" className={chipCls(form.settle === REFUND)} onClick={() => onChange({ settle: REFUND })}>
          {sale ? t('simple.returns.refund') : t('simple.returns.refundBuy')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={form.settle === CREDIT}
          disabled={walkIn}
          data-testid="return-settle-credit"
          className={chipCls(form.settle === CREDIT)}
          onClick={() => onChange({ settle: CREDIT })}
        >
          {sale ? t('simple.returns.keepCredit') : t('simple.returns.keepCreditBuy')}
        </button>
      </div>
      {walkIn && <p className="mt-2 text-small text-muted" data-testid="return-walk-in-hint">{t('simple.returns.walkInRefund')}</p>}

      {form.settle === REFUND && (
        <div className="mt-3 flex flex-col gap-3">
          <div role="radiogroup" aria-label={sale ? t('simple.returns.paidBackHow') : t('simple.returns.cameBackHow')} className="flex flex-wrap gap-2">
            {MONEY_HOW.map((h) => (
              <button key={h} type="button" role="radio" aria-checked={form.how === h} data-testid={`return-how-${h}`} className={chipCls(form.how === h)} onClick={() => onChange({ how: h, accountId: null })}>
                {lbl(HOW_TEXT[h])}
              </button>
            ))}
          </div>
          <div className="max-w-sm">
            {accounts.length > 0 ? (
              <Field label={sale ? t('simple.returns.paidFrom') : t('simple.returns.cameInto')}>
                <Select value={chosen ?? ''} onChange={(e) => onChange({ accountId: Number(e.target.value) })} data-testid="select-return-account">
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              // A business set up with the wizard has no bank yet: add it right here (never a dead end).
              <div className="flex flex-wrap items-center gap-3" data-testid="return-no-account">
                <p className="text-small text-ink">{t('simple.returns.noAccount')}</p>
                {mayAdd && (
                  <Button data-testid="btn-return-add-bank" onClick={onAddBank}>
                    {t('simple.sell.addBank')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <FieldError name="refund" error={error} />
    </div>
  )
}
