import { useMemo } from 'react'
import type { Unit } from '@shared/domain'
import { formatPaise } from '@shared/money'
import { lineGstRate, lineRateMissing, type SellContext, type SellForm, type SellLine } from '@shared/simple/sell'
import { useT } from '../../lib/i18n'
import { AmountInput, FieldError, TextInput } from '../../components/ui'
import { TypeAhead, useStockItems } from '../../components/pickers'

/** A form line (`auto`: its price still comes from the price list). */
export type FormLine = SellLine

/**
 * WP 9.2 — the products on a bill: product (picker with "Create …" → the plain New product
 * dialog), quantity, price (with or before GST, as the form says), an optional discount, and the
 * line's value from the editor's calculation (`amounts`, computed by sellTotals). The GST rate is
 * the product's, shown as a chip only when the bill charges GST.
 */
export function BillLines({
  lines,
  form,
  ctx,
  amounts,
  units,
  showDiscount,
  charges,
  error,
  onChange,
  onAdd,
  onCreate
}: {
  lines: FormLine[]
  form: SellForm
  ctx: SellContext
  amounts: (number | null)[]
  units: Unit[]
  showDiscount: boolean
  charges: boolean
  error: string | null
  onChange: (lines: FormLine[]) => void
  onAdd: () => void
  onCreate: (name: string, lineKey: number) => void
}): React.JSX.Element {
  const t = useT()
  const items = useStockItems()
  const options = useMemo(() => items.map((i) => ({ id: i.id, label: i.name, barcode: i.barcode })), [items])
  const unitOf = (itemId: number | null): string => {
    const it = items.find((i) => i.id === itemId)
    return units.find((u) => u.id === it?.unitId)?.symbol ?? ''
  }
  const set = (key: number, patch: Partial<FormLine>): void => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const priceLabel = charges ? (form.ratesIncludeGst ? t('simple.sell.priceIncl') : t('simple.sell.priceExcl')) : t('simple.sell.price')
  const cols = showDiscount ? 'md:grid-cols-[minmax(0,3fr)_6rem_8rem_7rem_8rem_2rem]' : 'md:grid-cols-[minmax(0,3fr)_6rem_8rem_8rem_2rem]'

  return (
    <div data-testid="sell-lines">
      <div className={`hidden gap-2 px-1 pb-1 text-caption font-semibold tracking-[0.08em] text-muted uppercase md:grid ${cols}`}>
        <span>{t('simple.sell.product')}</span>
        <span>{t('simple.sell.qty')}</span>
        <span className="text-right">{priceLabel}</span>
        {showDiscount && <span className="text-right">{t('simple.sell.discount')}</span>}
        <span className="text-right">{t('simple.sell.lineAmount')}</span>
        <span />
      </div>
      <ul className="flex flex-col gap-2">
        {lines.map((l, i) => {
          const rate = l.itemId != null ? lineGstRate(l.itemId, form, ctx) : null
          const amount = amounts[i]
          return (
            <li key={l.key} className={`grid grid-cols-1 items-start gap-2 ${cols}`} data-testid={`sell-line-${i}`}>
              <div className="min-w-0">
                <TypeAhead
                  options={options}
                  value={l.itemId}
                  onPick={(id) => set(l.key, { itemId: id, rate: null, auto: true })}
                  placeholder={t('simple.sell.productPlaceholder')}
                  onCreate={(name) => onCreate(name, l.key)}
                  testId={`picker-sell-item-${i}`}
                  ariaLabel={t('simple.sell.product')}
                />
                {l.itemId != null && lineRateMissing(l.itemId, form, ctx) ? (
                  <p role="status" className="mt-0.5 text-caption text-warning" data-testid={`sell-line-no-rate-${i}`}>
                    {t('simple.sell.noRate')}
                  </p>
                ) : rate != null && l.itemId != null && (
                  <span className="mt-0.5 inline-block rounded-full border border-line px-2 text-caption text-muted" data-testid={`sell-line-gst-${i}`}>
                    {t('simple.sell.gstChip', { rate })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <TextInput
                  value={l.qtyText}
                  onChange={(e) => set(l.key, { qtyText: e.target.value })}
                  inputMode="decimal"
                  className="num text-right"
                  aria-label={t('simple.sell.qty')}
                  data-testid={`input-sell-qty-${i}`}
                />
                <span className="w-8 shrink-0 text-small text-muted">{unitOf(l.itemId)}</span>
              </div>
              <AmountInput paise={l.rate} onPaise={(p) => set(l.key, { rate: p, auto: false })} testId={`input-sell-rate-${i}`} ariaLabel={priceLabel} />
              {showDiscount && (
                <AmountInput paise={l.discount} onPaise={(p) => set(l.key, { discount: p })} testId={`input-sell-discount-${i}`} ariaLabel={t('simple.sell.discount')} />
              )}
              <span className="num py-1.5 text-right text-body text-ink" data-testid={`sell-line-amount-${i}`} data-paise={amount ?? 0}>
                {amount != null ? formatPaise(amount, { symbol: true }) : ''}
              </span>
              <button
                type="button"
                className="py-1.5 text-muted hover:text-danger"
                aria-label={t('simple.sell.removeLine')}
                title={t('simple.sell.removeLine')}
                data-testid={`btn-sell-remove-${i}`}
                onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
              >
                {'×'}
              </button>
            </li>
          )
        })}
      </ul>
      <FieldError name="items" error={error} />
      <button type="button" className="mt-2 text-detail text-blue hover:underline" data-testid="btn-sell-add-line" onClick={onAdd}>
        {t('simple.sell.addLine')}
      </button>
    </div>
  )
}
