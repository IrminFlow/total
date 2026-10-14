import { useMemo } from 'react'
import type { Unit } from '@shared/domain'
import { formatPaise } from '@shared/money'
import { buyLineGstRate, type BuyContext, type BuyForm, type BuyGst, type BuyLine } from '@shared/simple/buy'
import { useT } from '../../lib/i18n'
import { AmountInput, FieldError, TextInput } from '../../components/ui'
import { TypeAhead, useStockItems } from '../../components/pickers'

/**
 * WP 9.3 — the products on a supplier's bill: product (picker with "Create …" → the plain New
 * product dialog), quantity, price as printed (with or before GST, as the form says), an optional
 * discount, and the line's value from the editor's calculation (`amounts`, from buyTotals). The
 * GST chip shows the product's rate when the bill's GST is claimed, or when it is added to the
 * cost (a business that can't claim it).
 */
export function BuyLines({
  form,
  ctx,
  gst,
  amounts,
  units,
  showDiscount,
  error,
  onChange,
  onAdd,
  onCreate
}: {
  form: BuyForm
  ctx: BuyContext
  gst: BuyGst
  amounts: (number | null)[]
  units: Unit[]
  showDiscount: boolean
  error: string | null
  onChange: (lines: BuyLine[]) => void
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
  const set = (key: number, patch: Partial<BuyLine>): void => onChange(form.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const basis = gst === 'none' ? null : form.ratesIncludeGst
  const priceLabel = basis == null ? t('simple.buy.price') : basis ? t('simple.buy.priceIncl') : t('simple.buy.priceExcl')
  const cols = showDiscount ? 'md:grid-cols-[minmax(0,3fr)_6rem_8rem_7rem_8rem_2rem]' : 'md:grid-cols-[minmax(0,3fr)_6rem_8rem_8rem_2rem]'

  return (
    <div data-testid="buy-lines">
      <div className={`hidden gap-2 px-1 pb-1 text-caption font-semibold tracking-[0.08em] text-muted uppercase md:grid ${cols}`}>
        <span>{t('simple.buy.product')}</span>
        <span>{t('simple.buy.qty')}</span>
        <span className="text-right">{priceLabel}</span>
        {showDiscount && <span className="text-right">{t('simple.buy.discount')}</span>}
        <span className="text-right">{gst === 'claim' ? t('simple.buy.lineAmountExcl') : t('simple.buy.lineAmount')}</span>
        <span />
      </div>
      <ul className="flex flex-col gap-2">
        {form.lines.map((l, i) => {
          const rate = l.itemId != null ? buyLineGstRate(l.itemId, form, ctx) : null
          const amount = amounts[i]
          return (
            <li key={l.key} className={`grid grid-cols-1 items-start gap-2 ${cols}`} data-testid={`buy-line-${i}`}>
              <div className="min-w-0">
                <TypeAhead
                  options={options}
                  value={l.itemId}
                  onPick={(id) => set(l.key, { itemId: id })}
                  placeholder={t('simple.buy.productPlaceholder')}
                  onCreate={(name) => onCreate(name, l.key)}
                  testId={`picker-buy-item-${i}`}
                  ariaLabel={t('simple.buy.product')}
                />
                {rate != null && l.itemId != null && (
                  <span className="mt-0.5 inline-block rounded-full border border-line px-2 text-caption text-muted" data-testid={`buy-line-gst-${i}`}>
                    {gst === 'fold' ? t('simple.buy.gstIntoCostChip', { rate }) : t('simple.buy.gstChip', { rate })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <TextInput
                  value={l.qtyText}
                  onChange={(e) => set(l.key, { qtyText: e.target.value })}
                  inputMode="decimal"
                  className="num text-right"
                  aria-label={t('simple.buy.qty')}
                  data-testid={`input-buy-qty-${i}`}
                />
                <span className="w-8 shrink-0 text-small text-muted">{unitOf(l.itemId)}</span>
              </div>
              <AmountInput paise={l.rate} onPaise={(p) => set(l.key, { rate: p })} testId={`input-buy-rate-${i}`} ariaLabel={priceLabel} />
              {showDiscount && (
                <AmountInput paise={l.discount} onPaise={(p) => set(l.key, { discount: p })} testId={`input-buy-discount-${i}`} ariaLabel={t('simple.buy.discount')} />
              )}
              <span className="num py-1.5 text-right text-body text-ink" data-testid={`buy-line-amount-${i}`} data-paise={amount ?? 0}>
                {amount != null ? formatPaise(amount, { symbol: true }) : ''}
              </span>
              <button
                type="button"
                className="py-1.5 text-muted hover:text-danger"
                aria-label={t('simple.buy.removeLine')}
                title={t('simple.buy.removeLine')}
                data-testid={`btn-buy-remove-${i}`}
                onClick={() => onChange(form.lines.filter((x) => x.key !== l.key))}
              >
                {'×'}
              </button>
            </li>
          )
        })}
      </ul>
      <FieldError name="items" error={error} />
      <button type="button" className="mt-2 text-detail text-blue hover:underline" data-testid="btn-buy-add-line" onClick={onAdd}>
        {t('simple.buy.addLine')}
      </button>
    </div>
  )
}
